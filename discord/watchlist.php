<?php
// Fork-owned: notification type 6, "Watchlist match" (see discord/discord.inc.php and watchlist/watchlist.inc.php).
//
// discord_notify.worker.php matches the mask's watchlist filters (set by the corporation's admins in Mask Admin >
// Watchlist) against the mask's chain, every wormhole of the mask, on the same 15 s cadence as the k-space type, so
// Discord hears about a match even when nobody has Tripwire open. A match is announced once per (filter, system,
// hole): the hole is the oldest live connection of the system that makes the match (any of its connections for
// filters on the system only, the ones fitting the hole conditions otherwise), so a second way into the same system
// doesn't announce it again. Only holes changed after the type was turned on and after the filter was last saved
// count, so turning the type on or saving a filter never announces what was already on the chain. Filters with
// "jumps from you / from home" are skipped: those depend on who is looking.

const DISCORD_WATCHLIST_MAX_PER_POLL = 20;   // messages per mask per poll; the rest wait for the next poll

/** Effect names as the app shows them ('Wolf-Rayet Star' -> 'Wolf-Rayet') */
function discord_watchlist_effect($effect) {
    $effect = (string) $effect;
    return $effect === 'Wolf-Rayet Star' ? 'Wolf-Rayet' : $effect;
}

/**
 * New watchlist matches of one mask's chain: [[filter, systemID, link, ref], ...]. $filters: the mask's filters
 * (watchlist_load), $links: watchlist_mask_links, $enabledAt: when the type was turned on (unix).
 */
function discord_watchlist_candidates(array $filters, array $links, array $data, $enabledAt, $tz = null) {
    $usable = array_values(array_filter($filters, function ($f) {
        return $f['enabled'] && watchlist_has_conditions($f['conditions']) && !watchlist_uses_location($f['conditions']);
    }));
    if (!$usable || !$links) return [];
    $byID = [];
    foreach ($links as $link) $byID[$link['wormholeID']] = $link;
    $filtersByID = [];
    foreach ($usable as $f) $filtersByID[$f['id']] = $f;
    $out = [];
    foreach (watchlist_match($usable, watchlist_entries_from_links([], $links), $data) as $match) {
        $filter = $filtersByID[$match['filterID']];
        $oldest = null;
        foreach ($match['wormholeIDs'] as $id) {
            $link = $byID[$id] ?? null;
            if ($link && ($oldest === null || [$link['changed'], $link['wormholeID']] < [$oldest['changed'], $oldest['wormholeID']])) $oldest = $link;
        }
        if (!$oldest) continue;
        $since = max((int) $enabledAt, (int) ($filter['updatedAt'] ?? 0));
        if (!discord_kspace_after_enable($oldest['changed'], $since, $tz)) continue;   // on the chain before: not news
        $ref = 'wl:' . $filter['id'] . ':' . $match['systemID'] . ':' . $oldest['wormholeID'];
        $out[] = [$filter, $match['systemID'], $oldest, $ref];
    }
    return $out;
}

/** Message context of a match: the system, and the hole into it (its signature in the system on the other side) */
function discord_watchlist_context(array $filter, $systemID, array $link, array $type, $maskName, array $data) {
    $system = discord_system($systemID);
    $info = $data['systems'][$systemID] ?? [];
    $near = (int) $link['a'] === (int) $systemID ? 'a' : 'b';
    $far = $near === 'a' ? 'b' : 'a';
    // The real type was scanned on one side; seen from the far side's signature, the hole is that type or a K162
    $hole = $link['typedSide'] === $far ? ($link['type'] ?? '') : 'K162';
    $from = $link[$far] ? discord_system_name($link[$far]) : 'an unknown system';
    $effect = discord_watchlist_effect($info['effect'] ?? '');
    return [
        'kind' => 'watchlist', 'template' => $type['template'], 'ping' => $type['ping'], 'mask' => $maskName,
        'filter' => $filter['name'], 'systemID' => (int) $systemID, 'system' => $system ? $system[0] : (string) $systemID,
        // Wormhole space has no meaningful security status: the class is shown instead
        'security' => $system && !$system[4] ? $system[1] : null, 'class' => discord_system_class($systemID),
        'effect' => $effect, 'region' => $system ? discord_region_name($system[2]) : '',
        'map' => discord_map_url($systemID), 'dotlan' => discord_dotlan_url($systemID),
        'sig' => discord_sig_text($link[$far . 'Sig']), 'hole' => $hole, 'from' => $from,
        'time' => time(),
    ];
}

/**
 * One poll over the masks with the type on ($masks: maskID => settings). Queues one message per new match, at most
 * DISCORD_WATCHLIST_MAX_PER_POLL per mask. Returns the number of messages queued.
 */
function discord_watchlist_poll(PDO $db, array $masks) {
    $queued = 0;
    $data = null;
    foreach ($masks as $maskID => $settings) {
        $type = $settings['types']['watchlist'] ?? null;
        if (!$type || !$type['enabled'] || $type['webhookID'] <= 0) continue;
        $maskID = (string) $maskID;
        $filters = discord_watchlist_filters($db, $maskID);
        if (!$filters) continue;
        $data = $data ?? watchlist_data();
        $candidates = discord_watchlist_candidates($filters, watchlist_mask_links($db, $maskID, $data), $data, $type['enabledAt'] ?? 0);
        $count = 0;
        foreach ($candidates as [$filter, $systemID, $link, $ref]) {
            if ($count >= DISCORD_WATCHLIST_MAX_PER_POLL) break;
            $context = discord_watchlist_context($filter, $systemID, $link, $type, discord_mask_name($db, $maskID), $data);
            $claim = function () use ($db, $maskID, $ref) { return discord_dedupe_once($db, $maskID, 'watchlist', $ref); };
            if (discord_enqueue_once($db, $maskID, $type['webhookID'], 'watchlist', $context, $claim) === null) continue;
            $count++;
            discord_log(sprintf('queued watchlist "%s": %s for mask %s', $filter['name'], $context['system'], $maskID));
        }
        $queued += $count;
    }
    return $queued;
}

/** A mask's filters; none when the table doesn't exist yet */
function discord_watchlist_filters(PDO $db, $maskID) {
    try {
        return watchlist_load($db, $maskID);
    } catch (PDOException $error) {
        if ($error->getCode() !== '42S02') throw $error;
        return [];
    }
}
