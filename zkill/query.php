<?php
// Fork-owned: read side of the zKillboard integration for web endpoints (see zkill/zkill.inc.php).
// Nothing here makes an outgoing request; at most it queues back-fills and names for the worker.

const ZK_KILL_COLUMNS = 'id, killID, systemID, killTime, victimCharacterID, victimCorporationID, victimAllianceID, victimShipTypeID,
    finalBlowCharacterID, finalBlowCorporationID, finalBlowAllianceID, finalBlowShipTypeID,
    attackerCount, attackerTotal, totalValue, npc, solo, awox';

/** Kills in the given systems since $fromUnix, newest first (by kill time), at most $limit */
function zk_query_kills(PDO $db, array $systemIDs, $fromUnix, $limit) {
    if (!$systemIDs) return [];
    $stmt = $db->prepare('SELECT ' . ZK_KILL_COLUMNS . ' FROM zkill_killmails
        WHERE systemID IN (' . implode(',', array_fill(0, count($systemIDs), '?')) . ') AND killTime >= ?
        ORDER BY killTime DESC, killID DESC
        LIMIT ' . (int) $limit);
    $stmt->execute(array_merge(array_values($systemIDs), [gmdate('Y-m-d H:i:s', $fromUnix)]));
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/** Kills stored after cursor $since (exclusive) up to $latest (inclusive) in the systems, oldest stored first */
function zk_query_kills_since(PDO $db, array $systemIDs, $fromUnix, $since, $latest, $limit) {
    if (!$systemIDs || $since >= $latest) return [];
    $stmt = $db->prepare('SELECT ' . ZK_KILL_COLUMNS . ' FROM zkill_killmails
        WHERE id > ? AND id <= ? AND systemID IN (' . implode(',', array_fill(0, count($systemIDs), '?')) . ') AND killTime >= ?
        ORDER BY id ASC
        LIMIT ' . (int) $limit);
    $stmt->execute(array_merge([$since, $latest], array_values($systemIDs), [gmdate('Y-m-d H:i:s', $fromUnix)]));
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/** API shape of a zkill_killmails row */
function zk_kill_json(array $row) {
    $int = function ($value) { return $value === null ? null : (int) $value; };
    return [
        'id'            => (int) $row['id'],
        'killID'        => (int) $row['killID'],
        'systemID'      => (int) $row['systemID'],
        'killTime'      => zk_iso($row['killTime']),
        'victim'        => [
            'characterID'   => $int($row['victimCharacterID']),
            'corporationID' => $int($row['victimCorporationID']),
            'allianceID'    => $int($row['victimAllianceID']),
            'shipTypeID'    => $int($row['victimShipTypeID']),
        ],
        'finalBlow'     => [
            'characterID'   => $int($row['finalBlowCharacterID']),
            'corporationID' => $int($row['finalBlowCorporationID']),
            'allianceID'    => $int($row['finalBlowAllianceID']),
            'shipTypeID'    => $int($row['finalBlowShipTypeID']),
        ],
        'attackerCount' => (int) $row['attackerCount'],
        'attackerTotal' => (int) $row['attackerTotal'],
        'totalValue'    => (float) $row['totalValue'],
        'npc'           => (bool) $row['npc'],
        'solo'          => (bool) $row['solo'],
        'awox'          => (bool) $row['awox'],
    ];
}

/**
 * Stream status: enabled; coveredSince / highWater (ISO): the stream has every kill between them; lagSeconds:
 * how far the high-water mark trails now; caughtUp / live: lag within ZK_STREAM_LAG_TOLERANCE.
 */
function zk_feed_status(PDO $db, $now) {
    [$since, $highWater] = zk_stream_window($db);
    $lag = $highWater === null ? null : max(0, $now - $highWater);
    $caughtUp = $lag !== null && $lag <= ZK_STREAM_LAG_TOLERANCE;
    return [
        'enabled' => zk_feed_enabled(),
        'live' => zk_feed_enabled() && $caughtUp,
        'caughtUp' => $caughtUp,
        'lagSeconds' => $lag,
        'coveredSince' => $since === null ? null : gmdate('Y-m-d\TH:i:s\Z', $since),
        'highWater' => $highWater === null ? null : gmdate('Y-m-d\TH:i:s\Z', $highWater),
    ];
}

/**
 * Response of public/system_kills.php (also meant for other read endpoints): kills of the systems in the window,
 * names, per-system coverage, cursor. Queues back-fills and names when the feed is enabled and $options['queue'].
 * @param array $options queue (bool, default true), source ('panel'|'chain'), userID (int),
 *                       since (int|null: incremental mode, kills stored after this cursor, oldest first)
 */
function zk_system_kills(PDO $db, array $systemIDs, $windowSeconds, $limit, array $options = []) {
    return zk_with_schema($db, function (PDO $db) use ($systemIDs, $windowSeconds, $limit, $options) {
        $now = time();
        $feed = zk_feed_status($db, $now);
        $queue = $feed['enabled'] && ($options['queue'] ?? true);
        $coverage = zk_backfill_request($db, $systemIDs, $windowSeconds, [
            'queue' => $queue, 'source' => $options['source'] ?? 'panel', 'userID' => $options['userID'] ?? 0,
            'feedEnabled' => $feed['enabled'],
        ]);
        $latest = (int) $db->query('SELECT COALESCE(MAX(id), 0) FROM zkill_killmails')->fetchColumn();
        $since = $options['since'] ?? null;
        $cursor = $latest;
        if ($since === null) {
            $rows = zk_query_kills($db, $systemIDs, $now - $windowSeconds, $limit);
        } else {
            // Like kills.php: a cursor beyond the latest id (table emptied) resets to the latest; a full page
            // continues after its last kill
            $rows = zk_query_kills_since($db, $systemIDs, $now - $windowSeconds, $since, $latest, $limit);
            if (count($rows) === $limit) $cursor = (int) $rows[count($rows) - 1]['id'];
        }

        $kills = array_map('zk_kill_json', $rows);
        $ids = [];
        foreach ($kills as $kill) {
            foreach (['victim', 'finalBlow'] as $side) {
                foreach ($kill[$side] as $id) if ($id !== null) $ids[] = $id;
            }
        }
        [$names, $namesPending] = zk_names_lookup($db, $ids, $feed['enabled']);

        $systems = [];
        $complete = true;
        $pending = false;
        $queueFull = false;
        foreach ($systemIDs as $systemID) {
            $c = $coverage[$systemID];
            $complete = $complete && $c['complete'];
            $pending = $pending || $c['pending'];
            $queueFull = $queueFull || $c['queueFull'];
            $systems[] = [
                'systemID' => $systemID,
                'complete' => $c['complete'],
                'coveredFrom' => $c['coveredFrom'] === null ? null : gmdate('Y-m-d\TH:i:s\Z', $c['coveredFrom']),
                'coveredTo' => $c['coveredTo'] === null ? null : gmdate('Y-m-d\TH:i:s\Z', $c['coveredTo']),
                'pending' => $c['pending'],
                'queueFull' => $c['queueFull'],
                'backfill' => $c['status'] === null ? null : ['status' => $c['status'], 'error' => $c['error']],
            ];
        }
        $nameMap = [];
        foreach ($names as $id => $name) $nameMap[(string) $id] = $name;

        return [
            'now' => gmdate('Y-m-d\TH:i:s\Z', $now),
            'pastSeconds' => $windowSeconds,
            'retentionSeconds' => zk_retention_seconds(),
            'limit' => $limit,
            'cursor' => $cursor,
            'feed' => $feed,
            'complete' => $complete,
            'pending' => $pending,
            'queueFull' => $queueFull,
            'namesPending' => $feed['enabled'] && $namesPending > 0,
            'systems' => $systems,
            'kills' => $kills,
            'names' => (object) $nameMap,
        ];
    });
}
