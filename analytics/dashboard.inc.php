<?php
// Fork-owned: the analytics dashboard's numbers (public/fork_analytics.php, app/js/fork/analytics-dashboard.js,
// docker/README.md#product-analytics). Read-only over the tables analytics/analytics.inc.php writes: a missing table (fresh
// install, analytics never on) reads as no data and is never created here.
//
// Everything returned is aggregated: never a uid, never a per-user row. Small cells are suppressed: a user count of 1-4 is
// returned as "<5" and a mask count of 1-2 as "<3"; a percentage whose count is suppressed is left out, and a split whose
// parts would reveal a suppressed part is hidden as a whole. Suppression is per cell: differences between cells (active
// minus eligible, say) can still give a small number away. Fine for an operator-only view without per-user rows.
//
// Salt replacement (every ANALYTICS_DAYS, analytics.inc.php) gives everyone a new uid, so a window that includes days on
// both sides counts people active on both sides twice. Every view says so (`rotation`). Per-uid measures (repeat,
// retained, time to first use) keep all data: a replacement only splits a person into two uids, a slight undercount.
//
// Windows end on $today (UTC date, inclusive): "28 days" = $today and the 27 days before it. "Use" = the feature's use
// actions in the catalog (command, opened and its `use` words), as analytics_is_use counts it for masks.

require_once(__DIR__ . '/analytics.inc.php');

const DASH_WINDOW = 28;
const DASH_WEEKS = 12;
const DASH_MIN_USERS = 5;
const DASH_MIN_MASKS = 3;
const DASH_REPEAT_DAYS = 3;          // distinct use-days that make a user a repeat user
const DASH_NEVER_AGE = 60;           // days since release before a feature is judged "never used"
const DASH_LAUNCHES = 15;
const DASH_LAUNCH_DAYS = [1, 7, 14, 28];
const DASH_LAUNCH_FLAG_PCT = 10;     // tried by day 14 below this: flagged
const DASH_SILENT_DAYS = 7;          // released this long with no event of any kind: tracking may be broken
const DASH_WHATSNEW = __DIR__ . '/../public/whats-new/features.json';
const DASH_CACHE_SECONDS = 120;
const DASH_MODES = ['access', 'features', 'funnel', 'launches', 'off', 'never', 'health', 'tips'];

// ---- access ----

/** Character ids in ANALYTICS_ADMINS (comma or space separated); empty = nobody, the dashboard is off */
function dash_admin_ids() {
    $raw = analytics_setting('ANALYTICS_ADMINS');
    if (!is_string($raw) && !is_int($raw)) return [];
    $out = [];
    foreach (preg_split('/[\s,;]+/', (string) $raw) as $part) {
        if (preg_match('/^[1-9][0-9]{0,19}$/', $part)) $out[] = $part;
    }
    return array_values(array_unique($out));
}

function dash_is_admin($characterID) {
    $id = (string) $characterID;
    return $id !== '' && $id !== '0' && in_array($id, dash_admin_ids(), true);
}

// ---- small cells and statistics ----

/** A user count as shown: 0, "<5" or the number */
function dash_users($n) {
    $n = (int) $n;
    return $n > 0 && $n < DASH_MIN_USERS ? '<' . DASH_MIN_USERS : $n;
}

/** A mask count as shown: 0, "<3" or the number */
function dash_masks($n) {
    $n = (int) $n;
    return $n > 0 && $n < DASH_MIN_MASKS ? '<' . DASH_MIN_MASKS : $n;
}

function dash_small($n) {
    return $n > 0 && $n < DASH_MIN_USERS;
}

/** Whole percent of $k in $n, or null when $k is suppressed or $n is 0 */
function dash_pct($k, $n) {
    if ($n <= 0 || dash_small($k) || dash_small($n)) return null;
    return (int) round(100 * $k / $n);
}

/** Wilson score 95% interval of $k successes in $n, as whole percents [lo, hi]; null for $n = 0 */
function dash_wilson($k, $n, $z = 1.96) {
    if ($n <= 0) return null;
    $p = $k / $n;
    $z2 = $z * $z;
    $den = 1 + $z2 / $n;
    $mid = ($p + $z2 / (2 * $n)) / $den;
    $half = $z * sqrt($p * (1 - $p) / $n + $z2 / (4 * $n * $n)) / $den;
    return [(int) floor(100 * max(0, $mid - $half)), (int) ceil(100 * min(1, $mid + $half))];
}

function dash_median(array $values) {
    if (!$values) return null;
    sort($values);
    $c = count($values);
    $m = intdiv($c, 2);
    return $c % 2 ? $values[$m] : ($values[$m - 1] + $values[$m]) / 2;
}

// ---- dates ----

function dash_day($today, $offset) {
    return gmdate('Y-m-d', strtotime($today . ' 00:00:00 UTC') + $offset * 86400);
}

/** Days from $a to $b (both Y-m-d) */
function dash_days_between($a, $b) {
    return (int) round((strtotime($b . ' 00:00:00 UTC') - strtotime($a . ' 00:00:00 UTC')) / 86400);
}

// ---- catalog and What's New ----

/** The catalog's features with what the dashboard shows: id, title, section, prs, kind, audience, settingsKey, use, released */
function dash_features($catalogPath = ANALYTICS_CATALOG, $whatsNewPath = DASH_WHATSNEW) {
    $json = is_file($catalogPath) ? json_decode((string) file_get_contents($catalogPath), true) : null;
    $allowed = analytics_catalog($catalogPath);
    $dates = [];
    foreach (dash_whatsnew($whatsNewPath) as $e) $dates[$e['pr']] = $e['date'];
    $out = [];
    foreach (is_array($json) && isset($json['features']) && is_array($json['features']) ? $json['features'] : [] as $f) {
        if (!is_array($f) || !isset($f['id']) || !isset($allowed[$f['id']])) continue;
        $prs = isset($f['prs']) && is_array($f['prs']) ? array_values(array_filter($f['prs'], 'is_int')) : [];
        $released = null;
        foreach ($prs as $pr) {
            if (isset($dates[$pr]) && ($released === null || $dates[$pr] < $released)) $released = $dates[$pr];
        }
        $out[$f['id']] = [
            'id' => $f['id'],
            'title' => isset($f['title']) && is_string($f['title']) ? $f['title'] : $f['id'],
            'section' => isset($f['section']) && is_string($f['section']) ? $f['section'] : '',
            'prs' => $prs,
            'kind' => isset($f['kind']) && is_string($f['kind']) ? $f['kind'] : 'active',
            'audience' => isset($f['audience']) && is_string($f['audience']) ? $f['audience'] : 'all',
            'settingsKey' => isset($f['settingsKey']) && is_string($f['settingsKey']) ? $f['settingsKey'] : null,
            'use' => array_keys($allowed[$f['id']]['use']),
            'released' => $released,
        ];
    }
    return $out;
}

/** What's New entries, newest first: [['pr' => int, 'date' => 'Y-m-d', 'title' => string]] */
function dash_whatsnew($path = DASH_WHATSNEW) {
    $json = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
    $out = [];
    foreach (is_array($json) && isset($json['features']) && is_array($json['features']) ? $json['features'] : [] as $e) {
        if (!is_array($e) || !isset($e['pr']) || !is_int($e['pr']) || !isset($e['date']) || !is_string($e['date'])
            || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $e['date'])) continue;
        $out[] = ['pr' => $e['pr'], 'date' => $e['date'], 'title' => isset($e['title']) && is_string($e['title']) ? $e['title'] : ''];
    }
    return $out;
}

// ---- reading ----

/** Rows of a read-only query; [] when a table doesn't exist yet */
function dash_rows(PDO $db, $sql, array $params = []) {
    try {
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll(PDO::FETCH_NUM);
    } catch (PDOException $e) {
        if ($e->getCode() === '42S02') return [];
        throw $e;
    }
}

/**
 * Who used each feature on which day since $from: [feature => [uid => [day => true]]]. One query: the (feature, action)
 * pairs that count as use, from the catalog.
 */
function dash_use_days(PDO $db, array $features, $from, $to) {
    $pairs = [];
    $params = [$from, $to];
    foreach ($features as $f) {
        foreach ($f['use'] as $a) {
            $pairs[] = '(?, ?)';
            $params[] = $f['id'];
            $params[] = $a;
        }
    }
    $out = [];
    if (!$pairs) return $out;
    $rows = dash_rows($db, 'SELECT feature, uid, day FROM fork_analytics_daily WHERE day BETWEEN ? AND ? AND (feature, action) IN ('
        . implode(', ', $pairs) . ') GROUP BY feature, uid, day', $params);
    foreach ($rows as $r) $out[$r[0]][$r[1]][$r[2]] = true;
    return $out;
}

/** Days each user was active (app.active) since $from: [uid => [day => true]] */
function dash_active_days(PDO $db, $from, $to) {
    $out = [];
    foreach (dash_rows($db, "SELECT uid, day FROM fork_analytics_daily WHERE feature = 'app' AND action = 'active' AND day BETWEEN ? AND ?", [$from, $to]) as $r) {
        $out[$r[0]][$r[1]] = true;
    }
    return $out;
}

/** Users with $action of each feature in the window: [feature => [uid => true]] */
function dash_action_users(PDO $db, $action, $from, $to) {
    $out = [];
    foreach (dash_rows($db, 'SELECT DISTINCT feature, uid FROM fork_analytics_daily WHERE action = ? AND day BETWEEN ? AND ?', [$action, $from, $to]) as $r) {
        $out[$r[0]][$r[1]] = true;
    }
    return $out;
}

/**
 * Users who have each feature turned off now: the daily snapshot ("disabled") on the user's last day with any event in the
 * window (the snapshot is sent with the first send of every day, so an older one may be out of date).
 */
function dash_off_users(PDO $db, $from, $to) {
    $out = [];
    $rows = dash_rows($db, "SELECT d.feature, d.uid FROM fork_analytics_daily d
        JOIN (SELECT uid, MAX(day) lastDay FROM fork_analytics_daily WHERE day BETWEEN ? AND ? GROUP BY uid) l ON l.uid = d.uid AND l.lastDay = d.day
        WHERE d.action = 'disabled'", [$from, $to]);
    foreach ($rows as $r) $out[$r[0]][$r[1]] = true;
    return $out;
}

/** Users with at least $min distinct days in $days ([uid => [day => true]]), optionally only days in [$from, $to] */
function dash_repeat_count(array $days, $min, $from = null, $to = null) {
    $n = 0;
    foreach ($days as $set) {
        $c = 0;
        foreach ($set as $d => $_) if (($from === null || $d >= $from) && ($to === null || $d <= $to)) $c++;
        if ($c >= $min) $n++;
    }
    return $n;
}

/** Users with a day in [$from, $to]: [uid => true] */
function dash_users_between(array $days, $from, $to) {
    $out = [];
    foreach ($days as $uid => $set) {
        foreach ($set as $d => $_) {
            if ($d >= $from && $d <= $to) { $out[$uid] = true; break; }
        }
    }
    return $out;
}

/** The current pseudonym salt's start date (fork_analytics_meta, date part only), or null */
function dash_salt_date(PDO $db) {
    $rows = dash_rows($db, "SELECT v FROM fork_analytics_meta WHERE k = 'salt'");
    return $rows && preg_match('/^\d{4}-\d{2}-\d{2}/', (string) $rows[0][0]) ? substr((string) $rows[0][0], 0, 10) : null;
}

/**
 * A salt replacement inside a window ($from, $today]: people active on both sides count twice. Only when rows from before
 * the replacement exist (the first salt of a fresh install splits nobody). ['date' => day replaced, 'until' => last day a
 * window of $days still includes days from before] or null.
 */
function dash_rotation(PDO $db, $from, $today, $days) {
    $r = dash_salt_date($db);
    if ($r === null || $r <= $from || $r > $today) return null;
    if (!dash_rows($db, 'SELECT 1 FROM fork_analytics_daily WHERE day < ? LIMIT 1', [$r])) return null;
    return ['date' => $r, 'until' => dash_day($r, $days - 1)];
}

// ---- views ----

/** 1. Features: every catalog feature, used or not */
function dash_view_features(PDO $db, $today) {
    $features = dash_features();
    $from = dash_day($today, -(DASH_WINDOW - 1));
    $from90 = dash_day($today, -(7 * DASH_WEEKS - 1));
    $active = dash_users_between(dash_active_days($db, $from, $today), $from, $today);
    $uses = dash_use_days($db, $features, $from90, $today);
    $shown = dash_action_users($db, 'shown', $from, $today);
    $off = dash_off_users($db, $from, $today);
    $masks = [];
    foreach (dash_rows($db, 'SELECT feature, COUNT(DISTINCT maskHash) FROM fork_analytics_mask WHERE day BETWEEN ? AND ? GROUP BY feature', [$from, $today]) as $r) {
        $masks[$r[0]] = (int) $r[1];
    }
    $lastEvent = [];
    foreach (dash_rows($db, 'SELECT feature, MAX(day) FROM fork_analytics_daily GROUP BY feature') as $r) $lastEvent[$r[0]] = $r[1];

    $rotation = dash_rotation($db, $from90, $today, 7 * DASH_WEEKS);

    $activeN = count($active);
    $rows = [];
    foreach ($features as $id => $f) {
        $useDays = isset($uses[$id]) ? $uses[$id] : [];
        $used = dash_users_between($useDays, $from, $today);
        $usedN = count($used);
        $exposedN = count(array_replace(isset($shown[$id]) ? $shown[$id] : [], $used));
        $offSet = isset($off[$id]) ? array_intersect_key($off[$id], $active) : [];
        $offN = count($offSet);
        $eligible = array_diff_key($active, $offSet);
        $eligibleN = count($eligible);
        $usedEligibleN = count(array_intersect_key($used, $eligible));   // adoption: only users in the denominator
        $repeatN = dash_repeat_count(array_intersect_key($useDays, $used), DASH_REPEAT_DAYS, $from, $today);
        $adoption = null;
        if ($eligibleN > 0 && !dash_small($usedEligibleN) && !dash_small($eligibleN)) {
            $ci = dash_wilson($usedEligibleN, $eligibleN);
            $adoption = ['pct' => (int) round(100 * $usedEligibleN / $eligibleN), 'lo' => $ci[0], 'hi' => $ci[1]];
        }
        $spark = [];
        for ($w = DASH_WEEKS - 1; $w >= 0; $w--) {
            $wTo = dash_day($today, -7 * $w);
            $wFrom = dash_day($today, -7 * $w - 6);
            $spark[] = $f['released'] !== null && $wTo < $f['released'] ? null : dash_users(count(dash_users_between($useDays, $wFrom, $wTo)));
        }
        $flags = [];
        if ($f['released'] !== null && dash_days_between($f['released'], $today) >= DASH_SILENT_DAYS
            && (!isset($lastEvent[$id]) || $lastEvent[$id] < $f['released'])) {
            $flags[] = 'silent';
        }
        if ($f['kind'] === 'active' && $usedN === 0) $flags[] = 'unused';
        $rows[] = [
            'id' => $id, 'title' => $f['title'], 'section' => $f['section'], 'prs' => $f['prs'], 'released' => $f['released'],
            'kind' => $f['kind'], 'audience' => $f['audience'], 'toggle' => $f['settingsKey'] !== null,
            'eligible' => dash_users($eligibleN),
            'exposed' => dash_users($exposedN),
            'used' => dash_users($usedN),
            'adoption' => $adoption, 'usedEligible' => dash_users($usedEligibleN),
            'repeat' => ['users' => dash_users($repeatN), 'pct' => dash_small($usedN) ? null : dash_pct($repeatN, $usedN)],
            'optOut' => $f['settingsKey'] === null ? null : ['users' => dash_users($offN), 'pct' => dash_pct($offN, $activeN)],
            'masks' => dash_masks(isset($masks[$id]) ? $masks[$id] : 0),
            'spark' => $spark,
            'flags' => $flags,
        ];
    }
    return ['today' => $today, 'window' => DASH_WINDOW, 'active' => dash_users($activeN), 'features' => $rows,
        'rotation' => $rotation];
}

/** 2. Funnel of one feature: eligible -> exposed -> tried -> repeat -> retained, and the median time from first seen to first use */
function dash_view_funnel(PDO $db, $today, $featureId) {
    $features = dash_features();
    if (!isset($features[$featureId])) return null;
    $f = $features[$featureId];
    $from = dash_day($today, -(DASH_WINDOW - 1));
    $rotation = dash_rotation($db, $from, $today, DASH_WINDOW);
    $active = dash_users_between(dash_active_days($db, $from, $today), $from, $today);
    $off = dash_off_users($db, $from, $today);
    $eligible = array_diff_key($active, isset($off[$featureId]) ? $off[$featureId] : []);
    // Every step is a subset of the one it is measured against: exposed and tried of the eligible users
    $uses = dash_use_days($db, [$f], $from, $today);
    $useDays = array_intersect_key(isset($uses[$featureId]) ? $uses[$featureId] : [], $eligible);
    $shown = dash_action_users($db, 'shown', $from, $today);
    $exposedN = count(array_intersect_key(array_replace(isset($shown[$featureId]) ? $shown[$featureId] : [], $useDays), $eligible));
    $triedN = count($useDays);
    $repeatN = dash_repeat_count($useDays, DASH_REPEAT_DAYS);
    // Retained: used in two consecutive 7-day weeks of the window (weeks counted back from today); not a subset of repeat
    $retainedN = 0;
    foreach ($useDays as $set) {
        $weeks = [];
        foreach ($set as $d => $_) $weeks[intdiv(dash_days_between($d, $today), 7)] = true;
        for ($w = 0; $w < intdiv(DASH_WINDOW, 7) - 1; $w++) {
            if (isset($weeks[$w], $weeks[$w + 1])) { $retainedN++; break; }
        }
    }
    // Time from the first "shown" to the first use, per user (milestones: fork_analytics_user firstAt). After a salt
    // replacement in the kept data a returning person gets a new uid whose "first" milestones are just their next visit
    // (often seen and used the same day). So for a feature released before the replacement only milestones from before it
    // count (people who are really new since then are left out); a feature released since only has new ones.
    $kept = dash_rotation($db, dash_day($today, -(analytics_days() - 1)), $today, analytics_days());
    $since = $kept && $f['released'] !== null && $f['released'] >= $kept['date'] ? $kept['date'] : null;
    $before = $kept && !$since ? $kept['date'] : null;
    $milestonesFrom = $since ? strtotime($since . ' 00:00:00 UTC') : 0;
    $milestonesTo = $before ? strtotime($before . ' 00:00:00 UTC') : PHP_INT_MAX;
    $firstShown = [];
    $firstUse = [];
    $place = implode(', ', array_fill(0, count($f['use']), '?'));
    $rows = $f['use'] ? dash_rows($db, "SELECT uid, action, firstAt FROM fork_analytics_user WHERE feature = ? AND action IN ('shown', $place)",
        array_merge([$featureId], $f['use'])) : [];
    foreach ($rows as $r) {
        $t = strtotime($r[2] . ' UTC');
        if ($r[1] === 'shown') $firstShown[$r[0]] = $t;
        if (in_array($r[1], $f['use'], true) && (!isset($firstUse[$r[0]]) || $t < $firstUse[$r[0]])) $firstUse[$r[0]] = $t;
    }
    $hours = [];
    $usedFirst = 0;
    foreach ($firstUse as $uid => $t) {
        if (!isset($firstShown[$uid]) || $firstShown[$uid] < $milestonesFrom || $t < $milestonesFrom) continue;
        if ($firstShown[$uid] >= $milestonesTo || $t >= $milestonesTo) continue;
        if ($t < $firstShown[$uid]) { $usedFirst++; continue; }
        $hours[] = ($t - $firstShown[$uid]) / 3600;
    }
    $median = count($hours) >= DASH_MIN_USERS ? round(dash_median($hours), 1) : null;
    return [
        'today' => $today, 'window' => DASH_WINDOW, 'from' => $from, 'rotation' => $rotation,
        'feature' => ['id' => $featureId, 'title' => $f['title'], 'released' => $f['released'], 'kind' => $f['kind']],
        'steps' => [
            ['key' => 'eligible', 'users' => dash_users(count($eligible)), 'base' => null],
            ['key' => 'exposed', 'users' => dash_users($exposedN), 'base' => 'eligible'],
            ['key' => 'tried', 'users' => dash_users($triedN), 'base' => 'exposed'],
            ['key' => 'repeat', 'users' => dash_users($repeatN), 'base' => 'tried'],
            ['key' => 'retained', 'users' => dash_users($retainedN), 'base' => 'tried'],
        ],
        'toUse' => ['medianHours' => $median, 'users' => dash_users(count($hours)), 'usedBeforeShown' => dash_users($usedFirst),
            'since' => $since, 'before' => $before, 'saltReplaced' => $kept ? $kept['date'] : null],
    ];
}

/** 3. Launches: the last What's New PRs, share of active users who tried the feature by day 1/7/14/28 after the release date */
function dash_view_launches(PDO $db, $today) {
    $features = dash_features();
    $byPr = [];
    foreach ($features as $f) foreach ($f['prs'] as $pr) $byPr[$pr] = $f;
    $entries = array_slice(dash_whatsnew(), 0, DASH_LAUNCHES);
    $oldest = $today;
    foreach ($entries as $e) if ($e['date'] < $oldest) $oldest = $e['date'];
    // The first day with any data (a fresh install, or retention): earlier launches can't be measured
    $first = dash_rows($db, 'SELECT MIN(day) FROM fork_analytics_daily');
    $firstData = $first && $first[0][0] !== null ? $first[0][0] : null;
    $active = dash_active_days($db, $oldest, $today);
    $uses = dash_use_days($db, array_values(array_filter($features, function ($f) use ($byPr, $entries) {
        foreach ($entries as $e) if (isset($byPr[$e['pr']]) && $byPr[$e['pr']]['id'] === $f['id']) return true;
        return false;
    })), $oldest, $today);
    $out = [];
    foreach ($entries as $e) {
        $f = isset($byPr[$e['pr']]) ? $byPr[$e['pr']] : null;
        $days = [];
        $flag = false;
        foreach (DASH_LAUNCH_DAYS as $k) {
            $end = dash_day($e['date'], $k - 1);
            if (!$f || $end > $today) { $days[(string) $k] = null; continue; }
            if ($firstData === null || $e['date'] < $firstData) { $days[(string) $k] = ['noData' => true]; continue; }
            $base = dash_users_between($active, $e['date'], $end);
            $tried = array_intersect_key(dash_users_between(isset($uses[$f['id']]) ? $uses[$f['id']] : [], $e['date'], $end), $base);
            $pct = count($base) ? 100 * count($tried) / count($base) : null;
            $days[(string) $k] = ['users' => dash_users(count($tried)), 'active' => dash_users(count($base)),
                'pct' => $pct === null || dash_small(count($tried)) || dash_small(count($base)) ? null : (int) round($pct)];
            if ($k === 14 && $pct !== null && $pct < DASH_LAUNCH_FLAG_PCT) $flag = true;
        }
        $out[] = ['pr' => $e['pr'], 'date' => $e['date'], 'title' => $e['title'],
            'feature' => $f ? ['id' => $f['id'], 'title' => $f['title'], 'followUp' => $f['prs'] && min($f['prs']) !== $e['pr']] : null,
            'days' => $days, 'flag' => $flag];
    }
    return ['today' => $today, 'launches' => $out, 'firstData' => $firstData,
        'rotation' => dash_rotation($db, $oldest, $today, dash_days_between($oldest, $today) + 1)];
}

/** 4. Turned off: features with a Settings toggle, how many have it off now and who switched it off after / without using it */
function dash_view_off(PDO $db, $today) {
    $features = array_filter(dash_features(), function ($f) { return $f['settingsKey'] !== null; });
    $from = dash_day($today, -(DASH_WINDOW - 1));
    $active = dash_users_between(dash_active_days($db, $from, $today), $from, $today);
    $off = dash_off_users($db, $from, $today);
    $turnedOff = dash_action_users($db, 'setting_off', $from, $today);
    $turnedOn = dash_action_users($db, 'setting_on', $from, $today);
    // Milestones: when each user last turned a feature off and first used it
    $lastOff = [];
    $firstUse = [];
    foreach (dash_rows($db, 'SELECT uid, feature, action, firstAt, lastAt FROM fork_analytics_user WHERE action = ? OR feature IN ('
        . implode(', ', array_fill(0, max(1, count($features)), '?')) . ')', array_merge(['setting_off'], $features ? array_keys($features) : [''])) as $r) {
        list($uid, $fid, $action, $first, $last) = $r;
        if ($action === 'setting_off') $lastOff[$fid][$uid] = $last;
        if (isset($features[$fid]) && in_array($action, $features[$fid]['use'], true) && (!isset($firstUse[$fid][$uid]) || $first < $firstUse[$fid][$uid])) {
            $firstUse[$fid][$uid] = $first;
        }
    }
    $activeN = count($active);
    $rows = [];
    foreach ($features as $id => $f) {
        $offN = isset($off[$id]) ? count(array_intersect_key($off[$id], $active)) : 0;
        $who = isset($turnedOff[$id]) ? $turnedOff[$id] : [];
        $after = 0;
        foreach ($who as $uid => $_) {
            if (isset($firstUse[$id][$uid], $lastOff[$id][$uid]) && $firstUse[$id][$uid] <= $lastOff[$id][$uid]) $after++;
        }
        $without = count($who) - $after;
        $hideSplit = dash_small($after) || dash_small($without);
        $rows[] = [
            'id' => $id, 'title' => $f['title'], 'section' => $f['section'],
            'offNow' => dash_users($offN), 'pct' => dash_pct($offN, $activeN),
            'turnedOff' => dash_users(count($who)),
            'afterUsing' => $hideSplit ? null : $after,
            'withoutTrying' => $hideSplit ? null : $without,
            'turnedOn' => dash_users(isset($turnedOn[$id]) ? count($turnedOn[$id]) : 0),
        ];
    }
    return ['today' => $today, 'window' => DASH_WINDOW, 'active' => dash_users($activeN), 'features' => $rows,
        'rotation' => dash_rotation($db, $from, $today, DASH_WINDOW)];
}

/**
 * 5. Never used, released more than 60 days ago: an active feature with fewer than 5 users in the kept data or no repeat
 * user; a passive one (drawn on the map, no use events) with fewer than 5 users who had it on screen
 */
function dash_view_never(PDO $db, $today) {
    $features = dash_features();
    $from = dash_day($today, -(analytics_days() - 1));
    $rotation = dash_rotation($db, $from, $today, analytics_days());
    $uses = dash_use_days($db, $features, $from, $today);
    $shown = dash_action_users($db, 'shown', $from, $today);
    $candidates = [];
    $tooNew = [];
    foreach ($features as $id => $f) {
        $days = isset($uses[$id]) ? $uses[$id] : [];
        $usersN = count($days);
        if ($f['kind'] === 'passive') {
            $seenN = count(array_replace(isset($shown[$id]) ? $shown[$id] : [], $days));
            if ($seenN >= DASH_MIN_USERS) continue;
            $repeatN = null;
            $reason = 'fewseen';
        } else {
            $seenN = null;
            $repeatN = dash_repeat_count($days, DASH_REPEAT_DAYS);
            if ($usersN >= DASH_MIN_USERS && $repeatN > 0) continue;
            $reason = $usersN < DASH_MIN_USERS ? 'few' : 'norepeat';
        }
        $age = $f['released'] === null ? null : dash_days_between($f['released'], $today);
        $row = ['id' => $id, 'title' => $f['title'], 'section' => $f['section'], 'kind' => $f['kind'], 'released' => $f['released'],
            'age' => $age, 'users' => dash_users($usersN), 'seen' => $seenN === null ? null : dash_users($seenN),
            'repeat' => $repeatN === null ? null : dash_users($repeatN), 'reason' => $reason];
        if ($age !== null && $age > DASH_NEVER_AGE) $candidates[] = $row; else $tooNew[] = $row;
    }
    return ['today' => $today, 'days' => analytics_days(), 'minAge' => DASH_NEVER_AGE, 'candidates' => $candidates, 'tooNew' => $tooNew,
        'rotation' => $rotation];
}

/** 6. App health: daily / weekly active users, new users, masks, and when people are active */
function dash_view_health(PDO $db, $today) {
    $from84 = dash_day($today, -(7 * DASH_WEEKS - 1));
    $active = dash_active_days($db, $from84, $today);
    $dau = [];
    $last7 = [];
    for ($i = DASH_WINDOW - 1; $i >= 0; $i--) {
        $d = dash_day($today, -$i);
        $n = 0;
        foreach ($active as $set) if (isset($set[$d])) $n++;
        $dau[] = ['day' => $d, 'users' => dash_users($n)];
        if ($i >= 1 && $i <= 7) $last7[] = $n;   // the 7 full days before today
    }
    $wauN = count(dash_users_between($active, dash_day($today, -6), $today));
    $mauN = count(dash_users_between($active, dash_day($today, -(DASH_WINDOW - 1)), $today));
    $weeks = [];
    for ($w = DASH_WEEKS - 1; $w >= 0; $w--) {
        $weeks[] = dash_users(count(dash_users_between($active, dash_day($today, -7 * $w - 6), dash_day($today, -7 * $w))));
    }
    $rotation = dash_rotation($db, $from84, $today, 7 * DASH_WEEKS);
    // New users: after a salt replacement everyone looks new, so a window that includes it has no honest number
    $new = function ($days) use ($db, $today, $rotation) {
        if ($rotation && $rotation['date'] > dash_day($today, -$days)) return null;
        $rows = dash_rows($db, "SELECT COUNT(*) FROM fork_analytics_user WHERE feature = 'app' AND action = 'active' AND firstAt >= ?",
            [dash_day($today, -($days - 1)) . ' 00:00:00']);
        return $rows ? (int) $rows[0][0] : 0;
    };
    $masks = function ($days) use ($db, $today) {
        $rows = dash_rows($db, 'SELECT COUNT(DISTINCT maskHash) FROM fork_analytics_mask WHERE day BETWEEN ? AND ?', [dash_day($today, -($days - 1)), $today]);
        return $rows ? (int) $rows[0][0] : 0;
    };
    // Active hours: the daily rows keep the minute of each feature/action's first event of the day (firstMinute), so a
    // cell counts user-days with something first happening in that UTC hour; later activity in a long session isn't seen
    $heat = array_fill(0, 7, array_fill(0, 24, 0));
    foreach (dash_rows($db, 'SELECT WEEKDAY(day), FLOOR(firstMinute / 60), COUNT(DISTINCT uid, day) FROM fork_analytics_daily
        WHERE day BETWEEN ? AND ? GROUP BY 1, 2', [dash_day($today, -(DASH_WINDOW - 1)), $today]) as $r) {
        $wd = (int) $r[0];
        $h = (int) $r[1];
        if ($wd >= 0 && $wd < 7 && $h >= 0 && $h < 24) $heat[$wd][$h] = dash_users($r[2]);
    }
    return [
        'today' => $today, 'window' => DASH_WINDOW,
        'dau' => $dau,
        'dauMedian7' => dash_users((int) round(dash_median($last7))),
        'wau' => dash_users($wauN), 'mau' => dash_users($mauN),
        'stickiness' => dash_small($wauN) || dash_small($mauN) || !$mauN ? null : (int) round(100 * $wauN / $mauN),
        'weeks' => $weeks,
        'new7' => ($n7 = $new(7)) === null ? null : dash_users($n7), 'new28' => ($n28 = $new(DASH_WINDOW)) === null ? null : dash_users($n28),
        'masks7' => dash_masks($masks(7)), 'masks28' => dash_masks($masks(DASH_WINDOW)),
        'heat' => $heat,
        'rotation' => $rotation,
    ];
}

/**
 * 7. Tips & What's New. Feature tips (the tips feature) report per feature `hint_shown` / `hint_acted`, and their outcome
 * as actions of feature `hints` (tip_shown, acted, got_it, closed, ignored, section_off; its `shown` is the usual
 * once-a-day exposure, not an outcome); "Show feature tips" is the `hints` setting (setting_off, disabled snapshot). Outcomes carry no feature, so they can't be split per tip.
 */
function dash_view_tips(PDO $db, $today) {
    $from = dash_day($today, -(DASH_WINDOW - 1));
    $features = dash_features();
    $active = dash_users_between(dash_active_days($db, $from, $today), $from, $today);
    $outcomes = [];
    foreach (dash_rows($db, "SELECT action, COUNT(DISTINCT uid), SUM(n) FROM fork_analytics_daily WHERE feature = 'hints' AND day BETWEEN ? AND ?
        AND action IN ('tip_shown', 'acted', 'got_it', 'closed', 'ignored', 'section_off') GROUP BY action ORDER BY action", [$from, $today]) as $r) {
        $users = (int) $r[1];
        $outcomes[] = ['action' => $r[0], 'users' => dash_users($users), 'events' => dash_small($users) ? null : (int) $r[2]];
    }
    // Per feature: who was shown its tip (first day in the window), who acted on it, who used the feature within 7 days
    $firstShown = [];
    $acted = [];
    foreach (dash_rows($db, "SELECT feature, uid, action, MIN(day) FROM fork_analytics_daily WHERE action IN ('hint_shown', 'hint_acted')
        AND day BETWEEN ? AND ? GROUP BY feature, uid, action", [$from, $today]) as $r) {
        if ($r[2] === 'hint_shown') $firstShown[$r[0]][$r[1]] = $r[3]; else $acted[$r[0]][$r[1]] = true;
    }
    $tipped = array_values(array_filter($features, function ($f) use ($firstShown) { return isset($firstShown[$f['id']]); }));
    $uses = dash_use_days($db, $tipped, $from, $today);
    $perFeature = [];
    foreach ($tipped as $f) {
        $id = $f['id'];
        $shownN = count($firstShown[$id]);
        $usedN = 0;
        foreach ($firstShown[$id] as $uid => $d) {
            $end = dash_day($d, 6);
            foreach (isset($uses[$id][$uid]) ? $uses[$id][$uid] : [] as $ud => $_) if ($ud >= $d && $ud <= $end) { $usedN++; break; }
        }
        $actedN = isset($acted[$id]) ? count(array_intersect_key($acted[$id], $firstShown[$id])) : 0;
        $perFeature[] = ['id' => $id, 'title' => $f['title'], 'shown' => dash_users($shownN),
            'acted' => dash_users($actedN), 'actedPct' => dash_pct($actedN, $shownN),
            'used7' => dash_users($usedN), 'used7Pct' => dash_pct($usedN, $shownN)];
    }
    $tipsOff = dash_action_users($db, 'setting_off', $from, $today);
    $off = dash_off_users($db, $from, $today);
    $offNowN = isset($off['hints']) ? count(array_intersect_key($off['hints'], $active)) : 0;
    $opened = dash_action_users($db, 'opened', $from, $today);
    // Releases: What's New entries grouped by date; who opened What's New within 7 days of each
    $dates = [];
    foreach (dash_whatsnew() as $e) $dates[$e['date']][] = $e['pr'];
    $dates = array_slice($dates, 0, 6, true);
    $oldest = $dates ? min(array_keys($dates)) : $today;
    $activeSince = dash_active_days($db, $oldest, $today);
    $opens = [];
    foreach (dash_rows($db, "SELECT uid, day FROM fork_analytics_daily WHERE feature = 'whatsNew' AND action = 'opened' AND day BETWEEN ? AND ?", [$oldest, $today]) as $r) {
        $opens[$r[0]][$r[1]] = true;
    }
    $releases = [];
    foreach ($dates as $date => $prs) {
        $end = min($today, dash_day($date, 6));
        $base = dash_users_between($activeSince, $date, $end);
        $who = array_intersect_key(dash_users_between($opens, $date, $end), $base);
        $releases[] = ['date' => $date, 'prs' => $prs, 'complete' => dash_day($date, 6) < $today,
            'active' => dash_users(count($base)), 'opened' => dash_users(count($who)), 'pct' => dash_pct(count($who), count($base))];
    }
    $start = min($from, $oldest);
    return [
        'today' => $today, 'window' => DASH_WINDOW,
        'hints' => $outcomes,
        'tips' => $perFeature,
        'tipsOff' => ['turnedOff' => dash_users(isset($tipsOff['hints']) ? count($tipsOff['hints']) : 0),
            'offNow' => dash_users($offNowN), 'pct' => dash_pct($offNowN, count($active)), 'active' => dash_users(count($active))],
        'whatsNew' => ['opened' => dash_users(isset($opened['whatsNew']) ? count($opened['whatsNew']) : 0), 'releases' => $releases],
        'rotation' => dash_rotation($db, $start, $today, dash_days_between($start, $today) + 1),
    ];
}

/** The view for a mode; null for an unknown mode or feature */
function dash_view(PDO $db, $mode, $today, $feature = null) {
    switch ($mode) {
        case 'features': return dash_view_features($db, $today);
        case 'funnel': return is_string($feature) && preg_match(ANALYTICS_FEATURE_RE, $feature) ? dash_view_funnel($db, $today, $feature) : null;
        case 'launches': return dash_view_launches($db, $today);
        case 'off': return dash_view_off($db, $today);
        case 'never': return dash_view_never($db, $today);
        case 'health': return dash_view_health($db, $today);
        case 'tips': return dash_view_tips($db, $today);
    }
    return null;
}

// ---- cache ----

/** A view from a short file cache (cache/, outside the web root): the answers are aggregated and hold no ids */
function dash_cached($key, callable $fn, $dir = null, $seconds = DASH_CACHE_SECONDS) {
    $dir = $dir === null ? __DIR__ . '/../cache' : $dir;
    $file = rtrim($dir, '/') . '/fork-analytics-' . hash('sha256', $key) . '.json';
    if ($seconds > 0 && is_file($file) && time() - (int) @filemtime($file) < $seconds) {
        $data = json_decode((string) @file_get_contents($file), true);
        if (is_array($data)) return $data;
    }
    $data = $fn();
    if ($seconds > 0 && is_array($data) && is_dir($dir) && is_writable($dir)) {
        $tmp = $file . '.' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, json_encode($data)) !== false) @rename($tmp, $file); else @unlink($tmp);
        // Now and then: drop answers (and stray temp files) older than a day
        if (mt_rand(1, 20) === 1) {
            foreach (glob(rtrim($dir, '/') . '/fork-analytics-*') ?: [] as $old) {
                if (time() - (int) @filemtime($old) > 86400) @unlink($old);
            }
        }
    }
    return $data;
}
