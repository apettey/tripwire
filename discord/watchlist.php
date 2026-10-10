<?php
// Fork-owned: notification type 6, "Watchlist match" (see discord/discord.inc.php and watchlist/watchlist.inc.php).
//
// discord_notify.worker.php matches the mask's watchlist filters (set by the corporation's admins in Mask Admin >
// Watchlist) against the mask's chain, every wormhole of the mask, on the same 15 s cadence as the k-space type, so
// Discord hears about a match even when nobody has Tripwire open. Filters with "jumps from you / from home" are
// skipped: those depend on who is looking.
//
// What is new is decided from what the worker has seen, never from edit times (every edit of a hole rewrites its
// signatures' modifiedTime): per filter, every (system, hole) that made a match is remembered in
// fork_watchlist_seen for as long as the hole exists. On the first poll after the type was turned on, or after the
// filter was saved or turned on (the baseline's stamp changed), the chain's current matches are recorded without
// announcing anything. Afterwards a match is announced when none of its holes was seen before: a second way into a
// system already announced isn't news, a system reached again after all its holes collapsed is. A hole is
// forgotten when it is gone from the chain, a filter's records when it is paused or deleted.

const DISCORD_WATCHLIST_MAX_PER_POLL = 20;   // messages per mask per poll; the rest wait for the next poll

/** Effect names as the app shows them ('Wolf-Rayet Star' -> 'Wolf-Rayet') */
function discord_watchlist_effect($effect) {
    $effect = (string) $effect;
    return $effect === 'Wolf-Rayet Star' ? 'Wolf-Rayet' : $effect;
}

/**
 * The mask's current matches for the Discord type: [[filter, systemID, wormholeIDs (ascending)], ...], only enabled
 * filters with conditions and without jump limits, only matches made by at least one hole.
 */
function discord_watchlist_matches(array $filters, array $links, array $data) {
    $usable = discord_watchlist_usable($filters);
    if (!$usable || !$links) return [];
    $filtersByID = [];
    foreach ($usable as $f) $filtersByID[$f['id']] = $f;
    $out = [];
    foreach (watchlist_match($usable, watchlist_entries_from_links([], $links), $data) as $match) {
        $ids = array_values(array_unique(array_map('intval', $match['wormholeIDs'])));
        if (!$ids) continue;
        sort($ids);
        $out[] = [$filtersByID[$match['filterID']], (int) $match['systemID'], $ids];
    }
    return $out;
}

/** Filters the server can evaluate: enabled, with conditions, without "jumps from you / from home" */
function discord_watchlist_usable(array $filters) {
    return array_values(array_filter($filters, function ($f) {
        return $f['enabled'] && watchlist_has_conditions($f['conditions']) && !watchlist_uses_location($f['conditions']);
    }));
}

/** What a filter's records were made for: the type's enabledAt and the filter's updatedAt (saved / turned on) */
function discord_watchlist_stamp(array $filter, $enabledAt) {
    return (int) $enabledAt . ':' . (int) ($filter['updatedAt'] ?? 0);
}

/** Record a (filter, system, hole) as seen; false when it already was */
function discord_watchlist_see(PDO $db, $maskID, $filterID, $systemID, $wormholeID) {
    try {
        $db->prepare('INSERT INTO fork_watchlist_seen (maskID, filterID, systemID, wormholeID, createdAt) VALUES (?, ?, ?, ?, ?)')
            ->execute([(string) $maskID, (string) $filterID, (int) $systemID, (int) $wormholeID, gmdate('Y-m-d H:i:s')]);
        return true;
    } catch (PDOException $error) {
        if ((string) $error->getCode() === '23000') return false;   // duplicate key: seen before
        throw $error;
    }
}

/**
 * Bring a mask's records up to date with its chain and return the matches to announce:
 * [[filter, systemID, link (the oldest of its holes), wormholeIDs], ...]. Forgets holes that are gone and filters that
 * are paused or deleted, records a new baseline for filters whose stamp changed (announcing none of their matches),
 * and silently records new holes of matches that were already seen. Announced matches are recorded by
 * discord_watchlist_claim when they are queued.
 */
function discord_watchlist_sync(PDO $db, $maskID, array $filters, array $links, array $data, $enabledAt) {
    $maskID = (string) $maskID;
    $usable = [];
    foreach (discord_watchlist_usable($filters) as $f) $usable[$f['id']] = $f;
    $live = [];
    foreach ($links as $link) $live[(int) $link['wormholeID']] = $link;

    $stmt = $db->prepare('SELECT filterID, stamp FROM fork_watchlist_baseline WHERE maskID = ?');
    $stmt->execute([$maskID]);
    $stamps = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $stamps[(string) $row['filterID']] = (string) $row['stamp'];
    $stmt = $db->prepare('SELECT filterID, systemID, wormholeID FROM fork_watchlist_seen WHERE maskID = ?');
    $stmt->execute([$maskID]);
    $seen = [];
    $gone = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $id = (int) $row['wormholeID'];
        if (!isset($live[$id])) { $gone[$id] = true; continue; }
        $seen[(string) $row['filterID']][(int) $row['systemID']][$id] = true;
    }
    // Forget holes that are gone (a hole mapped again later is a new wormhole) and filters that are paused / deleted
    foreach (array_keys($gone) as $id) {
        $db->prepare('DELETE FROM fork_watchlist_seen WHERE maskID = ? AND wormholeID = ?')->execute([$maskID, $id]);
    }
    foreach (array_unique(array_merge(array_keys($stamps), array_keys($seen))) as $filterID) {
        if (isset($usable[$filterID])) continue;
        $db->prepare('DELETE FROM fork_watchlist_seen WHERE maskID = ? AND filterID = ?')->execute([$maskID, $filterID]);
        $db->prepare('DELETE FROM fork_watchlist_baseline WHERE maskID = ? AND filterID = ?')->execute([$maskID, $filterID]);
        unset($stamps[$filterID], $seen[$filterID]);
    }

    $byFilter = [];
    foreach (discord_watchlist_matches(array_values($usable), $links, $data) as $match) $byFilter[$match[0]['id']][] = $match;
    $out = [];
    foreach ($usable as $filterID => $filter) {
        $matches = $byFilter[$filterID] ?? [];
        $stamp = discord_watchlist_stamp($filter, $enabledAt);
        if (($stamps[$filterID] ?? null) !== $stamp) {
            // Turned on, saved or seen for the first time: what is on the chain now is the baseline, not news
            $db->beginTransaction();
            try {
                $db->prepare('DELETE FROM fork_watchlist_seen WHERE maskID = ? AND filterID = ?')->execute([$maskID, $filterID]);
                $db->prepare('DELETE FROM fork_watchlist_baseline WHERE maskID = ? AND filterID = ?')->execute([$maskID, $filterID]);
                foreach ($matches as [, $systemID, $ids]) foreach ($ids as $id) discord_watchlist_see($db, $maskID, $filterID, $systemID, $id);
                $db->prepare('INSERT INTO fork_watchlist_baseline (maskID, filterID, stamp, createdAt) VALUES (?, ?, ?, ?)')
                    ->execute([$maskID, $filterID, $stamp, gmdate('Y-m-d H:i:s')]);
                $db->commit();
            } catch (Throwable $error) {
                if ($db->inTransaction()) $db->rollBack();
                throw $error;
            }
            continue;
        }
        foreach ($matches as [$f, $systemID, $ids]) {
            $known = $seen[$filterID][$systemID] ?? [];
            $new = array_values(array_filter($ids, function ($id) use ($known) { return !isset($known[$id]); }));
            if (!$new) continue;
            if (count($new) < count($ids)) {
                // Another way into a system already matched: remember the hole, nothing to announce
                foreach ($new as $id) discord_watchlist_see($db, $maskID, $filterID, $systemID, $id);
                continue;
            }
            $out[] = [$f, $systemID, $live[$ids[0]], $ids];
        }
    }
    return $out;
}

/** Record an announced match's holes; false (nothing recorded) when its first hole was already recorded */
function discord_watchlist_claim(PDO $db, $maskID, $filterID, $systemID, array $ids) {
    if (!discord_watchlist_see($db, $maskID, $filterID, $systemID, $ids[0])) return false;
    foreach (array_slice($ids, 1) as $id) discord_watchlist_see($db, $maskID, $filterID, $systemID, $id);
    return true;
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
        $data = $data ?? watchlist_data();
        // No filters: no need to read the chain, the sync only forgets what was recorded
        $links = $filters ? watchlist_mask_links($db, $maskID, $data) : [];
        $candidates = discord_watchlist_sync($db, $maskID, $filters, $links, $data, $type['enabledAt'] ?? 0);
        $count = 0;
        foreach ($candidates as [$filter, $systemID, $link, $ids]) {
            if ($count >= DISCORD_WATCHLIST_MAX_PER_POLL) break;   // not recorded: the next poll announces it
            $context = discord_watchlist_context($filter, $systemID, $link, $type, discord_mask_name($db, $maskID), $data);
            $claim = function () use ($db, $maskID, $filter, $systemID, $ids) { return discord_watchlist_claim($db, $maskID, $filter['id'], $systemID, $ids); };
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
