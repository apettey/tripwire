<?php
// Fork-owned: 90-day threat profile of a system (System Threat, public/system_threat.php): kills, top groups and kills
// by hour of day (EVE time = UTC). Computed from the kills the stream already stores in zkill_killmails, so it costs
// no zKillboard request at all. zKillboard's own stats only cover 7 days of top lists, so for the systems people look
// at (zkill_system_keep) the stream keeps their kills for ZKILL_THREAT_KEEP_DAYS (default 90) instead of
// ZKILL_RETENTION_HOURS. History therefore builds up from the day a system was first looked at (plus whatever the
// retention window and its back-fill already hold); `coveredDays` says how much of the period is really covered.

const ZK_PROFILE_TTL          = 3600;    // seconds a computed profile is reused ("analysed X ago")
const ZK_PROFILE_TOP          = 5;       // groups returned
const ZK_PROFILE_MIN_DAYS     = 3;       // a group counts only with kills on this many different days
const ZK_PROFILE_WINDOW_HOURS = 4;       // width of the "most active" window
const ZK_PROFILE_MIN_WINDOW   = 8;       // fewest kills for which a busiest window is named
const ZK_PROFILE_MAX_ROWS     = 20000;   // kills read per system and profile
const ZK_PROFILE_LEVELS       = [['critical', 50], ['high', 15], ['moderate', 5], ['low', 1]];   // kills in 90 days (WormholeSystems: 50 / 15)
const ZK_KEEP_MAX_SYSTEMS     = 500;     // systems whose kills are kept for longer
const ZK_KEEP_PRUNE_DAYS      = 14;      // systems nobody looked at in this many days are let go

/** Days stored kills of watched systems are kept (ZKILL_THREAT_KEEP_DAYS, 0-90, default 90; 0 = only ZKILL_RETENTION_HOURS) */
function zk_keep_days() {
    return zk_config_int('ZKILL_THREAT_KEEP_DAYS', 90, 0, 90);
}

/** Level name for a kill count over 90 days */
function zk_profile_level($kills) {
    foreach (ZK_PROFILE_LEVELS as [$name, $min]) if ($kills >= $min) return $name;
    return 'none';
}

/**
 * The busiest run of $width consecutive hours (wrapping around midnight) of a 24-bucket histogram.
 * @return array|null ['start' => 0-23, 'end' => 0-23 (exclusive), 'kills', 'share' => percent]; null with fewer than
 *                    ZK_PROFILE_MIN_WINDOW kills. The earliest start wins a tie.
 */
function zk_profile_busiest(array $hours, $width = ZK_PROFILE_WINDOW_HOURS) {
    $total = array_sum($hours);
    if ($total < ZK_PROFILE_MIN_WINDOW) return null;
    $best = -1;
    $start = 0;
    for ($h = 0; $h < 24; $h++) {
        $sum = 0;
        for ($i = 0; $i < $width; $i++) $sum += $hours[($h + $i) % 24];
        if ($sum > $best) { $best = $sum; $start = $h; }
    }
    return ['start' => $start, 'end' => ($start + $width) % 24, 'kills' => $best, 'share' => (int) round($best * 100 / $total)];
}

/** NPC corporations (militias, starter corporations, customs): never a threat group */
function zk_profile_is_npc_corporation($id) {
    return $id >= 1000000 && $id <= 1999999;
}

/**
 * One period of the profile from stored kill rows.
 * @param array $rows  killmail rows (killTime 'Y-m-d H:i:s' UTC, npc, victim* / finalBlow* IDs)
 * @param int   $from  unix time the period starts
 * @return array ['kills', 'hours' => 24 counts, 'busiest', 'groups' => [{kind, id, kills, losses, days, lastSeen}]]
 *               kills = player kills here; a group (alliance, else corporation) is listed with kills (final blows)
 *               on at least ZK_PROFILE_MIN_DAYS different days; losses = its ships lost here
 */
function zk_profile_period(array $rows, $from) {
    $fromText = gmdate('Y-m-d H:i:s', $from);
    $hours = array_fill(0, 24, 0);
    $kills = 0;
    $groups = [];
    $group = function ($corp, $alliance) {
        $corp = (int) $corp;
        $alliance = (int) $alliance;
        if ($alliance > 0) return ['alliance', $alliance];
        return $corp > 0 && !zk_profile_is_npc_corporation($corp) ? ['corporation', $corp] : null;
    };
    $touch = function ($g) use (&$groups) {
        $key = $g[0] . $g[1];
        if (!isset($groups[$key])) $groups[$key] = ['kind' => $g[0], 'id' => $g[1], 'kills' => 0, 'losses' => 0, 'dayList' => [], 'lastSeen' => ''];
        return $key;
    };
    foreach ($rows as $row) {
        $time = (string) $row['killTime'];
        if ($time < $fromText) continue;
        $victim = $group($row['victimCorporationID'] ?? 0, $row['victimAllianceID'] ?? 0);
        if ($victim) {
            $key = $touch($victim);
            $groups[$key]['losses']++;
        }
        if (!empty($row['npc'])) continue;
        $kills++;
        $hours[(int) substr($time, 11, 2)]++;
        $killer = !empty($row['finalBlowCharacterID']) ? $group($row['finalBlowCorporationID'] ?? 0, $row['finalBlowAllianceID'] ?? 0) : null;
        if ($killer) {
            $key = $touch($killer);
            $groups[$key]['kills']++;
            $groups[$key]['dayList'][substr($time, 0, 10)] = true;
            if ($time > $groups[$key]['lastSeen']) $groups[$key]['lastSeen'] = $time;
        }
    }
    $list = [];
    foreach ($groups as $g) {
        $days = count($g['dayList']);
        if ($days < ZK_PROFILE_MIN_DAYS) continue;   // a one-off roam is not a resident
        $list[] = ['kind' => $g['kind'], 'id' => $g['id'], 'kills' => $g['kills'], 'losses' => $g['losses'], 'days' => $days,
            'lastSeen' => zk_iso($g['lastSeen'])];
    }
    usort($list, function ($a, $b) {
        return [$b['kills'], $b['days'], $a['id']] <=> [$a['kills'], $a['days'], $b['id']];
    });
    return ['kills' => $kills, 'hours' => $hours, 'busiest' => zk_profile_busiest($hours), 'groups' => array_slice($list, 0, ZK_PROFILE_TOP)];
}

/**
 * The full profile.
 * @param int|null $coveredFrom unix time since when the stored kills are complete for this system (null = unknown: 0 days)
 * @return array ['analysedAt' (ISO), 'coveredDays', 'level', 'd7' => period, 'd90' => period]
 */
function zk_profile_compute(array $rows, $now, $coveredFrom) {
    $d90 = zk_profile_period($rows, $now - 90 * 86400);
    return [
        'analysedAt' => gmdate('Y-m-d\TH:i:s\Z', $now),
        'coveredDays' => $coveredFrom === null ? 0.0 : round(max(0, min(90, ($now - $coveredFrom) / 86400)), 1),
        'level' => zk_profile_level($d90['kills']),
        'd7' => zk_profile_period($rows, $now - 7 * 86400),
        'd90' => $d90,
    ];
}

/** Stored kills of a system, newest first (at most ZK_PROFILE_MAX_ROWS) */
function zk_profile_rows(PDO $db, $systemID, $now) {
    $stmt = $db->prepare('SELECT killTime, npc, victimCorporationID, victimAllianceID, finalBlowCharacterID, finalBlowCorporationID, finalBlowAllianceID
        FROM zkill_killmails WHERE systemID = ? AND killTime >= ? ORDER BY killTime DESC LIMIT ' . ZK_PROFILE_MAX_ROWS);
    $stmt->execute([$systemID, gmdate('Y-m-d H:i:s', $now - 90 * 86400)]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/**
 * Remember that systems are being looked at, so their kills are kept for zk_keep_days() (new rows only below
 * ZK_KEEP_MAX_SYSTEMS). Plain SQL, portable. @return int rows added
 */
function zk_keep_touch(PDO $db, array $systemIDs, $now) {
    if (!$systemIDs) return 0;
    $in = implode(',', array_fill(0, count($systemIDs), '?'));
    $stmt = $db->prepare("SELECT systemID, wantedAt FROM zkill_system_keep WHERE systemID IN ($in)");
    $stmt->execute(array_values($systemIDs));
    $known = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $known[(int) $row['systemID']] = zk_unix($row['wantedAt']);
    $total = (int) $db->query('SELECT COUNT(*) FROM zkill_system_keep')->fetchColumn();
    $text = gmdate('Y-m-d H:i:s', $now);
    $added = 0;
    foreach ($systemIDs as $id) {
        if (isset($known[$id])) {
            if ($known[$id] < $now - 3600) $db->prepare('UPDATE zkill_system_keep SET wantedAt = ? WHERE systemID = ?')->execute([$text, $id]);
        } elseif ($total + $added < ZK_KEEP_MAX_SYSTEMS) {
            $db->prepare('INSERT INTO zkill_system_keep (systemID, keepSince, wantedAt) VALUES (?, ?, ?)')->execute([$id, $text, $text]);
            $added++;
        }
    }
    return $added;
}

/**
 * Whether the stream should store a kill older than the retention window: only for a watched system, within
 * zk_keep_days(). The set of watched systems is cached for a minute (this runs for every kill of the stream).
 */
function zk_keep_wants(PDO $db, $systemID, $killUnix, $now = null) {
    static $set = [], $loaded = 0;
    $now = $now ?? time();
    $days = zk_keep_days();
    if ($days <= 0 || $killUnix < $now - $days * 86400) return false;
    if ($now - $loaded >= 60) {
        $loaded = $now;
        try {
            $set = array_flip(array_map('intval', $db->query('SELECT systemID FROM zkill_system_keep')->fetchAll(PDO::FETCH_COLUMN)));
        } catch (PDOException $error) {
            $set = [];   // table not created yet: nothing is watched
        }
    }
    return isset($set[(int) $systemID]);
}

/** Worker: SQL condition that spares kills of watched systems from the retention prune (empty string = none) */
function zk_keep_prune_exception(PDO $db) {
    $days = zk_keep_days();
    if ($days <= 0) return '';
    try {
        $db->prepare('DELETE FROM zkill_system_keep WHERE wantedAt < ?')->execute([gmdate('Y-m-d H:i:s', time() - ZK_KEEP_PRUNE_DAYS * 86400)]);
        $db->query('SELECT 1 FROM zkill_system_keep LIMIT 1')->fetchAll();
    } catch (PDOException $error) {
        return '';
    }
    return ' AND NOT (killTime >= UTC_TIMESTAMP() - INTERVAL ' . $days . ' DAY AND systemID IN (SELECT systemID FROM zkill_system_keep))';
}

/**
 * The profile of a viewed system: the cached one while younger than ZK_PROFILE_TTL, else computed from the stored
 * kills and cached in zkill_system_keep. @param int|null $retentionCoveredFrom start of the retention window's coverage
 */
function zk_profile_get(PDO $db, $systemID, $now, $retentionCoveredFrom) {
    $stmt = $db->prepare('SELECT keepSince, analysedAt, profile FROM zkill_system_keep WHERE systemID = ?');
    $stmt->execute([$systemID]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row && $row['profile'] !== null && $row['profile'] !== '' && zk_unix($row['analysedAt']) > $now - ZK_PROFILE_TTL) {
        $cached = json_decode($row['profile'], true);
        if (is_array($cached)) return $cached;
    }
    $since = $row ? zk_unix($row['keepSince']) : $now;
    $keeping = $row && zk_keep_days() > 0;
    // Before the system was watched only the retention window is known; once watched, everything since then is
    $coveredFrom = $keeping ? min($since, $retentionCoveredFrom ?? $since) : $retentionCoveredFrom;
    $profile = zk_profile_compute(zk_profile_rows($db, $systemID, $now), $now, $coveredFrom);
    if ($row) {
        $db->prepare('UPDATE zkill_system_keep SET analysedAt = ?, profile = ? WHERE systemID = ?')
            ->execute([gmdate('Y-m-d H:i:s', $now), json_encode($profile), $systemID]);
    }
    return $profile;
}
