<?php
// Fork-owned: read side of System Threat (public/system_threat.php). Nothing here makes an outgoing request: it
// combines the cached zKillboard stats (zkill/stats.php) with the kills the stream keeps in zkill_killmails, and at
// most queues stats, a back-fill and names for the worker.

// Structures whose loss marks someone as (having been) settled in a system: Upwell structures, customs offices,
// skyhooks, Metenox moon drills and the basic control towers
const ZK_STRUCTURE_TYPES = [
    35832, 35833, 35834, 35825, 35826, 35827, 35835, 35836,   // Astrahus, Fortizar, Keepstar, Raitaru, Azbel, Sotiyo, Athanor, Tatara
    47512, 47513, 47514, 47515, 47516, 40340,                 // faction Fortizars, Upwell Palatine Keepstar
    2233, 81080, 81826,                                       // Customs Office, Orbital Skyhook, Metenox Moon Drill
    12235, 12236, 16213, 16214, 20059, 20060, 20061, 20062, 20063, 20064, 20065, 20066,   // control towers (large, medium, small)
];
const ZK_THREAT_ENTITIES  = 15;   // corporations / alliances returned per kind
const ZK_THREAT_STRUCTURES = 10;

/**
 * Kills per system from the stream's store (NPC kills left out, like zKillboard's 7-day numbers).
 * @return array systemID => ['kills1h', 'kills24h', 'killsWindow', 'lastKill' => unix|null]
 */
function zk_threat_local_counts(PDO $db, array $systemIDs, $now) {
    $result = [];
    foreach ($systemIDs as $id) $result[$id] = ['kills1h' => 0, 'kills24h' => 0, 'killsWindow' => 0, 'lastKill' => null];
    if (!$systemIDs) return $result;
    $stmt = $db->prepare('SELECT systemID, SUM(killTime >= ?) AS h1, SUM(killTime >= ?) AS h24, COUNT(*) AS total, MAX(killTime) AS last
        FROM zkill_killmails WHERE systemID IN (' . implode(',', array_fill(0, count($systemIDs), '?')) . ') AND killTime >= ? AND npc = 0
        GROUP BY systemID');
    $stmt->execute(array_merge([gmdate('Y-m-d H:i:s', $now - 3600), gmdate('Y-m-d H:i:s', $now - 86400)], array_values($systemIDs),
        [gmdate('Y-m-d H:i:s', $now - zk_retention_seconds())]));
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $result[(int) $row['systemID']] = [
            'kills1h' => (int) $row['h1'],
            'kills24h' => (int) $row['h24'],
            'killsWindow' => (int) $row['total'],
            'lastKill' => zk_unix($row['last']),
        ];
    }
    return $result;
}

/**
 * Corporations and alliances seen in a system's stored kills: losses (as victim) and kills (final blows by pilots,
 * the only attacker the store keeps). Pure; rows come from zk_threat_detail().
 * @param array $losses [[corporationID, allianceID, count, isk, last (unix)], ...]
 * @param array $kills  [[corporationID, allianceID, count, last (unix)], ...]
 * @return array ['corporations' => [...], 'alliances' => [...]], each [{id, kills, losses, iskLost, lastSeen}] sorted by
 *               kills + losses, then most recent
 */
function zk_threat_entities(array $losses, array $kills, $limit = ZK_THREAT_ENTITIES) {
    $out = ['corporations' => [], 'alliances' => []];
    $add = function ($kind, $id, $field, $count, $isk, $last) use (&$out) {
        $id = (int) $id;
        if ($id <= 0) return;
        if (!isset($out[$kind][$id])) $out[$kind][$id] = ['id' => $id, 'kills' => 0, 'losses' => 0, 'iskLost' => 0.0, 'lastSeen' => null];
        $out[$kind][$id][$field] += (int) $count;
        $out[$kind][$id]['iskLost'] += (float) $isk;
        if ($last !== null) $out[$kind][$id]['lastSeen'] = max((int) $out[$kind][$id]['lastSeen'], (int) $last);
    };
    foreach ($losses as [$corp, $alliance, $count, $isk, $last]) {
        $add('corporations', $corp, 'losses', $count, $isk, $last);
        $add('alliances', $alliance, 'losses', $count, $isk, $last);
    }
    foreach ($kills as [$corp, $alliance, $count, $last]) {
        $add('corporations', $corp, 'kills', $count, 0, $last);
        $add('alliances', $alliance, 'kills', $count, 0, $last);
    }
    foreach ($out as $kind => $entities) {
        $list = array_values($entities);
        usort($list, function ($a, $b) {
            $d = ($b['kills'] + $b['losses']) - ($a['kills'] + $a['losses']);
            return $d !== 0 ? $d : ((int) $b['lastSeen'] - (int) $a['lastSeen']);
        });
        $out[$kind] = array_slice($list, 0, $limit);
    }
    return $out;
}

/**
 * Who is active in one system according to the stored kills (the last ZKILL_RETENTION_HOURS), and its structure
 * losses in that time. @return array ['corporations', 'alliances', 'structures' => [{killID, typeID, time,
 * corporationID, allianceID, value}]]
 */
function zk_threat_detail(PDO $db, $systemID, $now) {
    $from = gmdate('Y-m-d H:i:s', $now - zk_retention_seconds());
    $stmt = $db->prepare('SELECT victimCorporationID, victimAllianceID, COUNT(*), SUM(totalValue), MAX(killTime)
        FROM zkill_killmails WHERE systemID = ? AND killTime >= ? GROUP BY victimCorporationID, victimAllianceID');
    $stmt->execute([$systemID, $from]);
    $losses = array_map(function ($r) { return [$r[0], $r[1], $r[2], $r[3], zk_unix($r[4])]; }, $stmt->fetchAll(PDO::FETCH_NUM));
    $stmt = $db->prepare('SELECT finalBlowCorporationID, finalBlowAllianceID, COUNT(*), MAX(killTime)
        FROM zkill_killmails WHERE systemID = ? AND killTime >= ? AND npc = 0 AND finalBlowCharacterID IS NOT NULL
        GROUP BY finalBlowCorporationID, finalBlowAllianceID');
    $stmt->execute([$systemID, $from]);
    $kills = array_map(function ($r) { return [$r[0], $r[1], $r[2], zk_unix($r[3])]; }, $stmt->fetchAll(PDO::FETCH_NUM));
    $entities = zk_threat_entities($losses, $kills);

    $stmt = $db->prepare('SELECT killID, victimShipTypeID, killTime, victimCorporationID, victimAllianceID, totalValue
        FROM zkill_killmails WHERE systemID = ? AND killTime >= ? AND victimShipTypeID IN (' . implode(',', ZK_STRUCTURE_TYPES) . ')
        ORDER BY killTime DESC LIMIT ' . ZK_THREAT_STRUCTURES);
    $stmt->execute([$systemID, $from]);
    $entities['structures'] = array_map(function ($r) {
        return [
            'killID' => (int) $r['killID'],
            'typeID' => (int) $r['victimShipTypeID'],
            'time' => zk_iso($r['killTime']),
            'corporationID' => $r['victimCorporationID'] === null ? null : (int) $r['victimCorporationID'],
            'allianceID' => $r['victimAllianceID'] === null ? null : (int) $r['victimAllianceID'],
            'value' => (float) $r['totalValue'],
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    return $entities;
}

/**
 * Response of public/system_threat.php.
 * @param array $options queue (bool), userID (int), detail (int|null: system to return residents for; also asks for a
 *                       back-fill of its retention window, like the System Kill Feed does for the viewed system)
 */
function zk_system_threat(PDO $db, array $systemIDs, array $options = []) {
    return zk_with_schema($db, function (PDO $db) use ($systemIDs, $options) {
        $now = time();
        $feed = zk_feed_status($db, $now);
        $queue = $feed['enabled'] && ($options['queue'] ?? true);
        $detailID = $options['detail'] ?? null;
        $userID = (int) ($options['userID'] ?? 0);
        $stats = zk_stats_request($db, $systemIDs, ['queue' => $queue, 'source' => 'chain', 'userID' => $userID]);
        if ($detailID !== null) {
            // The viewed system goes ahead of chain systems
            $stats[$detailID] = zk_stats_request($db, [$detailID], ['queue' => $queue, 'source' => 'detail', 'userID' => $userID])[$detailID];
        }
        $ids = array_keys($stats);
        $local = zk_threat_local_counts($db, $ids, $now);
        [$streamSince] = zk_stream_window($db);

        $systems = [];
        $pending = false;
        foreach ($ids as $id) {
            $s = $stats[$id];
            $pending = $pending || $s['pending'];
            $systems[(string) $id] = [
                'stats' => $s['stats'],
                'fetchedAt' => $s['fetchedAt'] === null ? null : gmdate('Y-m-d\TH:i:s\Z', $s['fetchedAt']),
                'statsStatus' => $s['status'],
                'pending' => $s['pending'],
                'queueFull' => $s['queueFull'],
                'local' => [
                    'kills1h' => $local[$id]['kills1h'],
                    'kills24h' => $local[$id]['kills24h'],
                    'killsWindow' => $local[$id]['killsWindow'],
                    'lastKill' => $local[$id]['lastKill'] === null ? null : gmdate('Y-m-d\TH:i:s\Z', $local[$id]['lastKill']),
                ],
            ];
        }

        $response = [
            'now' => gmdate('Y-m-d\TH:i:s\Z', $now),
            'retentionSeconds' => zk_retention_seconds(),
            // Since when the stream has every kill: local counts for windows reaching further back are incomplete
            'localSince' => $streamSince === null ? null : gmdate('Y-m-d\TH:i:s\Z', $streamSince),
            'feed' => $feed,
            'pending' => $pending,
            'systems' => (object) $systems,
        ];
        if ($detailID !== null) {
            $coverage = zk_backfill_request($db, [$detailID], zk_retention_seconds(), ['queue' => $queue, 'source' => 'panel', 'userID' => $userID]);
            $detail = zk_threat_detail($db, $detailID, $now);
            $c = $coverage[$detailID];
            // Watch the viewed system and the user's mask chain (looked up here, not taken from the request), so the
            // stream keeps their kills for the 90-day profile
            if ($queue && $feed['enabled'] && zk_keep_days() > 0) zk_keep_touch($db, zk_watch_systems($db, $detailID, $options['maskID'] ?? null), $now, $userID);
            $profile = zk_profile_get($db, $detailID, $now, $c['coveredFrom']);
            $nameIDs = [];
            foreach (['d7', 'd90'] as $period) foreach ($profile[$period]['groups'] as $g) $nameIDs[] = $g['id'];
            foreach (['corporations', 'alliances'] as $kind) foreach ($detail[$kind] as $e) $nameIDs[] = $e['id'];
            foreach ($detail['structures'] as $st) {
                $nameIDs[] = $st['typeID'];
                if ($st['corporationID']) $nameIDs[] = $st['corporationID'];
            }
            [$names, $namesPending] = zk_names_lookup($db, $nameIDs, $feed['enabled']);
            $nameMap = [];
            foreach ($names as $id => $name) $nameMap[(string) $id] = $name;
            $response['detail'] = [
                'systemID' => $detailID,
                'corporations' => $detail['corporations'],
                'alliances' => $detail['alliances'],
                'structures' => $detail['structures'],
                'profile' => $profile,
                'names' => (object) $nameMap,
                'namesPending' => $feed['enabled'] && $namesPending > 0,
                'complete' => $c['complete'],
                'coveredFrom' => $c['coveredFrom'] === null ? null : gmdate('Y-m-d\TH:i:s\Z', $c['coveredFrom']),
                'pending' => $c['pending'],
            ];
            $response['pending'] = $pending || $c['pending'] || $response['detail']['namesPending'];
        }
        return $response;
    });
}
