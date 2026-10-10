<?php
// Fork-owned: notification type 5, "rally point" (see discord/discord.inc.php).
//
// public/rally.php queues a message when someone sets, moves or clears the chain map's rally point (and wants it
// posted, options.rallyDiscord). The sender (discord_dispatch) then:
//   - renders the rally as it is stored *when the message is sent* (fork_rally), not the change that queued it, so
//     the last message always shows the final rally even when changes race;
//   - skips a queued rally message when a newer one of the same mask is queued (the newer one shows the same rally);
//   - edits the mask's last rally message (PATCH .../messages/<id>) instead of posting a new one while it is less
//     than DISCORD_RALLY_WINDOW seconds old and went to the same webhook: at most one new message per mask per window.
//     A deleted message (404 Unknown Message) is forgotten and the change is posted as a new message.
// Everything else (rate limits, retries, broken webhooks, circuit breakers, delivery status) is the outbox's.
//
// Masks without the type configured keep the first version's behaviour (rally_discord.inc.php): upstream's
// server-wide DISCORD_WEB_HOOK webhook of the mask, posted directly by public/rally.php.

const DISCORD_RALLY_WINDOW   = 30;   // seconds: changes within it edit the last message
const DISCORD_PRIORITY_RALLY = 20;   // before kills and k-space (a rally is about now), after test messages

/** The mask's rally type when it is turned on with a webhook, else null. $settings: normalised settings. */
function discord_rally_type(array $settings) {
    $type = $settings['types']['rally'] ?? null;
    return $type && $type['enabled'] && $type['webhookID'] > 0 ? $type : null;
}

/**
 * The rally type of a mask that may send Discord notifications (discord_mask_sending_corporation), or null: no
 * settings, the type is off, or the mask doesn't qualify (any more). Reads only the settings row when there is nothing
 * to send (public/rally.php asks on every poll).
 */
function discord_rally_target(PDO $db, $maskID) {
    $stmt = $db->prepare('SELECT settings FROM discord_settings WHERE maskID = ?');
    $stmt->execute([(string) $maskID]);
    $json = $stmt->fetchColumn();
    if ($json === false || $json === null) return null;
    $settings = discord_settings_normalise(json_decode($json, true), discord_settings_defaults())[0];
    $type = discord_rally_type($settings);
    if (!$type || !discord_mask_sending_corporation($db, $maskID)) return null;
    return $type;
}

/**
 * Outbox data of a rally change. $action 'set' or 'clear' (only used to name who cleared it), $who the character that
 * changed it; the rally itself is read when the message is sent. Null when the change is from before the type was
 * turned on (a clock step; the type is checked when the change is made, so this is belt and braces).
 */
function discord_rally_data(array $type, $maskName, $action, $who, $now = null) {
    $now = $now ?? time();
    if (!empty($type['enabledAt']) && $now < (int) $type['enabledAt']) return null;
    return [
        'kind' => 'rally', 'action' => $action === 'clear' ? 'clear' : 'set', 'who' => (string) $who,
        'template' => $type['template'], 'templateClear' => $type['templateClear'], 'ping' => $type['ping'],
        'mask' => (string) $maskName, 'time' => (int) $now,
    ];
}

/** Queue a rally change of a mask (public/rally.php). Returns the outbox id or null. */
function discord_rally_enqueue(PDO $db, $maskID, array $type, $action, $who) {
    $data = discord_rally_data($type, discord_mask_name($db, $maskID), $action, $who);
    if ($data === null) return null;
    return discord_enqueue($db, (string) $maskID, $type['webhookID'], 'rally', $data, DISCORD_PRIORITY_RALLY);
}

/** The mask's rally as stored now: ['systemID', 'setBy'], null when there is none, false when it can't be read */
function discord_rally_current(PDO $db, $maskID) {
    try {
        $stmt = $db->prepare('SELECT systemID, setBy FROM fork_rally WHERE maskID = ?');
        if (!$stmt || !$stmt->execute([(string) $maskID])) return false;
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        return false;   // no fork_rally table yet
    }
    return $row ? ['systemID' => (int) $row['systemID'], 'setBy' => $row['setBy']] : null;
}

/**
 * Message context of a rally row. $rally: the rally as stored now (discord_rally_current); false = unknown, then the
 * change itself is shown (a clear as cleared; a set without the system can't be shown, null).
 */
function discord_rally_context(array $data, $rally) {
    $base = ['kind' => 'rally', 'template' => $data['template'] ?? '', 'templateClear' => $data['templateClear'] ?? '',
        'ping' => $data['ping'] ?? '', 'mask' => $data['mask'] ?? '', 'time' => (int) ($data['time'] ?? time())];
    if ($rally === false) {
        if (($data['action'] ?? '') !== 'clear') return null;
        $rally = null;
    }
    if ($rally === null) {
        // Only name the one who cleared it when this change was the clear (someone else's clear is their own message)
        $who = ($data['action'] ?? '') === 'clear' && ($data['who'] ?? '') !== '' ? $data['who'] : 'someone';
        return $base + ['cleared' => true, 'who' => $who];
    }
    $systemID = (int) $rally['systemID'];
    $system = discord_system($systemID);
    return $base + [
        'cleared' => false, 'who' => ($rally['setBy'] ?? '') !== '' ? $rally['setBy'] : 'someone',
        'systemID' => $systemID, 'system' => $system ? $system[0] : (string) $systemID,
        'security' => $system && !$system[4] ? $system[1] : null, 'class' => discord_system_class($systemID),
        'region' => $system ? discord_region_name($system[2]) : '',
        'map' => discord_map_url($systemID), 'dotlan' => discord_dotlan_url($systemID),
    ];
}

/** Whether a newer rally message of the same mask is queued (then this one is skipped: the newer one shows the same) */
function discord_rally_superseded(PDO $db, array $row) {
    $stmt = $db->prepare("SELECT COUNT(*) FROM discord_outbox WHERE maskID = ? AND kind = 'rally' AND status = 'queued' AND id > ?");
    $stmt->execute([(string) $row['maskID'], (int) $row['id']]);
    return (int) $stmt->fetchColumn() > 0;
}

/** The mask's last rally message: ['webhookID', 'messageID', 'postedAt' (unix)] or null */
function discord_rally_last(PDO $db, $maskID) {
    $stmt = $db->prepare('SELECT webhookID, messageID, postedAt FROM discord_rally WHERE maskID = ?');
    $stmt->execute([(string) $maskID]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    return ['webhookID' => (int) $row['webhookID'], 'messageID' => (string) $row['messageID'], 'postedAt' => (int) strtotime($row['postedAt'] . ' UTC')];
}

/** 'edit' the last message (to the same webhook, younger than the window, with an id) or 'post' a new one */
function discord_rally_decision($last, $webhookID, $now = null, $window = DISCORD_RALLY_WINDOW) {
    $now = $now ?? time();
    if (!$last || (int) $last['webhookID'] !== (int) $webhookID || !preg_match('/^\d{1,32}$/', (string) $last['messageID'])) return 'post';
    $age = $now - (int) $last['postedAt'];
    return $age >= 0 && $age < $window ? 'edit' : 'post';
}

function discord_rally_remember(PDO $db, $maskID, $webhookID, $messageID, $now = null) {
    discord_rally_forget($db, $maskID);
    $db->prepare('INSERT INTO discord_rally (maskID, webhookID, messageID, postedAt) VALUES (?, ?, ?, ?)')
        ->execute([(string) $maskID, (int) $webhookID, (string) $messageID, gmdate('Y-m-d H:i:s', $now ?? time())]);
}

function discord_rally_forget(PDO $db, $maskID) {
    $db->prepare('DELETE FROM discord_rally WHERE maskID = ?')->execute([(string) $maskID]);
}

/**
 * How the sender sends a rally row: ['method' => 'POST'|'PATCH', 'url' => ..., 'payload' => ...]. $url: the webhook's
 * URL, $payload: discord_payload() of the row. An edit leaves out 'username' (a message keeps its author).
 */
function discord_rally_request(PDO $db, array $row, $url, array $payload, $now = null) {
    $last = discord_rally_last($db, $row['maskID']);
    if (discord_rally_decision($last, $row['webhookID'], $now) === 'edit') {
        unset($payload['username']);
        return ['method' => 'PATCH', 'url' => discord_webhook_edit_url($url, $last['messageID']), 'payload' => $payload];
    }
    return ['method' => 'POST', 'url' => discord_webhook_send_url($url), 'payload' => $payload];
}

/** Discord's error code from an error body ({"message": "...", "code": 10008}), or 0 */
function discord_error_code($body) {
    $data = json_decode((string) $body, true);
    return is_array($data) && isset($data['code']) && is_numeric($data['code']) ? (int) $data['code'] : 0;
}

/**
 * After a rally request: remember a new message (its id comes back with ?wait=true), and turn an edit of a deleted
 * message (404, code 10008 Unknown Message: the webhook itself is fine) into 'repost': the row is sent again as a new
 * message right away. Every other outcome is the outbox's usual one. Returns the (possibly changed) decision.
 */
function discord_rally_after_send(PDO $db, array $row, $method, $status, $body, array $decision, $now = null) {
    if ($method === 'PATCH' && $status === 404 && discord_error_code($body) === 10008) {
        discord_rally_forget($db, $row['maskID']);
        return ['result' => 'repost', 'delay' => 0, 'error' => 'the last rally message was deleted in Discord; posting a new one'];
    }
    if ($decision['result'] === 'sent' && $method === 'POST') {
        $message = json_decode((string) $body, true);
        $id = is_array($message) && isset($message['id']) ? (string) $message['id'] : '';
        if (preg_match('/^\d{1,32}$/', $id)) discord_rally_remember($db, $row['maskID'], $row['webhookID'], $id, $now);
        else discord_rally_forget($db, $row['maskID']);
    }
    return $decision;
}

/** Upstream's server-wide webhook of a mask (DISCORD_WEB_HOOK, as ping.inc.php reads it), or null */
function discord_rally_legacy_hook($maskID, $map = null) {
    if ($map === null) $map = defined('DISCORD_WEB_HOOK') ? DISCORD_WEB_HOOK : null;
    if (!is_array($map)) return null;
    $hook = $map[(string) $maskID] ?? null;
    return is_string($hook) && $hook !== '' ? $hook : null;
}
