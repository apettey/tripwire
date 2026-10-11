<?php
// Fork-owned: notification type 7, "Preserve mass" (see discord/discord.inc.php, preserve_mass.inc.php).
//
// public/preserve_mass.php queues a message when someone marks a chain connection (wormhole) "preserve mass", changes
// the mark (another pilot, another reason) or clears it. The change is decided on the server, from the flag as stored
// before and after the request (discord_preserve_change), never from what the browser says. Every member's change is
// posted: it is a safety signal for the corporation ("don't jump this hole carelessly"); the admins turn the type on
// or off. Only connections in the mask's chain (connected to its home system, discord/chain.php) are posted unless the
// admin unticks "only the chain"; a mask without a home then posts nothing new (as chain kills).
//
// The sender (discord_dispatch) handles a row like a Fight here row (discord/rally.php), one live message per
// (mask, wormhole) in discord_preserve_message:
//   - a row waits DISCORD_PRESERVE_DELAY seconds and is skipped when a newer row of the same hole is queued
//     (debounce: mark + clear in quick succession sends nothing; the newest row shows the flag as stored then);
//   - the message shows the flag as stored *when it is sent* (who, reason) and the hole as it is then;
//   - marked, no live message: a new message (with the pings); only for connections in the chain (chainOnly);
//   - marked again / changed within DISCORD_PRESERVE_WINDOW seconds of the post: the message is edited;
//     later: a new message (with the pings), the old one edited into its text struck through + "Changed by ...";
//   - cleared: the live message is edited into its text struck through + the cleared text (no new message, no ping);
//     marked again within DISCORD_PRESERVE_WINDOW seconds of that clear: the struck message is edited back (no new
//     message), so toggling the mark doesn't spam the channel. A clear without a live message sends nothing.
// Every edit has empty allowed_mentions; the edits that end a message have no pings in their text. A live message
// deleted in Discord (404 Unknown Message) is forgotten: a mark is posted again, a clear sends nothing.

const DISCORD_PRESERVE_WINDOW   = 30;   // seconds: a change within it edits the message (as Fight here)
const DISCORD_PRESERVE_DELAY    = 10;   // seconds a queued change waits; a newer change of the same hole replaces it
const DISCORD_PRIORITY_PRESERVE = 15;   // after Fight here and test messages, before kills and k-space
const DISCORD_PRESERVE_KEEP     = 7;    // days a live message is remembered (holes live 1-2 days)

/** Generic system types of a signature whose far side is unknown (index = systemID; appData.genericSystemTypes) */
const DISCORD_GENERIC_SYSTEMS = [['Null-Sec', 'NS'], ['Low-Sec', 'LS'], ['High-Sec', 'HS'], ['Class-1', 'C1'], ['Class-2', 'C2'],
    ['Class-3', 'C3'], ['Class-4', 'C4'], ['Class-5', 'C5'], ['Class-6', 'C6'], ['Class-13', 'C13'], ['Triglavian', 'Trig'],
    ['Unknown', ''], ['Unknown (small)', ''], ['Dangerous', ''], ['Class-14', 'C14'], ['Class-15', 'C15'], ['Class-16', 'C16'],
    ['Class-17', 'C17'], ['Class-18', 'C18']];

/** The mask's preserve mass type when it is turned on with a webhook, else null. $settings: normalised settings. */
function discord_preserve_type(array $settings) {
    $type = $settings['types']['preserveMass'] ?? null;
    return $type && $type['enabled'] && $type['webhookID'] > 0 ? $type : null;
}

/** [type, homeSystemID] of a mask that may send Discord notifications with the type on, or null (one settings read) */
function discord_preserve_target(PDO $db, $maskID) {
    $stmt = $db->prepare('SELECT settings FROM discord_settings WHERE maskID = ?');
    $stmt->execute([(string) $maskID]);
    $json = $stmt->fetchColumn();
    if ($json === false || $json === null) return null;
    $settings = discord_settings_normalise(json_decode($json, true), discord_settings_defaults())[0];
    $type = discord_preserve_type($settings);
    if (!$type || !discord_mask_sending_corporation($db, $maskID)) return null;
    return [$type, (int) $settings['homeSystemID']];
}

/**
 * What a request did to a hole's flag (pure): 'set' (marked, or the mark changed: another pilot or reason), 'clear'
 * (removed), or null (nothing anyone would see changed). $before / $after: the flag as stored ({setBy, reason}) or null.
 */
function discord_preserve_change($before, $after) {
    if (!$before && !$after) return null;
    if (!$after) return 'clear';
    if (!$before) return 'set';
    return (string) ($before['setBy'] ?? '') !== (string) ($after['setBy'] ?? '') || (string) ($before['reason'] ?? '') !== (string) ($after['reason'] ?? '')
        ? 'set' : null;
}

/** A system for the message: [name, class]; generic placeholders for an unknown far side ("Class-5", C5) */
function discord_preserve_system($systemID) {
    $systemID = (int) $systemID;
    if ($systemID >= 30000000) return [discord_system_name($systemID), discord_system_class($systemID)];
    $generic = DISCORD_GENERIC_SYSTEMS[$systemID] ?? null;
    return $generic && $systemID >= 0 ? $generic : ['Unknown', ''];
}

/** A hole as stored now: [wormholeID, type, parent, life, mass, a, b (systemIDs), aSig, bSig], null when gone, false when it can't be read */
function discord_preserve_hole(PDO $db, $maskID, $wormholeID) {
    try {
        $stmt = $db->prepare('SELECT w.id AS wormholeID, w.type, w.parent, w.life, w.mass, a.systemID AS a, b.systemID AS b,
                a.signatureID AS aSig, b.signatureID AS bSig
            FROM wormholes w INNER JOIN signatures a ON a.id = w.initialID INNER JOIN signatures b ON b.id = w.secondaryID
            WHERE w.id = ? AND w.maskID = ?');
        $stmt->execute([(int) $wormholeID, (string) $maskID]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        return false;
    }
    if (!$row) return null;
    return ['wormholeID' => (int) $row['wormholeID'], 'type' => (string) ($row['type'] ?? ''), 'parent' => (string) ($row['parent'] ?? ''),
        'life' => (string) ($row['life'] ?? ''), 'mass' => (string) ($row['mass'] ?? ''), 'a' => (int) $row['a'], 'b' => (int) $row['b'],
        'aSig' => (string) ($row['aSig'] ?? ''), 'bSig' => (string) ($row['bSig'] ?? '')];
}

/**
 * The two ends of a hole for the message (pure apart from $labelOf): ['near' => end, 'far' => end, 'hole', 'sig',
 * 'mass', 'life', 'systems' => [a, b]], end = ['systemID', 'system', 'class', 'label']. Near is the end closer to home:
 * the home system ($homeID), else the end with the shorter chain label (with the chain map's naming A, AB, ABC... the
 * closer one; an end without a label counts as farthest), then the hole's first signature. 'hole' is the hole's type
 * as seen from the near end (K162 when the real type was scanned on the far side), 'sig' the near end's signature.
 * $labelOf(systemID): chain label or ''.
 */
function discord_preserve_ends(array $hole, ?callable $labelOf = null, $homeID = 0) {
    $end = function ($side) use ($hole, $labelOf) {
        $id = (int) $hole[$side];
        [$name, $class] = discord_preserve_system($id);
        return ['systemID' => $id, 'system' => $name, 'class' => $class, 'label' => $labelOf && $id >= 30000000 ? (string) $labelOf($id) : ''];
    };
    $a = $end('a');
    $b = $end('b');
    $rank = function ($e) use ($homeID) {
        if ((int) $homeID > 0 && $e['systemID'] === (int) $homeID) return -1;
        return $e['label'] === '' ? PHP_INT_MAX : mb_strlen($e['label']);
    };
    $near = $rank($b) < $rank($a) ? 'b' : 'a';
    $type = strtoupper(trim($hole['type'] ?? ''));
    if (!preg_match('/^[A-Z][A-Z0-9]{3}$/', $type)) $type = '';
    $typedSide = ($hole['parent'] ?? '') === 'initial' ? 'a' : (($hole['parent'] ?? '') === 'secondary' ? 'b' : '');
    $through = $typedSide === '' ? '' : ($typedSide === $near ? $type : 'K162');
    return ['near' => $near === 'a' ? $a : $b, 'far' => $near === 'a' ? $b : $a, 'hole' => $through,
        'sig' => discord_sig_text($hole[$near . 'Sig'] ?? ''), 'mass' => (string) ($hole['mass'] ?? ''), 'life' => (string) ($hole['life'] ?? ''),
        'systems' => [(int) $hole['a'], (int) $hole['b']]];
}

/**
 * Outbox data of a change. $action 'set' or 'clear' (only used to name who cleared it), $who the character that made
 * it; the flag itself is read when the message is sent. $ends: the hole as it is now (discord_preserve_ends), kept for
 * a message sent after the hole is gone. Null when the change is from before the type was turned on.
 */
function discord_preserve_data(array $type, $homeSystemID, $maskName, $wormholeID, $action, $who, $ends = null, $now = null) {
    $now = $now ?? time();
    if (!empty($type['enabledAt']) && $now < (int) $type['enabledAt']) return null;
    return [
        'kind' => 'preserveMass', 'wormholeID' => (int) $wormholeID, 'action' => $action === 'clear' ? 'clear' : 'set', 'who' => (string) $who,
        'template' => $type['template'], 'templateClear' => $type['templateClear'], 'ping' => $type['ping'],
        'chainOnly' => !empty($type['chainOnly']), 'homeSystemID' => (int) $homeSystemID,
        'mask' => (string) $maskName, 'time' => (int) $now, 'enabledAt' => (int) ($type['enabledAt'] ?? 0), 'ends' => $ends,
    ];
}

/** Queue a change of a hole's flag (public/preserve_mass.php). Returns the outbox id, or null (type off, queue full). */
function discord_preserve_enqueue(PDO $db, $maskID, $wormholeID, $action, $who) {
    $target = discord_preserve_target($db, $maskID);
    if (!$target) return null;
    [$type, $home] = $target;
    $hole = discord_preserve_hole($db, $maskID, $wormholeID);
    $ends = $hole ? discord_preserve_ends($hole, function ($systemID) use ($db, $maskID) { return discord_chain_label($db, $maskID, $systemID); }, $home) : null;
    $data = discord_preserve_data($type, $home, discord_mask_name($db, $maskID), $wormholeID, $action, $who, $ends);
    if ($data === null) return null;
    $id = discord_enqueue($db, (string) $maskID, $type['webhookID'], 'preserveMass', $data, DISCORD_PRIORITY_PRESERVE);
    // Debounce: the row waits a little, so a quick mark + clear (or several edits) collapse into the last one
    if ($id !== null) $db->prepare('UPDATE discord_outbox SET nextAttemptAt = UTC_TIMESTAMP() + INTERVAL ' . DISCORD_PRESERVE_DELAY . ' SECOND WHERE id = ?')->execute([$id]);
    return $id;
}

/** The flag of a hole as stored now: ['setBy', 'reason'], null when there is none (or its hole is gone), false when it can't be read */
function discord_preserve_flag(PDO $db, $maskID, $wormholeID) {
    try {
        $stmt = $db->prepare('SELECT p.setBy, p.reason FROM fork_preserve_mass p
            INNER JOIN wormholes w ON w.id = p.wormholeID AND w.maskID = p.maskID WHERE p.maskID = ? AND p.wormholeID = ?');
        $stmt->execute([(string) $maskID, (int) $wormholeID]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        return false;
    }
    return $row ? ['setBy' => (string) ($row['setBy'] ?? ''), 'reason' => (string) ($row['reason'] ?? '')] : null;
}

/**
 * Message context of a row (pure). $flag: the flag as stored now (discord_preserve_flag; false = unknown: a clear is
 * still shown as cleared, a set can't be shown, null). $ends: the hole now (discord_preserve_ends) or null when it is
 * gone (then the ends kept with the row). $chain: the mask's chain (systemID => true) when the type is limited to it,
 * null when it isn't. inChain says whether a *new* message may be posted.
 */
function discord_preserve_context(array $data, $flag, $ends, $chain = null) {
    $base = ['kind' => 'preserveMass', 'wormholeID' => (int) ($data['wormholeID'] ?? 0),
        'template' => discord_template_upgrade('preserveMass', 'template', $data['template'] ?? ''),
        'templateClear' => discord_template_upgrade('preserveMass', 'templateClear', $data['templateClear'] ?? ''),
        'ping' => $data['ping'] ?? '', 'mask' => $data['mask'] ?? '', 'time' => (int) ($data['time'] ?? time()),
        'enabledAt' => (int) ($data['enabledAt'] ?? 0), 'ends' => $ends ?? (is_array($data['ends'] ?? null) ? $data['ends'] : null)];
    if ($flag === false) {
        if (($data['action'] ?? '') !== 'clear') return null;
        $flag = null;
    }
    if (!$flag) {
        // Only name who cleared it when this row was the clear (a set whose flag is gone by now was cleared by someone else)
        $who = ($data['action'] ?? '') === 'clear' && ($data['who'] ?? '') !== '' ? $data['who'] : 'someone';
        return $base + ['cleared' => true, 'who' => $who, 'reason' => '', 'inChain' => false];
    }
    $systems = $base['ends']['systems'] ?? [];
    $inChain = $chain === null || (bool) array_filter($systems, function ($id) use ($chain) { return isset($chain[(int) $id]); });
    return $base + ['cleared' => false, 'who' => $flag['setBy'] !== '' ? $flag['setBy'] : 'someone', 'reason' => $flag['reason'], 'inChain' => $inChain];
}

/** Placeholder values of a context (escaped by discord_render unless listed in the raw keys) */
function discord_preserve_values(array $ctx) {
    $ends = $ctx['ends'] ?? null;
    $side = function ($end) { return $end ? discord_label_system($end['label'] ?? '', $end['system'] ?? '') : ''; };
    $from = $ends ? $side($ends['near']) : '';
    $to = $ends ? $side($ends['far']) : '';
    $hole = (string) ($ends['hole'] ?? '');
    $class = (string) ($ends['far']['class'] ?? '');
    $details = implode(', ', array_filter([$hole, $class], 'strlen'));
    $mapOf = $ends ? (($ends['near']['systemID'] ?? 0) >= 30000000 ? $ends['near']['systemID'] : (($ends['far']['systemID'] ?? 0) >= 30000000 ? $ends['far']['systemID'] : 0)) : 0;
    $reason = (string) ($ctx['reason'] ?? '');
    return [
        'pings' => $ctx['ping'] ?? '', 'mask' => $ctx['mask'] ?? '',
        'connection' => $ends ? $from . ' ↔ ' . $to : 'a wormhole', 'from' => $from, 'to' => $to,
        'hole' => $hole, 'class' => $class, 'details' => $details !== '' ? $details : '?',
        'sig' => (string) ($ends['sig'] ?? ''),
        'mass' => ['stable' => 'stable', 'destab' => 'destabilized', 'critical' => 'critical'][$ends['mass'] ?? ''] ?? '',
        'life' => ['stable' => 'stable', 'critical' => 'EOL'][$ends['life'] ?? ''] ?? '',
        'who' => $ctx['who'] ?? 'someone', 'reason' => $reason,
        // Built from escaped parts: ": home static" or empty
        'withReason' => $reason !== '' ? ': ' . discord_escape($reason) : '',
        'map' => $mapOf ? '<' . discord_map_url($mapOf) . '>' : '',
        'time' => discord_timestamp($ctx['time'] ?? time()),
    ];
}

/**
 * The webhook payload of a context: the mark (content only, no embed: it is edited in place), or with 'previous' (the
 * live message as last posted) the edit that ends it: 'cleared' (the cleared text) or 'changed' (a newer message was
 * posted: "Changed by *who* at <time>"). Such an edit has no pings in its text and pings nobody.
 */
function discord_preserve_payload(array $ctx) {
    $values = discord_preserve_values($ctx);
    $raw = ['pings', 'map', 'time', 'withReason', 'mark'];
    $cleared = !empty($ctx['cleared']);
    $ending = $cleared || !empty($ctx['changed']);
    $defaults = discord_default_templates();
    if (!$ending) {
        $template = $ctx['template'] ?? '';
        $values['mark'] = '';
        $content = discord_render($template, $values, $raw);
        if ($content === '') {
            $template = $defaults['preserveMass'];
            $content = discord_render($template, $values, $raw);
        }
        return ['username' => 'Tripwire', 'content' => $content, 'allowed_mentions' => discord_allowed_mentions($template, $ctx['ping'] ?? '')];
    }
    // {mark} goes in last (a marker until then), so a long struck text is what gets cut, never the who / when
    $marker = '{mark' . bin2hex(random_bytes(6)) . '}';
    $values['mark'] = $cleared ? $marker : '';
    $values['pings'] = '';
    if ($cleared) {
        $content = discord_render($ctx['templateClear'] ?? '', $values, $raw);
        if ($content === '' || $content === $marker) $content = discord_render($defaults['preserveMassClear'], $values, $raw);
    } else {
        $content = discord_render('Changed by *{who}* at {time}', $values, $raw);
    }
    $content = trim(discord_strip_mentions($content));
    if (strpos($content, $marker) === false) $content = $marker . "\n" . $content;
    $struck = discord_rally_strike($ctx['previous'] ?? '');
    $room = DISCORD_CONTENT_MAX - (mb_strlen($content) - mb_strlen($marker));
    if (mb_strlen($struck) > $room) $struck = $room > 6 ? discord_truncate($struck, $room - 2) . '~~' : '';
    $content = trim(str_replace($marker, $struck, $content));
    return ['content' => discord_truncate($content, DISCORD_CONTENT_MAX), 'allowed_mentions' => ['parse' => []]];
}

/** The live message of a hole: ['webhookID', 'messageID', 'content' (as last posted / edited), 'postedAt', 'clearedAt' (unix, 0 = live)] or null */
function discord_preserve_last(PDO $db, $maskID, $wormholeID) {
    $stmt = $db->prepare('SELECT * FROM discord_preserve_message WHERE maskID = ? AND wormholeID = ?');
    $stmt->execute([(string) $maskID, (int) $wormholeID]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    return ['webhookID' => (int) $row['webhookID'], 'messageID' => (string) $row['messageID'], 'content' => (string) $row['content'],
        'postedAt' => (int) strtotime($row['postedAt'] . ' UTC'), 'clearedAt' => empty($row['clearedAt']) ? 0 : (int) strtotime($row['clearedAt'] . ' UTC')];
}

/**
 * What the sender does with a row (pure). $ctx: discord_preserve_context, $live: the hole's message when it may be
 * edited (discord_rally_live: same webhook, posted after the type was turned on). Returns
 *   ['op' => 'skip', 'why' => ...]
 *   ['op' => 'post', 'payload' => ..., 'strike' => null | ['messageID', 'payload']]   a new message; then the old one ends
 *   ['op' => 'edit', 'payload' => ..., 'state' => 'live' | 'cleared' | 'revived']     edit the message
 * Edits never ping: no username (a message keeps its author), allowed_mentions empty.
 */
function discord_preserve_plan(array $ctx, $live, $now = null, $window = DISCORD_PRESERVE_WINDOW) {
    $now = $now ?? time();
    $struck = $live && !empty($live['clearedAt']);
    if (!empty($ctx['cleared'])) {
        if (!$live) return ['op' => 'skip', 'why' => 'no preserve mass message to edit'];
        if ($struck) return ['op' => 'skip', 'why' => 'the message is already struck through'];
        return ['op' => 'edit', 'payload' => discord_preserve_payload(['previous' => $live['content']] + $ctx), 'state' => 'cleared'];
    }
    $payload = discord_preserve_payload($ctx);
    $asEdit = function ($payload, $state) {
        unset($payload['username']);
        $payload['allowed_mentions'] = ['parse' => []];
        return ['op' => 'edit', 'payload' => $payload, 'state' => $state];
    };
    // Edits never notify: a change that pings someone the message didn't is a new message
    $quiet = $live && !discord_rally_new_mentions($payload['allowed_mentions'] ?? [], $payload['content'], $live['content']);
    if ($live && !$struck) {
        if ($payload['content'] === $live['content']) return ['op' => 'skip', 'why' => 'the message already shows this mark'];
        $age = $now - (int) $live['postedAt'];
        if ($quiet && $age >= 0 && $age < $window) return $asEdit($payload, 'live');
        // Later: a new message (the old one says it was changed)
        return ['op' => 'post', 'payload' => $payload,
            'strike' => ['messageID' => $live['messageID'], 'payload' => discord_preserve_payload(['changed' => true, 'previous' => $live['content']] + $ctx)]];
    }
    if ($struck) {
        // Marked again soon after the clear: the struck message comes back instead of a new one
        $since = $now - (int) $live['clearedAt'];
        if ($quiet && $since >= 0 && $since < $window) return $asEdit($payload, 'revived');
    }
    if (empty($ctx['inChain'])) return ['op' => 'skip', 'why' => 'not in the chain'];
    return ['op' => 'post', 'payload' => $payload, 'strike' => null];
}

function discord_preserve_remember(PDO $db, $maskID, $wormholeID, $webhookID, $messageID, $content, $now = null) {
    discord_preserve_forget($db, $maskID, $wormholeID);
    $db->prepare('INSERT INTO discord_preserve_message (maskID, wormholeID, webhookID, messageID, content, postedAt, clearedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        ->execute([(string) $maskID, (int) $wormholeID, (int) $webhookID, (string) $messageID, (string) $content, gmdate('Y-m-d H:i:s', $now ?? time())]);
}

function discord_preserve_forget(PDO $db, $maskID, $wormholeID) {
    $db->prepare('DELETE FROM discord_preserve_message WHERE maskID = ? AND wormholeID = ?')->execute([(string) $maskID, (int) $wormholeID]);
}

/** A webhook's URL was replaced (public/discord.php): its messages belong to the old URL, don't edit them */
function discord_preserve_forget_webhook(PDO $db, $webhookID) {
    $db->prepare('DELETE FROM discord_preserve_message WHERE webhookID = ?')->execute([(int) $webhookID]);
}

/** Forget old messages (worker, with the outbox prune): struck for a day, or posted DISCORD_PRESERVE_KEEP days ago */
function discord_preserve_prune(PDO $db, $now = null) {
    $now = $now ?? time();
    $stmt = $db->prepare('DELETE FROM discord_preserve_message WHERE (clearedAt IS NOT NULL AND clearedAt < ?) OR postedAt < ?');
    $stmt->execute([gmdate('Y-m-d H:i:s', $now - 86400), gmdate('Y-m-d H:i:s', $now - DISCORD_PRESERVE_KEEP * 86400)]);
    return $stmt->rowCount();
}

/** Whether a newer row of the same hole is queued (then this one is skipped: the newer one shows the flag as it is then) */
function discord_preserve_superseded(PDO $db, array $row) {
    $wormholeID = (int) (json_decode($row['data'], true)['wormholeID'] ?? 0);
    $stmt = $db->prepare("SELECT data FROM discord_outbox WHERE maskID = ? AND kind = 'preserveMass' AND status = 'queued' AND id > ?");
    $stmt->execute([(string) $row['maskID'], (int) $row['id']]);
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $data) {
        if ((int) (json_decode($data, true)['wormholeID'] ?? 0) === $wormholeID) return true;
    }
    return false;
}

/** Message context of an outbox row: the flag and the hole as stored now, the chain when the type is limited to it */
function discord_preserve_row_context(PDO $db, $maskID, array $data) {
    $wormholeID = (int) ($data['wormholeID'] ?? 0);
    $flag = discord_preserve_flag($db, $maskID, $wormholeID);
    $hole = discord_preserve_hole($db, $maskID, $wormholeID);
    $ends = $hole ? discord_preserve_ends($hole, function ($systemID) use ($db, $maskID) { return discord_chain_label($db, $maskID, $systemID); }, (int) ($data['homeSystemID'] ?? 0)) : null;
    $chain = !empty($data['chainOnly']) ? discord_chain_systems_cached($db, $maskID, (int) ($data['homeSystemID'] ?? 0)) : null;
    return discord_preserve_context($data, $flag, $ends, $chain);
}

/**
 * How the sender sends a row ('preserveMass': a change; 'preserveMassEdit': the edit that ends a changed mark's old
 * message): ['method', 'url', 'payload', 'plan'] or ['skip' => why]. $url: the webhook's URL, $context: the row's context.
 */
function discord_preserve_request(PDO $db, array $row, $url, array $context, $now = null) {
    if ($row['kind'] === 'preserveMassEdit') {
        $edit = discord_webhook_edit_url($url, $context['messageID'] ?? '');
        if ($edit === null || empty($context['payload']['content'])) return ['skip' => 'unreadable edit'];
        return ['method' => 'PATCH', 'url' => $edit, 'payload' => $context['payload'], 'plan' => null];
    }
    // Same rule as Fight here's: the same webhook, posted after the type was (last) turned on (clearedAt comes along)
    $live = discord_rally_live(discord_preserve_last($db, $row['maskID'], $context['wormholeID'] ?? 0), $row['webhookID'], $context['enabledAt'] ?? 0);
    $plan = discord_preserve_plan($context, $live, $now) + ['wormholeID' => (int) ($context['wormholeID'] ?? 0)];
    if ($plan['op'] === 'skip') return ['skip' => $plan['why']];
    if ($plan['op'] === 'edit') return ['method' => 'PATCH', 'url' => discord_webhook_edit_url($url, $live['messageID']), 'payload' => $plan['payload'], 'plan' => $plan];
    return ['method' => 'POST', 'url' => discord_webhook_send_url($url), 'payload' => $plan['payload'], 'plan' => $plan];
}

/**
 * After a request (discord_preserve_request): remember a new message and its text, queue the edit that ends the old
 * one (changed), keep the text of a live edit, note when a message was struck through / brought back. An edit of a
 * message deleted in Discord (404, code 10008) is forgotten: a mark becomes 'repost', anything else 'skipped'.
 */
function discord_preserve_after_send(PDO $db, array $row, array $request, $status, $body, array $decision, $now = null) {
    $now = $now ?? time();
    $plan = $request['plan'] ?? null;
    if ($request['method'] === 'PATCH' && $status === 404 && discord_error_code($body) === 10008) {
        if ($row['kind'] === 'preserveMassEdit') return ['result' => 'skipped', 'delay' => 0, 'error' => 'the old preserve mass message was deleted in Discord'];
        discord_preserve_forget($db, $row['maskID'], $plan['wormholeID'] ?? 0);
        if ($plan && ($plan['state'] ?? '') !== 'cleared') return ['result' => 'repost', 'delay' => 0, 'error' => 'the preserve mass message was deleted in Discord; posting a new one'];
        return ['result' => 'skipped', 'delay' => 0, 'error' => 'the preserve mass message was deleted in Discord; nothing to edit'];
    }
    if ($decision['result'] !== 'sent' || !$plan) return $decision;
    $wormholeID = (int) ($plan['wormholeID'] ?? 0);
    if ($request['method'] === 'POST') {
        if (!empty($plan['strike'])) discord_enqueue($db, (string) $row['maskID'], (int) $row['webhookID'], 'preserveMassEdit', $plan['strike'], DISCORD_PRIORITY_PRESERVE);
        $message = json_decode((string) $body, true);
        $id = is_array($message) && isset($message['id']) ? (string) $message['id'] : '';
        if (preg_match('/^\d{1,32}$/', $id)) discord_preserve_remember($db, $row['maskID'], $wormholeID, $row['webhookID'], $id, $request['payload']['content'] ?? '', $now);
        else discord_preserve_forget($db, $row['maskID'], $wormholeID);
    } elseif ($plan['state'] === 'cleared') {
        $db->prepare('UPDATE discord_preserve_message SET clearedAt = ? WHERE maskID = ? AND wormholeID = ?')
            ->execute([gmdate('Y-m-d H:i:s', $now), (string) $row['maskID'], $wormholeID]);
    } else {
        // A live edit keeps the window of its post; a message brought back after a clear starts a new one
        $sql = $plan['state'] === 'revived' ? 'UPDATE discord_preserve_message SET content = ?, clearedAt = NULL, postedAt = ? WHERE maskID = ? AND wormholeID = ?'
            : 'UPDATE discord_preserve_message SET content = ? WHERE maskID = ? AND wormholeID = ?';
        $params = $plan['state'] === 'revived' ? [$request['payload']['content'] ?? '', gmdate('Y-m-d H:i:s', $now), (string) $row['maskID'], $wormholeID]
            : [$request['payload']['content'] ?? '', (string) $row['maskID'], $wormholeID];
        $db->prepare($sql)->execute($params);
    }
    return $decision;
}
