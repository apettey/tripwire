<?php
// Fork-owned: notification type 5, "rally point", shown to users as "Fight here" since the fleet comps (see
// discord/discord.inc.php, fight/fight.inc.php). Internal names (type key 'rally', tables) stay. The fleet comp stored
// with the fight point is in the message ({comp}, {compNote}, {withComp}) and its mention is pinged with the type's.
//
// public/rally.php queues a message when someone sets, moves or clears the chain map's rally point (and wants it
// posted, options.rallyDiscord). The sender (discord_dispatch) then:
//   - renders the rally as it is stored *when the message is sent* (fork_rally), not the change that queued it, so
//     the last message always shows the final rally even when changes race;
//   - skips a queued rally message when a newer one of the same mask is queued (the newer one shows the same rally);
//   - keeps the mask's live rally message (discord_rally_message: its id and its text as last posted) and
//       * set / moved less than DISCORD_RALLY_WINDOW seconds after it was posted: edits it (PATCH .../messages/<id>);
//       * moved later: posts a new message (with the pings, so people notice) and then edits the old one into its text
//         struck through + "Moved to ..." (a queued 'rallyEdit' row);
//       * cleared, at any time: edits it into its text struck through + the cleared text. No new message, no ping.
//         Without a live message (never posted, deleted in Discord, another webhook, the type turned off and on since)
//         a clear sends nothing;
//     every edit has empty allowed_mentions, and an edit that ends a message (cleared / moved) has no pings in its
//     text either (discord_payload; a live edit within the window keeps the post's text, pings included, which
//     Discord doesn't notify again). A live message deleted in
//     Discord (404 Unknown Message) is forgotten: a set / move is then posted as a new message, a clear sends nothing.
// Everything else (rate limits, retries, broken webhooks, circuit breakers, delivery status) is the outbox's.
//
// Masks without the type configured keep the first version's behaviour (rally_discord.inc.php): upstream's
// server-wide DISCORD_WEB_HOOK webhook of the mask, posted directly by public/rally.php (same rules, fixed texts).

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
        'mask' => (string) $maskName, 'time' => (int) $now, 'enabledAt' => (int) ($type['enabledAt'] ?? 0),
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

/** The mask's rally (fight point) as stored now: ['systemID', 'setBy', 'comp' (null or the fleet comp stored with it,
    fight_rally_read)], null when there is none, false when it can't be read */
function discord_rally_current(PDO $db, $maskID) {
    try {
        return fight_rally_read($db, $maskID);
    } catch (PDOException $error) {
        return false;
    }
}

/** The pings of a fight point message: the comp's mention (admin configuration, fight/fight.inc.php) in front of the
    type's ping field, each mention once */
function discord_rally_pings($typePing, $compMention) {
    $tokens = array_filter(explode(' ', trim((discord_ping_normalise($compMention) ?? '') . ' ' . (discord_ping_normalise($typePing) ?? ''))), 'strlen');
    return implode(' ', array_values(array_unique($tokens)));
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
        'ping' => $data['ping'] ?? '', 'mask' => $data['mask'] ?? '', 'time' => (int) ($data['time'] ?? time()),
        'enabledAt' => (int) ($data['enabledAt'] ?? 0)];
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
    // The fleet comp stored with the fight point (fight_rally_read): its name and note in the text, its mention (admin
    // configuration) pinged with the type's ping
    $comp = $rally['comp'] ?? null;
    if ($comp) $base['ping'] = discord_rally_pings($base['ping'], $comp['mention'] ?? '');
    return $base + ['cleared' => false, 'who' => ($rally['setBy'] ?? '') !== '' ? $rally['setBy'] : 'someone',
        'comp' => $comp ? (string) $comp['name'] : '', 'compNote' => $comp ? (string) ($comp['note'] ?? '') : '']
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

/** The mask's live rally message: ['webhookID', 'messageID', 'content' (as last posted / edited), 'postedAt' (unix),
    'systemID' (the system it shows; 0 = unknown, a row from before Fight here)] or null */
function discord_rally_last(PDO $db, $maskID) {
    $stmt = $db->prepare('SELECT * FROM discord_rally_message WHERE maskID = ?');
    $stmt->execute([(string) $maskID]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    return ['webhookID' => (int) $row['webhookID'], 'messageID' => (string) $row['messageID'], 'content' => (string) $row['content'],
        'postedAt' => (int) strtotime($row['postedAt'] . ' UTC'), 'systemID' => (int) ($row['systemID'] ?? 0)];
}

/**
 * Run $write($db) against a table that may be from before Fight here (no systemID column): on an error the column is
 * added (ALTER TABLE, another request may have done it already) and $write runs once more. For discord_rally_message
 * and the legacy fork_rally_discord_message.
 */
function discord_rally_with_system_column(PDO $db, $table, callable $write) {
    try {
        return $write($db);
    } catch (PDOException $error) {
        try { $db->exec("ALTER TABLE $table ADD COLUMN systemID int NOT NULL DEFAULT 0"); } catch (PDOException $ignored) { /* already there */ }
        return $write($db);
    }
}

/**
 * Mentions a new rally payload would ping that the live message's text doesn't have: a comp's role picked (or changed)
 * after the post. An edit never notifies anyone, so such a change has to be a new message. $allowed: the new payload's
 * allowed_mentions (built from admin configuration only), $liveContent: the live message as posted.
 */
function discord_rally_new_mentions(array $allowed, $newContent, $liveContent) {
    // Only mentions that are allowed AND in the new text ping anyone (a ping field or comp mention the admin's template
    // doesn't show via {pings} pings nobody), minus what the live text already had
    $in = discord_mentions_in($newContent);
    $had = discord_mentions_in($liveContent);
    $new = [];
    if (in_array('everyone', $allowed['parse'] ?? [], true) && $in['everyone'] && !$had['everyone']) $new[] = '@everyone/@here';
    foreach (array_diff(array_intersect($allowed['roles'] ?? [], $in['roles']), $had['roles']) as $role) $new[] = '<@&' . $role . '>';
    foreach (array_diff(array_intersect($allowed['users'] ?? [], $in['users']), $had['users']) as $user) $new[] = '<@' . $user . '>';
    return array_values($new);
}

/**
 * The live message a rally row may edit, or null: it went to the row's webhook, has an id and its text, and was posted
 * after the type was (last) turned on ($enabledAt; a message from before belongs to an earlier setup).
 */
function discord_rally_live($last, $webhookID, $enabledAt = 0) {
    if (!$last || (int) $last['webhookID'] !== (int) $webhookID || !preg_match('/^\d{1,32}$/', (string) $last['messageID'])) return null;
    if (($last['content'] ?? '') === '' || ((int) $enabledAt > 0 && (int) $last['postedAt'] < (int) $enabledAt)) return null;
    return $last;
}

/**
 * What the sender does with a rally row (pure). $ctx: the row's message context (discord_rally_context), $live: the
 * live message (discord_rally_live). Returns
 *   ['op' => 'skip', 'why' => ...]                     nothing to send (a clear without a live message, or no change)
 *   ['op' => 'post', 'payload' => ..., 'strike' => null | ['messageID' => ..., 'payload' => ...]]
 *                                                       a new message (with the pings); then the old one is ended (moved)
 *   ['op' => 'edit', 'payload' => ..., 'live' => bool]  edit the live message: it stays live (set / moved within the
 *                                                       window) or is ended (cleared)
 * Edits never ping: no username (a message keeps its author), allowed_mentions empty.
 */
function discord_rally_plan(array $ctx, $live, $now = null, $window = DISCORD_RALLY_WINDOW) {
    $now = $now ?? time();
    if (!empty($ctx['cleared'])) {
        if (!$live) return ['op' => 'skip', 'why' => 'no rally message to edit'];
        return ['op' => 'edit', 'payload' => discord_payload(['previous' => $live['content']] + $ctx), 'live' => false];
    }
    $payload = discord_payload($ctx);
    $systemID = (int) ($ctx['systemID'] ?? 0);
    $age = $live ? $now - (int) $live['postedAt'] : null;
    // Within the window an edit, unless the change pings someone the live message didn't (e.g. a comp with a role picked
    // seconds after "no comp"): edits never notify, so that is a new message with the pings, the old one struck through
    if ($live && $age >= 0 && $age < $window && !discord_rally_new_mentions($payload['allowed_mentions'] ?? [], $payload['content'], $live['content'])) {
        if ($payload['content'] === $live['content']) return ['op' => 'skip', 'why' => 'the message already shows this rally'];
        unset($payload['username']);
        $payload['allowed_mentions'] = ['parse' => []];
        return ['op' => 'edit', 'payload' => $payload, 'live' => true, 'systemID' => $systemID];
    }
    // The old message ends with "Moved to ..." or, on the same system (only the comp changed), "Changed to ..."
    $changed = $live && (int) ($live['systemID'] ?? 0) > 0 && (int) $live['systemID'] === $systemID;
    $strike = $live ? ['messageID' => $live['messageID'], 'payload' => discord_payload(['moved' => true, 'changed' => $changed, 'previous' => $live['content']] + $ctx)] : null;
    return ['op' => 'post', 'payload' => $payload, 'strike' => $strike, 'systemID' => $systemID];
}

function discord_rally_remember(PDO $db, $maskID, $webhookID, $messageID, $content, $now = null, $systemID = 0) {
    discord_rally_forget($db, $maskID);
    discord_rally_with_system_column($db, 'discord_rally_message', function (PDO $db) use ($maskID, $webhookID, $messageID, $content, $now, $systemID) {
        $db->prepare('INSERT INTO discord_rally_message (maskID, webhookID, messageID, content, postedAt, systemID) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([(string) $maskID, (int) $webhookID, (string) $messageID, (string) $content, gmdate('Y-m-d H:i:s', $now ?? time()), (int) $systemID]);
    });
}

/** After a live edit: the message's new text and system (its post time, and so the window, stays) */
function discord_rally_update(PDO $db, $maskID, $messageID, $content, $systemID = 0) {
    discord_rally_with_system_column($db, 'discord_rally_message', function (PDO $db) use ($maskID, $messageID, $content, $systemID) {
        $db->prepare('UPDATE discord_rally_message SET content = ?, systemID = ? WHERE maskID = ? AND messageID = ?')
            ->execute([(string) $content, (int) $systemID, (string) $maskID, (string) $messageID]);
    });
}

function discord_rally_forget(PDO $db, $maskID) {
    $db->prepare('DELETE FROM discord_rally_message WHERE maskID = ?')->execute([(string) $maskID]);
}

/** A webhook's URL was replaced (public/discord.php): its last rally messages belong to the old URL, don't edit them */
function discord_rally_forget_webhook(PDO $db, $webhookID) {
    $db->prepare('DELETE FROM discord_rally_message WHERE webhookID = ?')->execute([(int) $webhookID]);
}

/**
 * How the sender sends a rally row ('rally': a change; 'rallyEdit': the edit that ends a moved rally's old message):
 * ['method' => 'POST'|'PATCH', 'url' => ..., 'payload' => ..., 'plan' => discord_rally_plan() or null], or
 * ['skip' => why] when nothing is sent. $url: the webhook's URL, $context: the row's message context.
 */
function discord_rally_request(PDO $db, array $row, $url, array $context, $now = null) {
    if ($row['kind'] === 'rallyEdit') {
        $edit = discord_webhook_edit_url($url, $context['messageID'] ?? '');
        if ($edit === null || empty($context['payload']['content'])) return ['skip' => 'unreadable edit'];
        return ['method' => 'PATCH', 'url' => $edit, 'payload' => $context['payload'], 'plan' => null];
    }
    $live = discord_rally_live(discord_rally_last($db, $row['maskID']), $row['webhookID'], $context['enabledAt'] ?? 0);
    $plan = discord_rally_plan($context, $live, $now);
    if ($plan['op'] === 'skip') return ['skip' => $plan['why']];
    if ($plan['op'] === 'edit') return ['method' => 'PATCH', 'url' => discord_webhook_edit_url($url, $live['messageID']), 'payload' => $plan['payload'], 'plan' => $plan];
    return ['method' => 'POST', 'url' => discord_webhook_send_url($url), 'payload' => $plan['payload'], 'plan' => $plan];
}

/** Discord's error code from an error body ({"message": "...", "code": 10008}), or 0 */
function discord_error_code($body) {
    $data = json_decode((string) $body, true);
    return is_array($data) && isset($data['code']) && is_numeric($data['code']) ? (int) $data['code'] : 0;
}

/**
 * After a rally request ($request: discord_rally_request): remember a new message and its text (its id comes back with
 * ?wait=true) and queue the edit that ends the old one (moved); keep the text of a live edit; forget a message that was
 * ended. An edit of a message deleted in Discord (404, code 10008 Unknown Message: the webhook itself is fine) is
 * forgotten: a set / move becomes 'repost' (sent again as a new message right away), anything else 'skipped' (nothing
 * left to edit). Every other outcome is the outbox's usual one. Returns the (possibly changed) decision.
 */
function discord_rally_after_send(PDO $db, array $row, array $request, $status, $body, array $decision, $now = null) {
    $plan = $request['plan'] ?? null;
    if ($request['method'] === 'PATCH' && $status === 404 && discord_error_code($body) === 10008) {
        if ($row['kind'] === 'rallyEdit') return ['result' => 'skipped', 'delay' => 0, 'error' => 'the old rally message was deleted in Discord'];
        discord_rally_forget($db, $row['maskID']);
        if ($plan && !empty($plan['live'])) return ['result' => 'repost', 'delay' => 0, 'error' => 'the last rally message was deleted in Discord; posting a new one'];
        return ['result' => 'skipped', 'delay' => 0, 'error' => 'the rally message was deleted in Discord; nothing to edit'];
    }
    if ($decision['result'] !== 'sent' || !$plan) return $decision;
    if ($request['method'] === 'POST') {
        // Moved: end the old message, as an edit of its own (queued; it pings nobody)
        if (!empty($plan['strike'])) discord_enqueue($db, (string) $row['maskID'], (int) $row['webhookID'], 'rallyEdit', $plan['strike'], DISCORD_PRIORITY_RALLY);
        $message = json_decode((string) $body, true);
        $id = is_array($message) && isset($message['id']) ? (string) $message['id'] : '';
        if (preg_match('/^\d{1,32}$/', $id)) discord_rally_remember($db, $row['maskID'], $row['webhookID'], $id, $request['payload']['content'] ?? '', $now, $plan['systemID'] ?? 0);
        else discord_rally_forget($db, $row['maskID']);
    } elseif (!empty($plan['live'])) {
        $last = discord_rally_last($db, $row['maskID']);
        if ($last) discord_rally_update($db, $row['maskID'], $last['messageID'], $request['payload']['content'] ?? '', $plan['systemID'] ?? 0);
    } else {
        discord_rally_forget($db, $row['maskID']);   // ended: the next rally is a new message
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
