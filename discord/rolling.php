<?php
// Fork-owned: notification type 8, "Rolling" (see discord/discord.inc.php, rolling.inc.php).
//
// public/rolling.php queues a message when someone marks a chain connection (wormhole) "rolling" (we are rolling this
// hole), changes the mark (another pilot, another note) or clears it (done). A sibling of type 7, Preserve mass
// (discord/preserve_mass.php), and handled by the sender exactly like it; this file reuses its pure helpers (the hole
// and its ends, change detection, the sender's plan) and keeps its own live messages in discord_rolling_message:
//   - a row waits DISCORD_ROLLING_DELAY seconds and is skipped when a newer row of the same hole is queued (debounce);
//   - the message shows the flag as stored *when it is sent* (who, note, when rolling started) and the hole as it is then;
//   - marked, no live message: a new message (with the pings); only for connections in the chain (chainOnly);
//   - changed within DISCORD_ROLLING_WINDOW seconds of the post: edited; later: a new message (with the pings), the old
//     one edited into its text struck through + "Changed by *who* at HH:MM EVE";
//   - cleared: the live message is edited into its text struck through + the cleared text (no new message, no ping);
//     marked again within DISCORD_ROLLING_WINDOW seconds of that clear: the struck message is edited back;
//   - a hole gone from the map (rolled, collapsed, deleted) with a live message: the worker queues a clear for it once
//     (discord_rolling_clear_gone, every 10 minutes), {who} "Tripwire (the hole is gone from the map)", {outcome}
//     "Hole closed" instead of "Done".
// The texts are short on purpose: the hole's name, the system it is in and the EVE time (UTC, "HH:MM"; the game's
// clock, which is what rollers talk in, unlike the reader-local Discord timestamps of the other types).
//   mark:    "{pings} Rolling **{name}** in **{system}** — {time} EVE"      {time}: when rolling started
//   cleared: "{mark}\n{outcome} at {time} EVE"                             {time}: when it was cleared / found gone
// Every edit has empty allowed_mentions; the edits that end a message have no pings in their text.

const DISCORD_ROLLING_WINDOW   = 30;   // seconds: a change within it edits the message (as Preserve mass)
const DISCORD_ROLLING_DELAY    = 10;   // seconds a queued change waits; a newer change of the same hole replaces it
const DISCORD_PRIORITY_ROLLING = 15;   // as Preserve mass: after Fight here and test messages, before kills and k-space
const DISCORD_ROLLING_KEEP     = 7;    // days a live message is remembered (holes live 1-2 days)
/** Who a message of a hole gone from the map is "cleared by" (the cleared text's {who}) */
const DISCORD_ROLLING_GONE_WHO = 'Tripwire (the hole is gone from the map)';

/** The mask's rolling type when it is turned on with a webhook, else null. $settings: normalised settings. */
function discord_rolling_type(array $settings) {
    $type = $settings['types']['rolling'] ?? null;
    return $type && $type['enabled'] && $type['webhookID'] > 0 ? $type : null;
}

/** [type, homeSystemID] of a mask that may send Discord notifications with the type on, or null (one settings read) */
function discord_rolling_target(PDO $db, $maskID) {
    $stmt = $db->prepare('SELECT settings FROM discord_settings WHERE maskID = ?');
    $stmt->execute([(string) $maskID]);
    $json = $stmt->fetchColumn();
    if ($json === false || $json === null) return null;
    $settings = discord_settings_normalise(json_decode($json, true), discord_settings_defaults())[0];
    $type = discord_rolling_type($settings);
    if (!$type || !discord_mask_sending_corporation($db, $maskID)) return null;
    return [$type, (int) $settings['homeSystemID']];
}

/**
 * What a request did to a hole's flag (pure): 'set' (marked, or the mark changed: another pilot or note), 'clear'
 * (removed), or null (nothing anyone would see changed). $before / $after: the flag as stored ({setBy, note}) or null.
 */
function discord_rolling_change($before, $after) {
    $asPreserve = function ($flag) { return $flag ? ['setBy' => $flag['setBy'] ?? '', 'reason' => $flag['note'] ?? ''] : null; };
    return discord_preserve_change($asPreserve($before), $asPreserve($after));
}

/**
 * Outbox data of a change. $action 'set' or 'clear', $who the character that made it; the flag itself is read when the
 * message is sent. $ends: the hole as it is now (discord_preserve_ends), kept for a message sent after the hole is gone.
 * $gone: the clear of a hole gone from the map (the worker). Null when the change is from before the type was turned on.
 */
function discord_rolling_data(array $type, $homeSystemID, $maskName, $wormholeID, $action, $who, $ends = null, $gone = false, $now = null, $rolled = false) {
    $now = $now ?? time();
    if (!empty($type['enabledAt']) && $now < (int) $type['enabledAt']) return null;
    return [
        'kind' => 'rolling', 'wormholeID' => (int) $wormholeID, 'action' => $action === 'clear' ? 'clear' : 'set', 'who' => (string) $who,
        'gone' => (bool) $gone, 'rolled' => (bool) $rolled,
        'template' => $type['template'], 'templateClear' => $type['templateClear'], 'ping' => $type['ping'],
        'chainOnly' => !empty($type['chainOnly']), 'homeSystemID' => (int) $homeSystemID,
        'mask' => (string) $maskName, 'time' => (int) $now, 'enabledAt' => (int) ($type['enabledAt'] ?? 0), 'ends' => $ends,
    ];
}

/**
 * Queue a change of a hole's flag (public/rolling.php, discord_rolling_clear_gone). Returns the outbox id, or null
 * (type off, queue full, or $claim() said no: then nothing is queued, in one transaction with the claim).
 */
function discord_rolling_enqueue(PDO $db, $maskID, $wormholeID, $action, $who, ?callable $claim = null, $gone = false, $rolled = false) {
    $target = discord_rolling_target($db, $maskID);
    if (!$target) return null;
    [$type, $home] = $target;
    $hole = discord_preserve_hole($db, $maskID, $wormholeID);
    $ends = $hole ? discord_preserve_ends($hole, function ($systemID) use ($db, $maskID) { return discord_chain_label($db, $maskID, $systemID); }, $home) : null;
    $data = discord_rolling_data($type, $home, discord_mask_name($db, $maskID), $wormholeID, $action, $who, $ends, $gone, null, $rolled);
    if ($data === null) return null;
    // Debounce: the row waits a little, so a quick mark + clear (or several edits) collapse into the last one
    if ($claim) return discord_enqueue_once($db, (string) $maskID, $type['webhookID'], 'rolling', $data, $claim, DISCORD_PRIORITY_ROLLING, DISCORD_ROLLING_DELAY);
    return discord_enqueue($db, (string) $maskID, $type['webhookID'], 'rolling', $data, DISCORD_PRIORITY_ROLLING, DISCORD_ROLLING_DELAY);
}

/** Live (not struck) messages whose wormhole is gone from its mask (rolled, collapsed, deleted): [[maskID, wormholeID], ...] */
function discord_rolling_gone(PDO $db) {
    $rows = $db->query('SELECT m.maskID, m.wormholeID FROM discord_rolling_message m
        LEFT JOIN wormholes w ON w.id = m.wormholeID AND w.maskID = m.maskID
        WHERE m.clearedAt IS NULL AND w.id IS NULL')->fetchAll(PDO::FETCH_NUM);
    return array_map(function ($r) { return [(string) $r[0], (int) $r[1]]; }, $rows);
}

/** Who started rolling a hole (fork_rolling.setBy, kept until the mask's flags next change even when the hole is gone), '' when unknown */
function discord_rolling_setter(PDO $db, $maskID, $wormholeID) {
    try {
        $stmt = $db->prepare('SELECT setBy FROM fork_rolling WHERE maskID = ? AND wormholeID = ?');
        $stmt->execute([(string) $maskID, (int) $wormholeID]);
        return trim((string) $stmt->fetchColumn());
    } catch (Throwable $error) {
        return '';
    }
}

/**
 * Worker, with the outbox prune: queue a clear for every live message whose hole is gone (most often: it was rolled),
 * so the channel doesn't keep marks that look live. Once per message: the claim ('rollGone' + wormholeID in
 * discord_sent, kept 7 days like the messages) is written with the outbox row. The message is struck through with the
 * cleared text, {outcome} "Hole closed" + " (rolling by <who started it>)", nobody pinged. Returns the number queued.
 */
function discord_rolling_clear_gone(PDO $db) {
    $queued = 0;
    foreach (discord_rolling_gone($db) as [$maskID, $wormholeID]) {
        $claim = function () use ($db, $maskID, $wormholeID) { return discord_dedupe_once($db, $maskID, 'rollGone', (string) $wormholeID); };
        // A live message means the hole was flagged when it went (it may have been rolled, collapsed or expired): "Hole closed (rolling by <who started it>)"
        $setter = discord_rolling_setter($db, $maskID, $wormholeID);
        if (discord_rolling_enqueue($db, $maskID, $wormholeID, 'clear', $setter !== '' ? $setter : DISCORD_ROLLING_GONE_WHO, $claim, true) !== null) $queued++;
    }
    return $queued;
}

/** The flag of a hole as stored now: ['setBy', 'note', 'setAt' (unix)], null when there is none (or its hole is gone),
    false when it can't be read */
function discord_rolling_flag(PDO $db, $maskID, $wormholeID) {
    try {
        $stmt = $db->prepare('SELECT r.setBy, r.note, UNIX_TIMESTAMP(r.setAt) AS setAt FROM fork_rolling r
            INNER JOIN wormholes w ON w.id = r.wormholeID AND w.maskID = r.maskID WHERE r.maskID = ? AND r.wormholeID = ?');
        $stmt->execute([(string) $maskID, (int) $wormholeID]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        return false;
    }
    return $row ? ['setBy' => (string) ($row['setBy'] ?? ''), 'note' => (string) ($row['note'] ?? ''), 'setAt' => (int) ($row['setAt'] ?? 0)] : null;
}

/**
 * Message context of a row (pure). $flag: the flag as stored now (discord_rolling_flag; false = unknown: a clear is
 * still shown as cleared, a set can't be shown, null). $ends: the hole now (discord_preserve_ends) or null when it is
 * gone (then the ends kept with the row, and a clear says "Hole closed"). $chain: the mask's chain (systemID =>
 * true) when the type is limited to it, null when it isn't. inChain says whether a *new* message may be posted.
 */
function discord_rolling_context(array $data, $flag, $ends, $chain = null) {
    $base = ['kind' => 'rolling', 'wormholeID' => (int) ($data['wormholeID'] ?? 0),
        'template' => (string) ($data['template'] ?? ''), 'templateClear' => (string) ($data['templateClear'] ?? ''),
        'ping' => $data['ping'] ?? '', 'mask' => $data['mask'] ?? '', 'time' => (int) ($data['time'] ?? time()),
        'enabledAt' => (int) ($data['enabledAt'] ?? 0), 'ends' => $ends ?? (is_array($data['ends'] ?? null) ? $data['ends'] : null)];
    if ($flag === false) {
        if (($data['action'] ?? '') !== 'clear') return null;
        $flag = null;
    }
    if (!$flag) {
        // Only name who cleared it when this row was the clear (a set whose flag is gone by now was cleared by someone else)
        $who = ($data['action'] ?? '') === 'clear' && ($data['who'] ?? '') !== '' ? $data['who'] : 'someone';
        return $base + ['cleared' => true, 'gone' => !empty($data['gone']) || $ends === null, 'rolled' => !empty($data['rolled']), 'goneBy' => !empty($data['gone']), 'who' => $who, 'note' => '', 'setAt' => 0, 'inChain' => false];
    }
    $systems = $base['ends']['systems'] ?? [];
    $inChain = $chain === null || (bool) array_filter($systems, function ($id) use ($chain) { return isset($chain[(int) $id]); });
    return $base + ['cleared' => false, 'gone' => false, 'who' => $flag['setBy'] !== '' ? $flag['setBy'] : 'someone', 'note' => $flag['note'],
        'setAt' => (int) ($flag['setAt'] ?? 0), 'inChain' => $inChain];
}

/** "19:08" (EVE time is UTC) */
function discord_rolling_eve_time($unix) {
    return gmdate('H:i', (int) $unix);
}

/** The pilot a cleared context names, '' when there is none (nobody, "someone", or the worker's own name) */
function discord_rolling_known_who(array $ctx) {
    $who = (string) ($ctx['who'] ?? '');
    return $who !== 'someone' && $who !== DISCORD_ROLLING_GONE_WHO ? $who : '';
}

/** The {outcome} text of a cleared message (plain text, escaped by the renderer): "Rolled by Kytus" when someone pressed
    "Stop rolling > Rolled (closed)", "Hole closed" when the hole vanished from the map (the worker appends " (rolling by X)"),
    else "Done" */
function discord_rolling_outcome(array $ctx) {
    if (!empty($ctx['rolled'])) {
        $who = discord_rolling_known_who($ctx);
        return $who !== '' ? 'Rolled by ' . $who : 'Rolled';
    }
    return !empty($ctx['gone']) ? 'Hole closed' : 'Done';
}

/** Placeholder values of a context (escaped by discord_render unless listed in the raw keys) */
function discord_rolling_values(array $ctx) {
    $ends = $ctx['ends'] ?? null;
    $near = $ends['near'] ?? null;
    $far = $ends['far'] ?? null;
    $side = function ($end) { return $end ? discord_label_system($end['label'] ?? '', $end['system'] ?? '') : ''; };
    $sig = (string) ($ends['sig'] ?? '');
    // The hole's name: the chain label of the system it leads to (the name of this hole, as the chain map shows it),
    // else its signature ID in the system it is in
    $label = (string) ($far['label'] ?? '');
    $name = $label !== '' ? $label : ($sig !== '' && $sig !== '???' ? $sig : '?');
    $mapOf = (($near['systemID'] ?? 0) >= 30000000) ? $near['systemID'] : ((($far['systemID'] ?? 0) >= 30000000) ? $far['systemID'] : 0);
    $note = (string) ($ctx['note'] ?? '');
    $cleared = !empty($ctx['cleared']);
    // Mark: when rolling started (the flag's time); cleared / changed: when that happened (the row's time)
    $at = !$cleared && !empty($ctx['setAt']) && empty($ctx['changed']) ? (int) $ctx['setAt'] : (int) ($ctx['time'] ?? time());
    return [
        'pings' => $ctx['ping'] ?? '', 'mask' => $ctx['mask'] ?? '',
        'name' => $name, 'system' => (string) ($near['system'] ?? '?'), 'to' => (string) ($far['system'] ?? '?'),
        'class' => (string) ($far['class'] ?? ''), 'sig' => $sig,
        'connection' => $ends ? $side($near) . ' ↔ ' . $side($far) : 'a wormhole',
        'who' => $ctx['who'] ?? 'someone', 'note' => $note,
        // Built from escaped parts: ": rolling it closed" or empty
        'withNote' => $note !== '' ? ': ' . discord_escape($note) : '',
        'map' => $mapOf ? '<' . discord_map_url($mapOf) . '>' : '',
        'time' => discord_rolling_eve_time($at),
        'outcome' => discord_rolling_outcome($ctx),
    ];
}

/**
 * The webhook payload of a context: the mark (content only, no embed: it is edited in place), or with 'previous' (the
 * live message as last posted) the edit that ends it: 'cleared' (the cleared text) or 'changed' (a newer message was
 * posted: "Changed by *who* at HH:MM EVE"). Such an edit has no pings in its text and pings nobody.
 */
function discord_rolling_payload(array $ctx) {
    $values = discord_rolling_values($ctx);
    $raw = ['pings', 'map', 'time', 'withNote', 'mark'];
    $cleared = !empty($ctx['cleared']);
    $ending = $cleared || !empty($ctx['changed']);
    $defaults = discord_default_templates();
    if (!$ending) {
        $template = $ctx['template'] ?? '';
        $values['mark'] = '';
        $content = discord_render($template, $values, $raw);
        if ($content === '') {
            $template = $defaults['rolling'];
            $content = discord_render($template, $values, $raw);
        }
        return ['username' => 'Tripwire', 'content' => $content, 'allowed_mentions' => discord_allowed_mentions($template, $ctx['ping'] ?? '')];
    }
    // {mark} goes in last (a marker until then), so a long struck text is what gets cut, never the outcome / time
    $marker = '{mark' . bin2hex(random_bytes(6)) . '}';
    $values['mark'] = $cleared ? $marker : '';
    $values['pings'] = '';
    if ($cleared) {
        $content = discord_render($ctx['templateClear'] ?? '', $values, $raw);
        if ($content === '' || $content === $marker) $content = discord_render($defaults['rollingClear'], $values, $raw);
        // A hole that vanished while flagged (rolled, collapsed or expired: we can't tell): who started rolling it
        if (!empty($ctx['goneBy']) && empty($ctx['rolled']) && discord_rolling_known_who($ctx) !== '') $content .= ' (rolling by ' . discord_escape(discord_rolling_known_who($ctx)) . ')';
    } else {
        $content = discord_render('Changed by *{who}* at {time} EVE', $values, $raw);
    }
    $content = trim(discord_strip_mentions($content));
    if (strpos($content, $marker) === false) $content = $marker . "\n" . $content;
    $struck = discord_rally_strike($ctx['previous'] ?? '');
    $room = DISCORD_CONTENT_MAX - (mb_strlen($content) - mb_strlen($marker));
    if (mb_strlen($struck) > $room) $struck = $room > 6 ? discord_truncate($struck, $room - 2) . '~~' : '';
    $content = trim(str_replace($marker, $struck, $content));
    return ['content' => discord_truncate($content, DISCORD_CONTENT_MAX), 'allowed_mentions' => ['parse' => []]];
}

/** What the sender does with a row (pure): discord_preserve_plan with this type's messages */
function discord_rolling_plan(array $ctx, $live, $now = null, $window = DISCORD_ROLLING_WINDOW) {
    return discord_preserve_plan($ctx, $live, $now, $window, 'discord_rolling_payload');
}

/** The live message of a hole: ['webhookID', 'messageID', 'content' (as last posted / edited), 'postedAt', 'clearedAt' (unix, 0 = live)] or null */
function discord_rolling_last(PDO $db, $maskID, $wormholeID) {
    $stmt = $db->prepare('SELECT * FROM discord_rolling_message WHERE maskID = ? AND wormholeID = ?');
    $stmt->execute([(string) $maskID, (int) $wormholeID]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    return ['webhookID' => (int) $row['webhookID'], 'messageID' => (string) $row['messageID'], 'content' => (string) $row['content'],
        'postedAt' => (int) strtotime($row['postedAt'] . ' UTC'), 'clearedAt' => empty($row['clearedAt']) ? 0 : (int) strtotime($row['clearedAt'] . ' UTC')];
}

function discord_rolling_remember(PDO $db, $maskID, $wormholeID, $webhookID, $messageID, $content, $now = null) {
    discord_rolling_forget($db, $maskID, $wormholeID);
    $db->prepare('INSERT INTO discord_rolling_message (maskID, wormholeID, webhookID, messageID, content, postedAt, clearedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        ->execute([(string) $maskID, (int) $wormholeID, (int) $webhookID, (string) $messageID, (string) $content, gmdate('Y-m-d H:i:s', $now ?? time())]);
}

function discord_rolling_forget(PDO $db, $maskID, $wormholeID) {
    $db->prepare('DELETE FROM discord_rolling_message WHERE maskID = ? AND wormholeID = ?')->execute([(string) $maskID, (int) $wormholeID]);
}

/** A webhook's URL was replaced (public/discord.php): its messages belong to the old URL, don't edit them */
function discord_rolling_forget_webhook(PDO $db, $webhookID) {
    $db->prepare('DELETE FROM discord_rolling_message WHERE webhookID = ?')->execute([(int) $webhookID]);
}

/** Forget old messages (worker, with the outbox prune): struck for a day, or posted DISCORD_ROLLING_KEEP days ago */
function discord_rolling_prune(PDO $db, $now = null) {
    $now = $now ?? time();
    $stmt = $db->prepare('DELETE FROM discord_rolling_message WHERE (clearedAt IS NOT NULL AND clearedAt < ?) OR postedAt < ?');
    $stmt->execute([gmdate('Y-m-d H:i:s', $now - 86400), gmdate('Y-m-d H:i:s', $now - DISCORD_ROLLING_KEEP * 86400)]);
    return $stmt->rowCount();
}

/** Whether a newer row of the same hole is queued (then this one is skipped: the newer one shows the flag as it is then) */
function discord_rolling_superseded(PDO $db, array $row) {
    $wormholeID = (int) (json_decode($row['data'], true)['wormholeID'] ?? 0);
    $stmt = $db->prepare("SELECT data FROM discord_outbox WHERE maskID = ? AND kind = 'rolling' AND status = 'queued' AND id > ?");
    $stmt->execute([(string) $row['maskID'], (int) $row['id']]);
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $data) {
        if ((int) (json_decode($data, true)['wormholeID'] ?? 0) === $wormholeID) return true;
    }
    return false;
}

/**
 * Message context of an outbox row: the flag and the hole as stored now, the chain when the type is limited to it.
 * Null when a mark can't be read now (a database error): the sender tries again a little later.
 */
function discord_rolling_row_context(PDO $db, $maskID, array $data) {
    $wormholeID = (int) ($data['wormholeID'] ?? 0);
    $flag = discord_rolling_flag($db, $maskID, $wormholeID);
    if ($flag === false && ($data['action'] ?? '') !== 'clear') return null;
    $hole = discord_preserve_hole($db, $maskID, $wormholeID);
    // The hole can't be read (a database error): the ends kept with the row, and not "gone" unless the row says so
    // (a mark waits: it can't be shown or checked against the chain without the hole)
    if ($hole === false && $flag) return null;
    if ($hole === false) return discord_rolling_context($data, $flag, is_array($data['ends'] ?? null) ? $data['ends'] : [], null);
    $ends = $hole ?discord_preserve_ends($hole, function ($systemID) use ($db, $maskID) { return discord_chain_label($db, $maskID, $systemID); }, (int) ($data['homeSystemID'] ?? 0)) : null;
    // The chain only matters for a mark (a clear never posts anything new)
    $chain = $flag && !empty($data['chainOnly']) ? discord_chain_systems_cached($db, $maskID, (int) ($data['homeSystemID'] ?? 0)) : null;
    return discord_rolling_context($data, $flag, $ends, $chain);
}

/**
 * How the sender sends a row ('rolling': a change; 'rollingEdit': the edit that ends a changed mark's old message):
 * ['method', 'url', 'payload', 'plan'] or ['skip' => why]. $url: the webhook's URL, $context: the row's context.
 */
function discord_rolling_request(PDO $db, array $row, $url, array $context, $now = null) {
    if ($row['kind'] === 'rollingEdit') {
        $edit = discord_webhook_edit_url($url, $context['messageID'] ?? '');
        if ($edit === null || empty($context['payload']['content'])) return ['skip' => 'unreadable edit'];
        return ['method' => 'PATCH', 'url' => $edit, 'payload' => $context['payload'], 'plan' => null];
    }
    $live = discord_rally_live(discord_rolling_last($db, $row['maskID'], $context['wormholeID'] ?? 0), $row['webhookID'], $context['enabledAt'] ?? 0);
    $plan = discord_rolling_plan($context, $live, $now) + ['wormholeID' => (int) ($context['wormholeID'] ?? 0)];
    if ($plan['op'] === 'skip') return ['skip' => $plan['why']];
    if ($plan['op'] === 'edit') return ['method' => 'PATCH', 'url' => discord_webhook_edit_url($url, $live['messageID']), 'payload' => $plan['payload'], 'plan' => $plan];
    return ['method' => 'POST', 'url' => discord_webhook_send_url($url), 'payload' => $plan['payload'], 'plan' => $plan];
}

/**
 * After a request (discord_rolling_request): remember a new message and its text, queue the edit that ends the old
 * one (changed), keep the text of a live edit, note when a message was struck through / brought back. An edit of a
 * message deleted in Discord (404, code 10008) is forgotten: a mark becomes 'repost', anything else 'skipped'.
 */
function discord_rolling_after_send(PDO $db, array $row, array $request, $status, $body, array $decision, $now = null) {
    $now = $now ?? time();
    $plan = $request['plan'] ?? null;
    if ($request['method'] === 'PATCH' && $status === 404 && discord_error_code($body) === 10008) {
        if ($row['kind'] === 'rollingEdit') return ['result' => 'skipped', 'delay' => 0, 'error' => 'the old rolling message was deleted in Discord'];
        discord_rolling_forget($db, $row['maskID'], $plan['wormholeID'] ?? 0);
        if ($plan && ($plan['state'] ?? '') !== 'cleared') return ['result' => 'repost', 'delay' => 0, 'error' => 'the rolling message was deleted in Discord; posting a new one'];
        return ['result' => 'skipped', 'delay' => 0, 'error' => 'the rolling message was deleted in Discord; nothing to edit'];
    }
    if ($decision['result'] !== 'sent' || !$plan) return $decision;
    $wormholeID = (int) ($plan['wormholeID'] ?? 0);
    if ($request['method'] === 'POST') {
        if (!empty($plan['strike'])) discord_enqueue($db, (string) $row['maskID'], (int) $row['webhookID'], 'rollingEdit', $plan['strike'], DISCORD_PRIORITY_ROLLING);
        $message = json_decode((string) $body, true);
        $id = is_array($message) && isset($message['id']) ? (string) $message['id'] : '';
        if (preg_match('/^\d{1,32}$/', $id)) discord_rolling_remember($db, $row['maskID'], $wormholeID, $row['webhookID'], $id, $request['payload']['content'] ?? '', $now);
        else discord_rolling_forget($db, $row['maskID'], $wormholeID);
    } elseif ($plan['state'] === 'cleared') {
        $db->prepare('UPDATE discord_rolling_message SET clearedAt = ? WHERE maskID = ? AND wormholeID = ?')
            ->execute([gmdate('Y-m-d H:i:s', $now), (string) $row['maskID'], $wormholeID]);
    } else {
        // A live edit keeps the window of its post; a message brought back after a clear starts a new one
        $sql = $plan['state'] === 'revived' ? 'UPDATE discord_rolling_message SET content = ?, clearedAt = NULL, postedAt = ? WHERE maskID = ? AND wormholeID = ?'
            : 'UPDATE discord_rolling_message SET content = ? WHERE maskID = ? AND wormholeID = ?';
        $params = $plan['state'] === 'revived' ? [$request['payload']['content'] ?? '', gmdate('Y-m-d H:i:s', $now), (string) $row['maskID'], $wormholeID]
            : [$request['payload']['content'] ?? '', (string) $row['maskID'], $wormholeID];
        $db->prepare($sql)->execute($params);
    }
    return $decision;
}
