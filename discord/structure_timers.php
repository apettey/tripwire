<?php
// Fork-owned: notification type 9, "Structure timers" (see discord/discord.inc.php, structures/structures.inc.php).
//
// The Structures panel keeps one timer per structure (fork_structures.timerAt, UTC). discord_notify.worker.php polls
// the masks with this type on (same leader and 15 s cadence as the watchlist) and posts a reminder before a timer ends:
// the leads the admin ticked (24 h, 1 h, 15 m before, and at the end). Rules:
//   - one message per (structure, timer end, lead): the dedupe row is discord_sent(maskID, 'stimer', "<id>:<unix timerAt>:<lead>");
//     a changed timer end is a new ref, so it fires afresh;
//   - missed leads: of the leads that are due only the most recent one fires (a timer added 30 minutes before its end sends
//     the 15 m reminder, not 24 h and 1 h), and only while now < timerAt + 5 minutes;
//   - leads that fell due before the type was turned on (enabledAt) or before the timer was set (timerSetAt) are skipped;
//   - timers are posted whether or not their system is in the chain (no chainOnly); hostileOnly (off by default) skips
//     structures whose owner is one of the mask's own corporations / alliances (Mask Admin > Discord, "our" side);
//   - gone structures (destroyed / removed) are never posted.
// Game text (structure, owner, system, notes) is escaped like every other type. This file only reads the database.

const DISCORD_STIMER_LEADS    = [1440, 60, 15, 0];   // minutes before the timer ends the admin can tick ("0": at the end)
const DISCORD_STIMER_GRACE    = 300;                 // seconds after the end a reminder may still be sent
const DISCORD_PRIORITY_STIMER = 14;                  // after preserve mass / rolling (15), before kills and k-space (10)
const DISCORD_STIMER_KIND     = 'stimer';            // discord_sent kind

/** The mask's type when it is turned on with a webhook, else null. $settings: normalised settings. */
function discord_structure_timer_type(array $settings) {
    $type = $settings['types']['structureTimer'] ?? null;
    return $type && $type['enabled'] && $type['webhookID'] > 0 && $type['leads'] ? $type : null;
}

/** "in 24h", "in 1h", "in 15m", "now" */
function discord_structure_timer_lead_text($lead) {
    $lead = (int) $lead;
    if ($lead <= 0) return 'now';
    if ($lead < 60) return 'in ' . $lead . 'm';
    return 'in ' . intdiv($lead, 60) . 'h' . ($lead % 60 ? ' ' . ($lead % 60) . 'm' : '');
}

/**
 * The lead to send for a timer now, or null (pure). $leads: minutes. Only the most recent due lead counts; leads whose time
 * was before $enabledAt or $timerSetAt are skipped, nothing is sent from timerAt + 5 minutes on.
 */
function discord_structure_timer_due_lead($timerAt, $timerSetAt, array $leads, $now, $enabledAt = 0) {
    if ($now >= $timerAt + DISCORD_STIMER_GRACE) return null;
    $best = null;
    foreach ($leads as $lead) {
        $lead = (int) $lead;
        $fires = $timerAt - $lead * 60;
        if ($fires > $now) continue;                                  // not due yet
        if ($fires < (int) $enabledAt || $fires < (int) $timerSetAt) continue;   // fell due before it could be announced
        if ($best === null || $lead < $best) $best = $lead;
    }
    return $best;
}

/** Whether a reminder was already queued (its dedupe row exists): checked before any message is built, every poll */
function discord_structure_timer_sent(PDO $db, $maskID, $ref) {
    $stmt = $db->prepare('SELECT 1 FROM discord_sent WHERE maskID = ? AND kind = ? AND ref = ?');
    $stmt->execute([(string) $maskID, DISCORD_STIMER_KIND, substr((string) $ref, 0, 64)]);
    return (bool) $stmt->fetchColumn();
}

/** Unix time of a UTC 'Y-m-d H:i:s' column, or null */
function discord_structure_timer_unix($value) {
    if ($value === null || $value === '') return null;
    $time = strtotime($value . ' UTC');
    return $time === false ? null : $time;
}

/** Live structures of a mask whose timer ends between 5 minutes ago and $horizon seconds from now. [] without the table. */
function discord_structure_timer_rows(PDO $db, $maskID, $now, $horizon) {
    try {
        $stmt = $db->prepare('SELECT id, systemID, typeName, name, ownerID, ownerType, ownerName, ownerTicker, ownerText, timerKind, timerAt, timerSetAt, timerSetBy, note
            FROM fork_structures WHERE maskID = ? AND goneAt IS NULL AND timerAt IS NOT NULL AND timerAt >= ? AND timerAt <= ? ORDER BY timerAt, id');
        $stmt->execute([(string) $maskID, gmdate('Y-m-d H:i:s', $now - DISCORD_STIMER_GRACE), gmdate('Y-m-d H:i:s', $now + $horizon)]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        if ((string) $error->getCode() === '42S02' || stripos($error->getMessage(), 'no such table') !== false) return [];
        throw $error;
    }
    foreach ($rows as &$row) {
        $row['timerAt'] = discord_structure_timer_unix($row['timerAt']);
        $row['timerSetAt'] = (int) discord_structure_timer_unix($row['timerSetAt']);
    }
    unset($row);
    return $rows;
}

/** Whether the structure's resolved owner is on the mask's own side (Mask Admin > Discord corporations / alliances) */
function discord_structure_timer_is_ours(array $row, array $settings) {
    if ($row['ownerID'] === null) return false;
    $ours = $row['ownerType'] === 'alliance' ? ($settings['alliances'] ?? []) : ($settings['corporations'] ?? []);
    return in_array((int) $row['ownerID'], array_map('intval', $ours), true);
}

const DISCORD_STIMER_KINDS = ['armor' => 'Armor timer', 'hull' => 'Hull timer', 'pos' => 'POS timer', 'anchoring' => 'Anchoring ends',
    'unanchoring' => 'Unanchoring ends', 'fuel' => 'Fuel runs out', 'other' => 'Timer'];

/**
 * What {chainLabel} says: the system's chain label, "home" for the home system, "in chain" for a connected system without
 * a label, and '' (shown as "not in chain") for any other system or when the mask has no home. $chain: systemID => true.
 */
function discord_structure_timer_chain_text($systemID, $homeID, array $chain, $label) {
    if ((int) $homeID <= 0 || !isset($chain[(int) $systemID])) return '';
    if ($label !== '') return $label;
    return (int) $systemID === (int) $homeID ? 'home' : 'in chain';
}

/** Message context of a reminder (outbox data) */
function discord_structure_timer_context(array $row, array $type, $lead, $maskName, $chainLabel, $now) {
    $system = discord_system($row['systemID']);
    $owner = $row['ownerID'] !== null
        ? trim(($row['ownerTicker'] !== null && $row['ownerTicker'] !== '' ? '[' . $row['ownerTicker'] . '] ' : '') . (string) $row['ownerName'])
        : (string) $row['ownerText'];
    return [
        'kind' => 'structureTimer', 'template' => $type['template'], 'ping' => $type['ping'], 'mask' => $maskName,
        'systemID' => (int) $row['systemID'], 'system' => $system ? $system[0] : (string) $row['systemID'],
        'chainLabel' => (string) $chainLabel, 'structure' => $row['name'] !== '' ? $row['name'] : $row['typeName'], 'type' => $row['typeName'],
        'owner' => $owner !== '' ? $owner : 'unknown owner', 'timer' => DISCORD_STIMER_KINDS[$row['timerKind']] ?? 'Timer',
        'timerAt' => (int) $row['timerAt'], 'lead' => (int) $lead, 'setBy' => (string) $row['timerSetBy'], 'note' => (string) $row['note'],
        'map' => discord_map_url($row['systemID']), 'time' => $now,
    ];
}

/** The webhook payload (plain text, no embed) */
function discord_structure_timer_payload(array $ctx) {
    $at = (int) ($ctx['timerAt'] ?? 0);
    $label = (string) ($ctx['chainLabel'] ?? '');
    $values = [
        'pings' => $ctx['ping'] ?? '', 'mask' => $ctx['mask'] ?? '', 'system' => $ctx['system'] ?? '',
        // built from escaped parts: the parentheses stay plain
        'chainLabel' => '(' . ($label === '' ? 'not in chain' : discord_escape($label)) . ')',
        'structure' => $ctx['structure'] ?? '', 'type' => $ctx['type'] ?? '', 'owner' => $ctx['owner'] ?? '', 'timer' => $ctx['timer'] ?? '',
        'endsEve' => $at ? gmdate('Y-m-d H:i', $at) : '', 'endsRelative' => $at ? discord_timestamp($at, 'R') : '',
        'lead' => discord_structure_timer_lead_text($ctx['lead'] ?? 0), 'setBy' => $ctx['setBy'] ?? '', 'note' => $ctx['note'] ?? '',
        'map' => isset($ctx['map']) ? '<' . $ctx['map'] . '>' : '',
    ];
    $raw = ['pings', 'map', 'chainLabel', 'endsRelative', 'endsEve'];   // digits and a dash: nothing to escape
    $template = $ctx['template'] ?? '';
    $content = discord_render($template, $values, $raw);
    if ($content === '') {
        $template = discord_default_templates()['structureTimer'];
        $content = discord_render($template, $values, $raw);
    }
    return ['username' => 'Tripwire', 'content' => $content, 'allowed_mentions' => discord_allowed_mentions($template, $ctx['ping'] ?? '')];
}

/**
 * One poll over the masks with the type on ($masks: maskID => settings; $now: unix time, default now). Queues the due
 * reminders (once each, see the file header) and returns how many.
 */
function discord_structure_timer_poll(PDO $db, array $masks, $now = null) {
    $now = $now ?? time();
    $queued = 0;
    foreach ($masks as $maskID => $settings) {
        $type = discord_structure_timer_type($settings);
        if (!$type) continue;
        $maskID = (string) $maskID;
        $homeID = (int) ($settings['homeSystemID'] ?? 0);
        $chain = null;   // read when the first reminder is due
        $rows = discord_structure_timer_rows($db, $maskID, $now, max($type['leads']) * 60 + 60);
        foreach ($rows as $row) {
            if ($type['hostileOnly'] && discord_structure_timer_is_ours($row, $settings)) continue;
            $lead = discord_structure_timer_due_lead($row['timerAt'], $row['timerSetAt'], $type['leads'], $now, $type['enabledAt'] ?? 0);
            if ($lead === null) continue;
            $ref = $row['id'] . ':' . $row['timerAt'] . ':' . $lead;
            if (discord_structure_timer_sent($db, $maskID, $ref)) continue;   // nothing is built for what was already sent
            $chain = $chain ?? ($homeID > 0 ? discord_chain_systems_cached($db, $maskID, $homeID, $now) : []);
            $chainText = discord_structure_timer_chain_text($row['systemID'], $homeID, $chain, discord_chain_label($db, $maskID, $row['systemID']));
            $context = discord_structure_timer_context($row, $type, $lead, discord_mask_name($db, $maskID), $chainText, $now);
            $claim = function () use ($db, $maskID, $ref) { return discord_dedupe_once($db, $maskID, DISCORD_STIMER_KIND, $ref); };
            if (discord_enqueue_once($db, $maskID, $type['webhookID'], 'structureTimer', $context, $claim, DISCORD_PRIORITY_STIMER) === null) {
                // No dedupe row afterwards: the claim was rolled back because the mask's outbox is full; stop for this mask, the next poll
                // tries again. A row: another worker claimed it between the check and now, nothing is wrong, go on.
                if (discord_structure_timer_sent($db, $maskID, $ref)) {
                    discord_log(sprintf('structure timers: %s was queued by another process, mask %s', $ref, $maskID));
                    continue;
                }
                discord_log(sprintf('structure timers: outbox of mask %s is full, %s waits for the next poll', $maskID, $ref));
                break;
            }
            $queued++;
            discord_log(sprintf('queued structure timer %s: %s in %s for mask %s', $ref, $row['typeName'], $context['system'], $maskID));
        }
    }
    return $queued;
}
