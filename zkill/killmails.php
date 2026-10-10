<?php
// Fork-owned: killmail storage of the zKillboard integration (see zkill/zkill.inc.php).

/**
 * Row for zkill_killmails from a killmail as R2Z2 / the zKillboard API deliver it:
 * R2Z2: {killmail_id, hash, zkb, esi: {ESI killmail}}; API: {ESI killmail fields..., zkb: {hash, ...}}.
 * Returns null when the ESI part (victim, system, time) is missing.
 */
function zk_killmail_row(array $kill) {
    $esi = isset($kill['esi']) && is_array($kill['esi']) ? $kill['esi'] : $kill;
    $zkb = isset($kill['zkb']) && is_array($kill['zkb']) ? $kill['zkb'] : [];
    $killID = $kill['killmail_id'] ?? ($esi['killmail_id'] ?? null);
    if (!is_numeric($killID) || !isset($esi['solar_system_id'], $esi['killmail_time']) || !is_array($esi['victim'] ?? null)) return null;
    $killTime = strtotime($esi['killmail_time']);
    if ($killTime === false) return null;

    $victim = $esi['victim'];
    $attackers = is_array($esi['attackers'] ?? null) ? $esi['attackers'] : [];
    $pilots = 0;
    $finalBlow = null;
    foreach ($attackers as $attacker) {
        if (!is_array($attacker)) continue;
        if (!empty($attacker['character_id'])) $pilots++;
        if (!empty($attacker['final_blow'])) $finalBlow = $attacker;
    }
    $id = function ($source, $key) {
        return is_array($source) && isset($source[$key]) && is_numeric($source[$key]) && (int) $source[$key] > 0 ? (int) $source[$key] : null;
    };
    return [
        'killID'                 => (int) $killID,
        'systemID'               => (int) $esi['solar_system_id'],
        'killTime'               => gmdate('Y-m-d H:i:s', $killTime),
        'hash'                   => substr((string) ($kill['hash'] ?? ($zkb['hash'] ?? '')), 0, 64),
        'victimCharacterID'      => $id($victim, 'character_id'),
        'victimCorporationID'    => $id($victim, 'corporation_id'),
        'victimAllianceID'       => $id($victim, 'alliance_id'),
        'victimShipTypeID'       => $id($victim, 'ship_type_id'),
        'finalBlowCharacterID'   => $id($finalBlow, 'character_id'),
        'finalBlowCorporationID' => $id($finalBlow, 'corporation_id'),
        'finalBlowAllianceID'    => $id($finalBlow, 'alliance_id'),
        'finalBlowShipTypeID'    => $id($finalBlow, 'ship_type_id'),
        'attackerCount'          => min($pilots, 65535),
        'attackerTotal'          => min(count($attackers), 65535),
        'totalValue'             => is_numeric($zkb['totalValue'] ?? null) ? round((float) $zkb['totalValue'], 2) : 0,
        'npc'                    => !empty($zkb['npc']) ? 1 : 0,
        'solo'                   => !empty($zkb['solo']) ? 1 : 0,
        'awox'                   => !empty($zkb['awox']) ? 1 : 0,
    ];
}

/** Store a killmail row; an already stored kill is left as it is. Returns true when inserted. */
function zk_store_row(PDO $db, array $row, $source) {
    $columns = array_keys($row);
    $stmt = $db->prepare('INSERT IGNORE INTO zkill_killmails (' . implode(', ', $columns) . ', source, receivedAt)
        VALUES (' . implode(', ', array_map(function ($c) { return ':' . $c; }, $columns)) . ', :source, UTC_TIMESTAMP())');
    $params = [':source' => $source];
    foreach ($row as $column => $value) $params[':' . $column] = $value;
    $stmt->execute($params);
    return $stmt->rowCount() > 0;
}

/** Store a killmail (R2Z2 or API shape) if it is inside the retention window. Returns true when inserted. */
function zk_store_killmail(PDO $db, array $kill, $source) {
    $row = zk_killmail_row($kill);
    if ($row === null || strtotime($row['killTime'] . ' UTC') < time() - zk_retention_seconds()) return false;
    return zk_store_row($db, $row, $source);
}

/** Since when the stream has stored every kill (UTC 'Y-m-d H:i:s'), or null if it never ran */
function zk_stream_covered_since(PDO $db) {
    return zk_state_get($db, 'stream.coveredSince');
}

/** The stream starts (or restarts after a gap) now: earlier kills are only covered by back-fills */
function zk_stream_reset_coverage(PDO $db) {
    zk_state_set($db, 'stream.coveredSince', gmdate('Y-m-d H:i:s'));
}

/**
 * Worker: up to when the stream has stored every kill (unix time): the R2Z2 upload time of the last processed
 * killmail while catching up, or now when it is caught up (R2Z2 has nothing newer).
 */
function zk_stream_set_high_water(PDO $db, $unix) {
    zk_state_set($db, 'stream.highWater', gmdate('Y-m-d H:i:s', (int) $unix));
}

/** [coveredSince, highWater] as unix times (null when unknown) */
function zk_stream_window(PDO $db) {
    $rows = $db->query("SELECT name, value FROM zkill_state WHERE name IN ('stream.coveredSince', 'stream.highWater')")->fetchAll(PDO::FETCH_KEY_PAIR);
    return [zk_unix($rows['stream.coveredSince'] ?? null), zk_unix($rows['stream.highWater'] ?? null)];
}

/** Delete kills, back-fill rows and names that are past their retention. Returns the number of kills deleted. */
function zk_prune(PDO $db) {
    $retention = zk_retention_seconds();
    $deleted = $db->exec('DELETE FROM zkill_killmails WHERE killTime < UTC_TIMESTAMP() - INTERVAL ' . $retention . ' SECOND');
    $db->exec("DELETE FROM zkill_backfill WHERE status IN ('done', 'failed') AND requestedAt < UTC_TIMESTAMP() - INTERVAL " . $retention . ' SECOND');
    // Names are re-resolved after 30 days (renames), unresolvable ones are retried after a day
    $db->exec("DELETE FROM zkill_names WHERE (name IS NOT NULL AND name <> '' AND resolvedAt < UTC_TIMESTAMP() - INTERVAL 30 DAY)
        OR (name = '' AND resolvedAt < UTC_TIMESTAMP() - INTERVAL 1 DAY)");
    return (int) $deleted;
}
