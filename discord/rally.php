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
 * changed it; the rally itself is read when the message is sent. A clear keeps $previousSystemID, the system the rally
 * was on (fork_rally loses it with the row), so the cleared message can name it. Null when the change is from before
 * the type was turned on (a clock step; the type is checked when the change is made, so this is belt and braces).
 */
function discord_rally_data(array $type, $maskName, $action, $who, $now = null, $previousSystemID = 0) {
    $now = $now ?? time();
    if (!empty($type['enabledAt']) && $now < (int) $type['enabledAt']) return null;
    $data = [
        'kind' => 'rally', 'action' => $action === 'clear' ? 'clear' : 'set', 'who' => (string) $who,
        'template' => $type['template'], 'templateClear' => $type['templateClear'], 'ping' => $type['ping'],
        'mask' => (string) $maskName, 'time' => (int) $now,
    ];
    if ($data['action'] === 'clear' && (int) $previousSystemID > 0) $data['systemID'] = (int) $previousSystemID;
    return $data;
}

/** Queue a rally change of a mask (public/rally.php). Returns the outbox id or null. */
function discord_rally_enqueue(PDO $db, $maskID, array $type, $action, $who, $previousSystemID = 0) {
    $data = discord_rally_data($type, discord_mask_name($db, $maskID), $action, $who, null, $previousSystemID);
    if ($data === null) return null;
    // A clear: the label of the system it was on as it is now (the hole may be gone by the time the message is sent)
    if (isset($data['systemID'])) $data['label'] = discord_chain_label($db, $maskID, $data['systemID']);
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
 * The chain label of a system in a mask's chain, as the chain map shows it (app/js/chain-map.js, sigNameLocation):
 * the trimmed name of the wormhole signature *leading into* the system, i.e. the signature on the far side of the
 * wormhole, in the neighbouring system (chain-map.js: node.child.name = the parent system's signature's name).
 * '' when there is none (home, k-space without a named hole, no wormhole, or the lookup fails).
 *
 * The chain map picks the inbound hole by walking out from the active chain tab's home system(s), which are each
 * user's own option, so the server can't repeat that walk. It uses the rule the Add Signature dialog uses without a
 * home tab (holeNaming.incomingFromWormholes, app/js/fork/hole-naming.js): a wormhole of the mask touching the system
 * leads into it when its far-side signature has a name starting with a letter or digit (its leading token, so not a
 * return bookmark) and its near-side signature (in the system) has none or is a
 * return bookmark ("<C"); a named near side is a hole out of the system. With several (a system reached more than
 * once, loops) the one closest to home wins: the shortest leading name token ("AB" before "ABC"), then the lowest
 * wormhole id. One query (both directions of the wormhole, UNION ALL), prepared.
 */
function discord_chain_label(PDO $db, $maskID, $systemID) {
    $systemID = (int) $systemID;
    if ($systemID <= 0) return '';
    $side = "SELECT w.id AS wormholeID, n.name AS nearName, f.name AS farName, f.systemID AS farSystem
        FROM signatures n INNER JOIN wormholes w ON w.%s = n.id AND w.maskID = n.maskID INNER JOIN signatures f ON f.id = w.%s
        WHERE n.systemID = ? AND n.maskID = ? AND n.type = 'wormhole'";
    try {
        $stmt = $db->prepare(sprintf($side, 'initialID', 'secondaryID') . ' UNION ALL ' . sprintf($side, 'secondaryID', 'initialID'));
        if (!$stmt || !$stmt->execute([$systemID, (string) $maskID, $systemID, (string) $maskID])) return '';
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        return '';   // e.g. no such tables (tests, a fresh database)
    }
    return discord_chain_label_pick($rows, $systemID);
}

/** The label from discord_chain_label's rows (wormholeID, nearName, farName, farSystem): see there for the rule */
function discord_chain_label_pick(array $rows, $systemID) {
    $best = null;
    foreach ($rows as $row) {
        if ((int) $row['farSystem'] === (int) $systemID) continue;
        $far = discord_chain_label_clean($row['farName']);
        if ($far === '') continue;
        $near = discord_chain_label_clean($row['nearName']);
        if ($near !== '' && $near[0] !== '<') continue;   // a hole out of the system
        if (!preg_match('/^[A-Za-z0-9]+/', $far, $m)) continue;   // no name token (e.g. a return bookmark "<C"), as holeNaming
        $rank = [strlen($m[0]), (int) $row['wormholeID']];
        if ($best === null || $rank < $best[0]) $best = [$rank, $far];
    }
    return $best ? $best[1] : '';
}

/** A signature name as a label: one line, trimmed, at most 100 characters (the column's size). Escaped when rendered. */
function discord_chain_label_clean($name) {
    $name = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string) $name) ?? '');
    return mb_substr($name, 0, 100);
}

/**
 * Message context of a rally row. $rally: the rally as stored now (discord_rally_current); false = unknown, then the
 * change itself is shown (a clear as cleared; a set without the system can't be shown, null). $labelOf(systemID):
 * the system's chain label (discord_chain_label), looked up only for the system shown; null = no labels.
 * A clear names the system the rally was on when the row kept it (discord_rally_data).
 */
function discord_rally_context(array $data, $rally, ?callable $labelOf = null) {
    $base = ['kind' => 'rally', 'template' => discord_template_upgrade('rally', 'template', $data['template'] ?? ''),
        'templateClear' => discord_template_upgrade('rally', 'templateClear', $data['templateClear'] ?? ''),
        'ping' => $data['ping'] ?? '', 'mask' => $data['mask'] ?? '', 'time' => (int) ($data['time'] ?? time())];
    if ($rally === false) {
        if (($data['action'] ?? '') !== 'clear') return null;
        $rally = null;
    }
    if ($rally === null) {
        // Only name the one who cleared it (and where it was) when this change was the clear (someone else's clear is
        // their own message)
        $clear = ($data['action'] ?? '') === 'clear';
        $who = $clear && ($data['who'] ?? '') !== '' ? $data['who'] : 'someone';
        // The label as it was when cleared (discord_rally_enqueue), else looked up now
        $known = array_key_exists('label', $data) ? function () use ($data) { return (string) $data['label']; } : $labelOf;
        $was = $clear && (int) ($data['systemID'] ?? 0) > 0 ? discord_rally_system((int) $data['systemID'], $known) : [];
        return $base + ['cleared' => true, 'who' => $who] + $was;
    }
    return $base + ['cleared' => false, 'who' => ($rally['setBy'] ?? '') !== '' ? $rally['setBy'] : 'someone']
        + discord_rally_system((int) $rally['systemID'], $labelOf);
}

/** The system fields of a rally message context */
function discord_rally_system($systemID, ?callable $labelOf = null) {
    $system = discord_system($systemID);
    return [
        'systemID' => $systemID, 'system' => $system ? $system[0] : (string) $systemID,
        'security' => $system && !$system[4] ? $system[1] : null, 'class' => discord_system_class($systemID),
        'region' => $system ? discord_region_name($system[2]) : '',
        'map' => discord_map_url($systemID), 'dotlan' => discord_dotlan_url($systemID),
        'label' => $labelOf ? (string) $labelOf($systemID) : '',
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

/** A webhook's URL was replaced (public/discord.php): its last rally messages belong to the old URL, don't edit them */
function discord_rally_forget_webhook(PDO $db, $webhookID) {
    $db->prepare('DELETE FROM discord_rally WHERE webhookID = ?')->execute([(int) $webhookID]);
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
