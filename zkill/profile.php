<?php
// Fork-owned: 90-day threat profile of a system (System Threat, public/system_threat.php): kills, top groups and kills
// by hour of day (EVE time = UTC). Computed from the kills the stream already stores in zkill_killmails (aggregated in
// SQL), so it costs no zKillboard request at all. zKillboard's own stats only cover 7 days of top lists, so for the
// systems people look at (zkill_system_keep) the stream keeps their kills for ZKILL_THREAT_KEEP_DAYS (default 90)
// instead of ZKILL_RETENTION_HOURS, at most ZK_KEEP_MAX_PER_SYSTEM kills beyond the retention window per system.
// History therefore builds up from the day a system was first looked at (plus whatever the retention window and its
// back-fill already hold); `coveredDays` says how much of the period is really covered.

const ZK_PROFILE_TTL          = 3600;    // seconds a computed profile is reused ("analysed X ago")
const ZK_PROFILE_TTL_UNWATCHED = 600;    // seconds a profile of a system nobody watches is reused
const ZK_PROFILE_LOCK_WAIT    = 3;       // seconds to wait for another request computing the same profile
const ZK_PROFILE_TOP          = 5;       // groups returned
const ZK_PROFILE_MIN_DAYS     = 3;       // a group counts only with kills on this many different days
const ZK_PROFILE_WINDOW_HOURS = 4;       // width of the "most active" window
const ZK_PROFILE_MIN_WINDOW   = 8;       // fewest kills for which a busiest window is named
const ZK_PROFILE_MAX_ROWS     = 20000;   // (group, day) rows read per period
const ZK_PROFILE_LEVELS       = [['critical', 50], ['high', 15], ['moderate', 5], ['low', 1]];   // kills in 90 days (WormholeSystems: 50 / 15)
const ZK_KEEP_MAX_SYSTEMS     = 500;     // systems whose kills are kept for longer
const ZK_KEEP_MAX_PER_USER    = 200;     // watched systems one user may have added
const ZK_KEEP_MAX_PER_SYSTEM  = 5000;    // kills kept beyond the retention window per watched system (oldest dropped)
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
 * One period of the profile from aggregated kill rows (see zk_profile_aggregate()).
 * @param array $agg ['hours' => ['YYYY-MM-DD HH' => player kills], 'killers' => [[corp, alliance, 'YYYY-MM-DD', count, last 'Y-m-d H:i:s'], ...]
 *                    (player kills with a pilot's final blow), 'victims' => [[corp, alliance, count], ...] (all kills, NPC ones too)]
 * @return array ['kills', 'hours' => 24 counts, 'busiest', 'groups' => [{kind, id, kills, losses, days, lastSeen}]]
 *               kills = player kills here; a group (alliance, else corporation) is listed with kills (final blows)
 *               on at least ZK_PROFILE_MIN_DAYS different days; losses = its ships lost here
 */
function zk_profile_period(array $agg) {
    $hours = array_fill(0, 24, 0);
    $kills = 0;
    foreach ($agg['hours'] as $dayHour => $count) {
        $hours[(int) substr((string) $dayHour, 11, 2) % 24] += (int) $count;
        $kills += (int) $count;
    }
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
    foreach ($agg['victims'] as [$corp, $alliance, $count]) {
        $g = $group($corp, $alliance);
        if ($g) $groups[$touch($g)]['losses'] += (int) $count;
    }
    foreach ($agg['killers'] as [$corp, $alliance, $day, $count, $last]) {
        $g = $group($corp, $alliance);
        if (!$g) continue;
        $key = $touch($g);
        $groups[$key]['kills'] += (int) $count;
        $groups[$key]['dayList'][(string) $day] = true;
        if ((string) $last > $groups[$key]['lastSeen']) $groups[$key]['lastSeen'] = (string) $last;
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
 * Aggregates of a system's stored kills since $from, grouped in SQL (hour, (group, day), victim group), so a busy system
 * never loads its kills into PHP. Plain SQL (SUBSTR of the 'Y-m-d H:i:s' text) that SQLite runs too.
 */
function zk_profile_aggregate(PDO $db, $systemID, $from) {
    $fromText = gmdate('Y-m-d H:i:s', $from);
    $stmt = $db->prepare('SELECT SUBSTR(killTime, 1, 13), COUNT(*) FROM zkill_killmails
        WHERE systemID = ? AND killTime >= ? AND npc = 0 GROUP BY SUBSTR(killTime, 1, 13)');
    $stmt->execute([$systemID, $fromText]);
    $hours = [];
    foreach ($stmt->fetchAll(PDO::FETCH_NUM) as [$dayHour, $count]) $hours[$dayHour] = (int) $count;
    $stmt = $db->prepare('SELECT finalBlowCorporationID, finalBlowAllianceID, SUBSTR(killTime, 1, 10), COUNT(*), MAX(killTime) FROM zkill_killmails
        WHERE systemID = ? AND killTime >= ? AND npc = 0 AND finalBlowCharacterID > 0
        GROUP BY finalBlowCorporationID, finalBlowAllianceID, SUBSTR(killTime, 1, 10) ORDER BY COUNT(*) DESC LIMIT ' . ZK_PROFILE_MAX_ROWS);
    $stmt->execute([$systemID, $fromText]);
    $killers = $stmt->fetchAll(PDO::FETCH_NUM);
    $stmt = $db->prepare('SELECT victimCorporationID, victimAllianceID, COUNT(*) FROM zkill_killmails
        WHERE systemID = ? AND killTime >= ? GROUP BY victimCorporationID, victimAllianceID ORDER BY COUNT(*) DESC LIMIT ' . ZK_PROFILE_MAX_ROWS);
    $stmt->execute([$systemID, $fromText]);
    return ['hours' => $hours, 'killers' => $killers, 'victims' => $stmt->fetchAll(PDO::FETCH_NUM)];
}

/** One period straight from the database */
function zk_profile_period_db(PDO $db, $systemID, $from) {
    return zk_profile_period(zk_profile_aggregate($db, $systemID, $from));
}

/**
 * The full profile.
 * @param int|null $coveredFrom unix time since when the stored kills are complete for this system (null = unknown: 0 days)
 * @return array ['analysedAt' (ISO), 'coveredDays', 'level', 'd7' => period, 'd90' => period]
 */
function zk_profile_compute(PDO $db, $systemID, $now, $coveredFrom) {
    $d90 = zk_profile_period_db($db, $systemID, $now - 90 * 86400);
    return [
        'analysedAt' => gmdate('Y-m-d\TH:i:s\Z', $now),
        'coveredDays' => $coveredFrom === null ? 0.0 : round(max(0, min(90, ($now - $coveredFrom) / 86400)), 1),
        'level' => zk_profile_level($d90['kills']),
        'd7' => zk_profile_period_db($db, $systemID, $now - 7 * 86400),
        'd90' => $d90,
    ];
}

/**
 * When the per-system storage cap has cut history short: the time of the oldest kept kill beyond the retention window,
 * if there are ZK_KEEP_MAX_PER_SYSTEM of them (the cap drops the oldest), else null.
 */
function zk_profile_capped_from(PDO $db, $systemID, $now) {
    $stmt = $db->prepare('SELECT COUNT(*), MIN(killTime) FROM zkill_killmails WHERE systemID = ? AND killTime < ? AND killTime >= ?');
    $stmt->execute([$systemID, gmdate('Y-m-d H:i:s', $now - zk_retention_seconds()), gmdate('Y-m-d H:i:s', $now - 90 * 86400)]);
    [$count, $oldest] = $stmt->fetch(PDO::FETCH_NUM);
    return (int) $count >= ZK_KEEP_MAX_PER_SYSTEM ? zk_unix($oldest) : null;
}

/**
 * Remember that systems are being looked at, so their kills are kept for zk_keep_days(): one batched upsert, new rows
 * only below ZK_KEEP_MAX_SYSTEMS overall and ZK_KEEP_MAX_PER_USER per user, wantedAt refreshed at most hourly. Never
 * throws (it must not fail the request). @return int rows added
 */
function zk_keep_touch(PDO $db, array $systemIDs, $now, $userID = 0) {
    try {
        $ids = array_values(array_unique(array_map('intval', $systemIDs)));
        if (!$ids) return 0;
        $stmt = $db->prepare('SELECT systemID, wantedAt FROM zkill_system_keep WHERE systemID IN (' . implode(',', array_fill(0, count($ids), '?')) . ')');
        $stmt->execute($ids);
        $known = [];
        foreach ($stmt->fetchAll(PDO::FETCH_NUM) as [$id, $wantedAt]) $known[(int) $id] = zk_unix($wantedAt);
        $write = [];
        foreach ($ids as $id) if (isset($known[$id]) && $known[$id] < $now - 3600) $write[] = $id;
        $new = array_values(array_diff($ids, array_keys($known)));
        if ($new) {
            $allowed = ZK_KEEP_MAX_SYSTEMS - (int) $db->query('SELECT COUNT(*) FROM zkill_system_keep')->fetchColumn();
            if ($userID > 0) {
                $mine = $db->prepare('SELECT COUNT(*) FROM zkill_system_keep WHERE requestedBy = ?');
                $mine->execute([(int) $userID]);
                $allowed = min($allowed, ZK_KEEP_MAX_PER_USER - (int) $mine->fetchColumn());
            }
            $new = array_slice($new, 0, max(0, $allowed));
        }
        $text = gmdate('Y-m-d H:i:s', $now);
        $rows = [];
        $params = [];
        foreach (array_merge($write, $new) as $id) {
            $rows[] = '(?, ?, ?, ?)';
            array_push($params, $id, (int) $userID, $text, $text);
        }
        if (!$rows) return 0;
        $upsert = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite'
            ? ' ON CONFLICT(systemID) DO UPDATE SET wantedAt = excluded.wantedAt'
            : ' ON DUPLICATE KEY UPDATE wantedAt = VALUES(wantedAt)';
        $db->prepare('INSERT INTO zkill_system_keep (systemID, requestedBy, keepSince, wantedAt) VALUES ' . implode(', ', $rows) . $upsert)->execute($params);
        return count($new);
    } catch (Throwable $error) {
        error_log('zk_keep_touch: ' . $error->getMessage());
        return 0;
    }
}

/**
 * Systems to watch for a request, decided on the server (never from a client list): the viewed system and the systems
 * of the user's mask chain (wormhole signatures of the mask), at most $limit.
 */
function zk_watch_systems(PDO $db, $detailID, $maskID, $limit = 200) {
    $ids = $detailID === null ? [] : [(int) $detailID];
    if ($maskID !== null && $maskID !== '') {
        try {
            $stmt = $db->prepare("SELECT DISTINCT systemID FROM signatures WHERE maskID = ? AND type = 'wormhole' AND systemID > 0 LIMIT " . (int) $limit);
            $stmt->execute([$maskID]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) if (zk_is_system_id((int) $id)) $ids[] = (int) $id;
        } catch (PDOException $error) {
            // no signatures table (tests): only the viewed system
        }
    }
    return array_slice(array_values(array_unique($ids)), 0, $limit);
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
 * Worker, after the retention prune: drop the oldest kills of a watched system beyond ZK_KEEP_MAX_PER_SYSTEM kills older
 * than the retention window, and cached profiles older than a day. @return int kills deleted
 */
function zk_keep_housekeeping(PDO $db, $now = null) {
    $now = $now ?? time();
    $deleted = 0;
    try {
        $cutoff = gmdate('Y-m-d H:i:s', $now - zk_retention_seconds());
        $stmt = $db->prepare('SELECT systemID FROM zkill_killmails WHERE killTime < ? AND systemID IN (SELECT systemID FROM zkill_system_keep)
            GROUP BY systemID HAVING COUNT(*) > ' . ZK_KEEP_MAX_PER_SYSTEM);
        $stmt->execute([$cutoff]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $systemID) {
            $edge = $db->prepare('SELECT killTime FROM zkill_killmails WHERE systemID = ? AND killTime < ? ORDER BY killTime DESC, id DESC LIMIT 1 OFFSET ' . (ZK_KEEP_MAX_PER_SYSTEM - 1));
            $edge->execute([$systemID, $cutoff]);
            $time = $edge->fetchColumn();
            if ($time === false) continue;
            $del = $db->prepare('DELETE FROM zkill_killmails WHERE systemID = ? AND killTime < ?');
            $del->execute([$systemID, $time]);
            $deleted += $del->rowCount();
        }
        $db->prepare('DELETE FROM zkill_profile_cache WHERE analysedAt < ?')->execute([gmdate('Y-m-d H:i:s', $now - 86400)]);
    } catch (PDOException $error) {
        // tables not created yet
    }
    return $deleted;
}

/** The cached profile of a system, or null; $maxAge = seconds it may be old (null = any age) */
function zk_profile_cached(PDO $db, $systemID, $now, $maxAge) {
    $stmt = $db->prepare('SELECT analysedAt, profile FROM zkill_profile_cache WHERE systemID = ?');
    $stmt->execute([$systemID]);
    $row = $stmt->fetch(PDO::FETCH_NUM);
    if (!$row || ($maxAge !== null && zk_unix($row[0]) <= $now - $maxAge)) return null;
    $profile = json_decode((string) $row[1], true);
    return is_array($profile) ? $profile : null;
}

/**
 * The profile of a viewed system: cached for an hour (ten minutes when nobody watches the system), else computed from the
 * stored kills (SQL aggregates) and cached in zkill_profile_cache. One request computes at a time per system (MySQL
 * GET_LOCK); the others wait briefly and use its result. @param int|null $retentionCoveredFrom start of the retention window's coverage
 */
function zk_profile_get(PDO $db, $systemID, $now, $retentionCoveredFrom) {
    $stmt = $db->prepare('SELECT keepSince FROM zkill_system_keep WHERE systemID = ?');
    $stmt->execute([$systemID]);
    $keepSince = $stmt->fetchColumn();
    $watched = $keepSince !== false && zk_keep_days() > 0;
    $ttl = $watched ? ZK_PROFILE_TTL : ZK_PROFILE_TTL_UNWATCHED;
    $cached = zk_profile_cached($db, $systemID, $now, $ttl);
    if ($cached) return $cached;

    $lock = 'zkprofile_' . (int) $systemID;
    $locked = false;
    if ($db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql') {
        $got = $db->prepare('SELECT GET_LOCK(?, ?)');
        $got->execute([$lock, ZK_PROFILE_LOCK_WAIT]);
        $locked = (int) $got->fetchColumn() === 1;
        // Another request may have finished while this one waited (or, without the lock, use whatever there is)
        $cached = zk_profile_cached($db, $systemID, time(), $ttl) ?: ($locked ? null : zk_profile_cached($db, $systemID, $now, null));
        if ($cached) {
            if ($locked) $db->prepare('SELECT RELEASE_LOCK(?)')->execute([$lock]);
            return $cached;
        }
    }
    try {
        // Before the system was watched only the retention window is known; once watched, everything since then is
        $since = $keepSince === false ? null : zk_unix($keepSince);
        $coveredFrom = $watched ? min($since, $retentionCoveredFrom ?? $since) : $retentionCoveredFrom;
        $cappedFrom = $watched ? zk_profile_capped_from($db, $systemID, $now) : null;
        if ($cappedFrom !== null) $coveredFrom = max($coveredFrom ?? $cappedFrom, $cappedFrom);
        $profile = zk_profile_compute($db, $systemID, $now, $coveredFrom);
        $db->prepare('DELETE FROM zkill_profile_cache WHERE systemID = ?')->execute([$systemID]);
        $db->prepare('INSERT INTO zkill_profile_cache (systemID, analysedAt, profile) VALUES (?, ?, ?)')
            ->execute([$systemID, gmdate('Y-m-d H:i:s', $now), json_encode($profile)]);
        return $profile;
    } finally {
        if ($locked) $db->prepare('SELECT RELEASE_LOCK(?)')->execute([$lock]);
    }
}
