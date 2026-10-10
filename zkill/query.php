<?php
// Fork-owned: read side of the zKillboard integration for web endpoints (see zkill/zkill.inc.php).
// Nothing here makes an outgoing request; at most it queues back-fills and names for the worker.

/** Kills in the given systems since $fromUnix, newest first, at most $limit */
function zk_query_kills(PDO $db, array $systemIDs, $fromUnix, $limit) {
    if (!$systemIDs) return [];
    $stmt = $db->prepare('SELECT killID, systemID, killTime, victimCharacterID, victimCorporationID, victimAllianceID, victimShipTypeID,
            finalBlowCharacterID, finalBlowCorporationID, finalBlowAllianceID, finalBlowShipTypeID,
            attackerCount, attackerTotal, totalValue, npc, solo, awox
        FROM zkill_killmails
        WHERE systemID IN (' . implode(',', array_fill(0, count($systemIDs), '?')) . ') AND killTime >= ?
        ORDER BY killTime DESC, killID DESC
        LIMIT ' . (int) $limit);
    $stmt->execute(array_merge(array_values($systemIDs), [gmdate('Y-m-d H:i:s', $fromUnix)]));
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/** API shape of a zkill_killmails row */
function zk_kill_json(array $row) {
    $int = function ($value) { return $value === null ? null : (int) $value; };
    return [
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

/** Stream status: enabled, coveredSince (ISO), live (the worker saved its position in the last 5 minutes) */
function zk_feed_status(PDO $db) {
    $live = false;
    try {
        $age = $db->query('SELECT TIMESTAMPDIFF(SECOND, updatedAt, UTC_TIMESTAMP()) FROM zkill_feed_state WHERE id = 1')->fetchColumn();
        $live = $age !== false && (int) $age < 300;
    } catch (PDOException $error) {
        if ($error->getCode() !== '42S02') throw $error;
    }
    return [
        'enabled' => zk_feed_enabled(),
        'live' => zk_feed_enabled() && $live,
        'coveredSince' => zk_iso(zk_stream_covered_since($db)),
    ];
}

/**
 * Response of public/system_kills.php (also meant for other read endpoints): kills of the systems in the
 * window, names, per-system coverage. Queues back-fills and names when the feed is enabled.
 */
function zk_system_kills(PDO $db, array $systemIDs, $windowSeconds, $limit) {
    return zk_with_schema($db, function (PDO $db) use ($systemIDs, $windowSeconds, $limit) {
        $now = time();
        $feed = zk_feed_status($db);
        $coverage = zk_backfill_request($db, $systemIDs, $windowSeconds, $feed['enabled']);
        $rows = zk_query_kills($db, $systemIDs, $now - $windowSeconds, $limit);

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
        foreach ($systemIDs as $systemID) {
            $c = $coverage[$systemID];
            $complete = $complete && $c['complete'];
            $pending = $pending || $c['pending'];
            $systems[] = [
                'systemID' => $systemID,
                'complete' => $c['complete'],
                'coveredFrom' => $c['coveredFrom'] === null ? null : gmdate('Y-m-d\TH:i:s\Z', $c['coveredFrom']),
                'pending' => $c['pending'],
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
            'feed' => $feed,
            'complete' => $complete,
            'pending' => $pending,
            'namesPending' => $feed['enabled'] && $namesPending > 0,
            'systems' => $systems,
            'kills' => $kills,
            'names' => (object) $nameMap,
        ];
    });
}
