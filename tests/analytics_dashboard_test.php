<?php
// Fork-owned: tests for the analytics dashboard (analytics/dashboard.inc.php, public/fork_analytics.php) against the dev
// stack's database and nginx/PHP. The analytics tables are moved aside (renamed *_dashtest) for the run and put back at the
// end, so the numbers checked are exactly the rows seeded here.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/analytics_dashboard_test.php
// 1. Access list, suppression, Wilson interval.
// 2. Fresh install (no tables): every view answers with empty numbers and creates nothing.
// 3. Each view's numbers on seeded rows (fixed day 2026-10-30), suppression and hidden splits, a salt replacement.
// 4. public/fork_analytics.php over HTTP: login, the ANALYTICS_ADMINS check (403), access mode, no uids in answers.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/..');
$base = getenv('ANALYTICS_TEST_BASE') ?: 'http://127.0.0.1';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
require_once(__DIR__ . '/../analytics/dashboard.inc.php');   // no config.php: settings come from the environment

$failures = 0;
$count = 0;
function check($name, $actual, $expected) {
    global $failures, $count;
    $count++;
    if ($actual !== $expected) {
        $failures++;
        fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
    }
}
function by_id(array $rows, $id) { foreach ($rows as $r) if ($r['id'] === $id) return $r; return null; }
function exists($table) { global $db; return $db->query("SHOW TABLES LIKE '$table'")->fetchColumn() !== false; }

const TABLES = ['fork_analytics_daily', 'fork_analytics_user', 'fork_analytics_mask'];
// Move the real tables aside; put them back however the run ends
foreach (TABLES as $t) {
    $db->exec("DROP TABLE IF EXISTS {$t}_dashtest");
    if (exists($t)) $db->exec("RENAME TABLE $t TO {$t}_dashtest");
}
$adminEnv = getenv('ANALYTICS_ADMINS');
function salt_row() { global $db; try { return $db->query("SELECT v FROM fork_analytics_meta WHERE k = 'salt'")->fetchColumn(); } catch (PDOException $e) { return false; } }
function set_salt_date($date) { global $db; analytics_ensure_schema($db); $db->prepare("REPLACE INTO fork_analytics_meta (k, v) VALUES ('salt', ?)")->execute([$date . ':' . str_repeat('ab', 32)]); }
$savedSalt = salt_row();
register_shutdown_function(function () use ($db, $adminEnv, $savedSalt) {
    if ($savedSalt !== false) $db->prepare("REPLACE INTO fork_analytics_meta (k, v) VALUES ('salt', ?)")->execute([$savedSalt]);
    else { try { $db->exec("DELETE FROM fork_analytics_meta WHERE k = 'salt'"); } catch (PDOException $e) { } }
    foreach (TABLES as $t) {
        if (exists("{$t}_dashtest")) { $db->exec("DROP TABLE IF EXISTS $t"); $db->exec("RENAME TABLE {$t}_dashtest TO $t"); }
    }
    foreach (glob(__DIR__ . '/../cache/fork-analytics-*.json') ?: [] as $f) @unlink($f);
    foreach (glob('/var/lib/php/session/sess_dashtest*') ?: [] as $f) @unlink($f);
});
putenv('ANALYTICS_DAYS=90');
putenv('ANALYTICS_ENABLED=true');

// ---- 1. pure helpers ----
putenv('ANALYTICS_ADMINS=96379789, 12345;  7');
check('admins: parsed', dash_admin_ids(), ['96379789', '12345', '7']);
check('admins: member', [dash_is_admin(12345), dash_is_admin('7'), dash_is_admin(1234), dash_is_admin(0), dash_is_admin('')], [true, true, false, false, false]);
putenv('ANALYTICS_ADMINS=');
check('admins: empty list = nobody', [dash_admin_ids(), dash_is_admin(12345)], [[], false]);
putenv('ANALYTICS_ADMINS=abc,1e5,-3');
check('admins: junk ignored', dash_admin_ids(), []);
check('users: 0 shown, 1-4 suppressed, 5+ shown', [dash_users(0), dash_users(1), dash_users(4), dash_users(5), dash_users(40)], [0, '<5', '<5', 5, 40]);
check('masks: 1-2 suppressed', [dash_masks(0), dash_masks(2), dash_masks(3)], [0, '<3', 3]);
check('pct: left out when a count is suppressed', [dash_pct(3, 40), dash_pct(10, 40), dash_pct(10, 0), dash_pct(0, 40)], [null, 25, null, 0]);
check('wilson: 10 of 40', dash_wilson(10, 40), [14, 41]);
check('wilson: 0 of 20 / 20 of 20 / no sample', [dash_wilson(0, 20), dash_wilson(20, 20), dash_wilson(0, 0)], [[0, 17], [83, 100], null]);
check('median', [dash_median([3, 1, 2]), dash_median([4, 1, 2, 3]), dash_median([])], [2, 2.5, null]);
$features = dash_features();
check('catalog: release date = earliest What\'s New date of its PRs', [$features['jumpPlanner']['released'], $features['maskAdmins']['released']], ['2026-10-11', null]);
check('catalog: use actions', $features['jumpPlanner']['use'], ['command', 'opened', 'route_planned']);

// ---- 2. fresh install ----
$T = '2026-10-30';
foreach (['features', 'launches', 'off', 'never', 'health', 'tips'] as $m) {
    $v = dash_view($db, $m, $T);
    check("no tables: $m answers", is_array($v), true);
}
$v = dash_view($db, 'features', $T);
check('no tables: every feature listed with zeros', [count($v['features']) === count($features), $v['active'], by_id($v['features'], 'jumpPlanner')['used']], [true, 0, 0]);
check('no tables: health is zero', [dash_view($db, 'health', $T)['mau'], dash_view($db, 'health', $T)['heat'][0][0]], [0, 0]);
check('no tables: funnel', dash_view($db, 'funnel', $T, 'jumpPlanner')['steps'][2], ['key' => 'tried', 'users' => 0, 'base' => 'exposed']);
check('no tables: none created', array_map('exists', TABLES), [false, false, false]);
check('unknown view / feature', [dash_view($db, 'nope', $T), dash_view($db, 'funnel', $T, 'nope'), dash_view($db, 'funnel', $T, "x' OR 1")], [null, null, null]);

// ---- 3. seeded numbers ----
analytics_ensure_schema($db);
set_salt_date('2026-01-01');   // no salt replacement inside any window (see the end of this section)
$day = function ($offset) use ($T) { return dash_day($T, $offset); };
$daily = $db->prepare('INSERT INTO fork_analytics_daily (day, feature, action, uid, n, firstMinute) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE n = n + 1');
$user = $db->prepare('INSERT INTO fork_analytics_user (uid, feature, action, firstAt, lastAt, n) VALUES (?, ?, ?, ?, ?, 1)');
$mask = $db->prepare('INSERT IGNORE INTO fork_analytics_mask (day, maskHash, feature) VALUES (?, ?, ?)');
$u = function ($i) { return sprintf('dashtest%08d', $i); };
$add = function ($offset, $f, $a, $i, $minute = 1200) use ($daily, $day, $u) { $daily->execute([$day($offset), $f, $a, $u($i), 1, $minute]); };
for ($i = 1; $i <= 12; $i++) {
    $add(0, 'app', 'active', $i);
    $user->execute([$u($i), 'app', 'active', $i <= 10 ? '2026-09-01 10:00:00' : $T . ' 20:00:00', $T . ' 20:00:00']);
}
for ($i = 1; $i <= 10; $i++) $add(-13, 'app', 'active', $i, 600);             // 2026-10-17: release day of #114
// Jump planner: u1-5 on 4 days (today, yesterday, 8 and 13 days ago), u6-7 today; seen by u8-10; u11 has it off
for ($i = 1; $i <= 5; $i++) foreach ([0, -1, -8, -13] as $o) $add($o, 'jumpPlanner', 'opened', $i);
$add(0, 'jumpPlanner', 'route_planned', 6);
$add(0, 'jumpPlanner', 'command', 7);
for ($i = 8; $i <= 10; $i++) $add(0, 'jumpPlanner', 'shown', $i);
$add(0, 'jumpPlanner', 'disabled', 11);
$add(-12, 'jumpPlanner', 'setting_changed', 12);                               // not a use
$add(-5, 'jumpPlanner', 'opened', 11);                                         // used it, then turned it off: not eligible
for ($i = 1; $i <= 5; $i++) {                                                  // seen, then used i hours later
    $user->execute([$u($i), 'jumpPlanner', 'shown', '2026-10-17 10:00:00', $T . ' 20:00:00']);
    $user->execute([$u($i), 'jumpPlanner', 'opened', sprintf('2026-10-17 %02d:00:00', 10 + $i), $T . ' 20:00:00']);
}
$user->execute([$u(6), 'jumpPlanner', 'route_planned', '2026-10-16 09:00:00', $T . ' 20:00:00']);
$user->execute([$u(6), 'jumpPlanner', 'shown', '2026-10-17 09:00:00', $T . ' 20:00:00']);   // used before seen
foreach (['m1', 'm2', 'm3', 'm4'] as $m) $mask->execute([$T, str_pad($m, 16, '0'), 'jumpPlanner']);
// Size tags off for u1-6 (a later old snapshot of u7 doesn't count: not on u7's last day)
for ($i = 1; $i <= 6; $i++) $add(0, 'sizeTags', 'disabled', $i);
$add(-1, 'sizeTags', 'disabled', 7);
// Region map: 3 users, 2 masks
for ($i = 1; $i <= 3; $i++) $add(0, 'regionMap', 'opened', $i);
foreach (['m1', 'm2'] as $m) $mask->execute([$T, str_pad($m, 16, '0'), 'regionMap']);
// Turned off: return bookmark by u1-10, u1-5 after using it; kill reporting by u1-6, only u1 after using it
for ($i = 1; $i <= 10; $i++) {
    $add(-2, 'jumpReturn', 'setting_off', $i);
    $user->execute([$u($i), 'jumpReturn', 'setting_off', $day(-2) . ' 20:00:00', $day(-2) . ' 20:00:00']);
    if ($i <= 5) $user->execute([$u($i), 'jumpReturn', 'copied', '2026-10-20 08:00:00', '2026-10-20 08:00:00']);
}
for ($i = 1; $i <= 6; $i++) {
    $add(-3, 'killReporting', 'setting_off', $i);
    $user->execute([$u($i), 'killReporting', 'setting_off', $day(-3) . ' 20:00:00', $day(-3) . ' 20:00:00']);
}
$user->execute([$u(1), 'killReporting', 'clicked', '2026-10-14 08:00:00', '2026-10-14 08:00:00']);
$add(-1, 'killReporting', 'setting_on', 2);
// Tips: shown to 6, got_it by 2
for ($i = 1; $i <= 6; $i++) $add(0, 'hints', 'tip_shown', $i);
$add(0, 'hints', 'shown', 9);                                                 // exposure, not an outcome
for ($i = 1; $i <= 2; $i++) $add(0, 'hints', 'got_it', $i);
// Passive features: high-sec region seen by u1-6, size tags by nobody
for ($i = 1; $i <= 6; $i++) $add(0, 'highsecRegion', 'shown', $i);
// Jump planner tip: shown to u1-6 ten days ago, acted on by u1-5 (who used it 2 days later); tips turned off by u7, off for u8
for ($i = 1; $i <= 6; $i++) $add(-10, 'jumpPlanner', 'hint_shown', $i);
for ($i = 1; $i <= 5; $i++) $add(-10, 'jumpPlanner', 'hint_acted', $i);
$add(-2, 'hints', 'setting_off', 7);
$add(0, 'hints', 'disabled', 8);
// What's New opened in the week after 2026-10-17 by u1-5
for ($i = 1; $i <= 5; $i++) $add(-13, 'whatsNew', 'opened', $i);

$v = dash_view($db, 'features', $T);
$jp = by_id($v['features'], 'jumpPlanner');
check('features: active users', $v['active'], 12);
check('features: jump planner counts (exact eligible)', [$jp['eligible'], $jp['exposed'], $jp['used'], $jp['usedEligible']], [11, 11, 8, 7]);
check('features: adoption = eligible users who used it / eligible, Wilson interval', $jp['adoption'], ['pct' => 64, 'lo' => 35, 'hi' => 85]);
check('features: repeat', $jp['repeat'], ['users' => 5, 'pct' => 63]);
check('features: opt-out suppressed', $jp['optOut'], ['users' => '<5', 'pct' => null]);
check('features: masks', $jp['masks'], 4);
check('features: sparkline (weeks before the release are null)', $jp['spark'], array_merge(array_fill(0, 9, null), [0, 5, 8]));
check('features: no flags on a used feature', $jp['flags'], []);
$st = by_id($v['features'], 'sizeTags');
check('features: size tags off for 6 (old snapshot ignored)', [$st['eligible'], $st['optOut']], [6, ['users' => 6, 'pct' => 50]]);
$rm = by_id($v['features'], 'regionMap');
check('features: small use suppressed, no adoption, masks <3', [$rm['used'], $rm['adoption'], $rm['repeat'], $rm['masks']], ['<5', null, ['users' => 0, 'pct' => null], '<3']);
$at = by_id($v['features'], 'apiTokens');
check('features: zero use flagged, nothing at all since release flagged', $at['flags'], ['silent', 'unused']);
check('features: a passive feature with only snapshots is not silent', by_id($v['features'], 'sizeTags')['flags'], []);
check('features: no uid anywhere', strpos(json_encode($v), 'dashtest'), false);
check('features: no salt replacement in the window', $v['rotation'], null);

$f = dash_view($db, 'funnel', $T, 'jumpPlanner');
check('funnel: steps (exposed and tried of the eligible)', array_column($f['steps'], 'users'), [11, 10, 7, 5, 5]);
check('funnel: each step names its base (retained is of tried, not of repeat)', array_column($f['steps'], 'base'), [null, 'eligible', 'exposed', 'tried', 'tried']);
check('funnel: median hours from first seen to first use', $f['toUse'], ['medianHours' => 3.0, 'users' => 5, 'usedBeforeShown' => '<5', 'since' => null, 'saltReplaced' => null]);
check('funnel: setting_changed is not a use', dash_view($db, 'funnel', $T, 'jumpPlanner')['steps'][2]['users'], 7);

$l = dash_view($db, 'launches', $T);
check('launches: last 15', count($l['launches']), DASH_LAUNCHES);
$l114 = null;
$l112 = null;
foreach ($l['launches'] as $x) { if ($x['pr'] === 114) $l114 = $x; if ($x['pr'] === 112) $l112 = $x; }
check('launches: #114 is a jump planner follow-up', $l114['feature'], ['id' => 'jumpPlanner', 'title' => 'Jump planner', 'followUp' => true]);
$l113 = null;
foreach ($l['launches'] as $x) if ($x['pr'] === 113) $l113 = $x;
check('launches: #114 by day 1 / 7 / 14 / 28', [$l114['days']['1'], $l114['days']['7'], $l114['days']['14'], $l114['days']['28']],
    [['users' => 5, 'active' => 10, 'pct' => 50], ['users' => 5, 'active' => 10, 'pct' => 50], ['users' => 8, 'active' => 12, 'pct' => 67], null]);
check('launches: #114 not flagged', $l114['flag'], false);
check('launches: #113 (d-scan, nobody used it) flagged at day 14', [$l113['days']['14']['users'], $l113['flag']], [0, true]);
check('launches: first data day', $l['firstData'], '2026-10-17');
check('launches: #112 released before the first data day: no data, never flagged', [$l112['days']['1'], $l112['days']['14'], $l112['flag']], [['noData' => true], ['noData' => true], false]);

$o = dash_view($db, 'off', $T);
$jr = by_id($o['features'], 'jumpReturn');
check('off: split after / without using', [$jr['turnedOff'], $jr['afterUsing'], $jr['withoutTrying']], [10, 5, 5]);
$kr = by_id($o['features'], 'killReporting');
check('off: split hidden when one part is under 5', [$kr['turnedOff'], $kr['afterUsing'], $kr['withoutTrying'], $kr['turnedOn']], [6, null, null, '<5']);
check('off: off now', [by_id($o['features'], 'sizeTags')['offNow'], by_id($o['features'], 'sizeTags')['pct']], [6, 50]);
check('off: only features with a toggle', by_id($o['features'], 'apiTokens'), null);

$n = dash_view($db, 'never', '2026-12-20');
check('never: region map (3 users, released 2026-10-12) is a candidate after 60 days', by_id($n['candidates'], 'regionMap') !== null && by_id($n['candidates'], 'regionMap')['reason'] === 'few', true);
check('never: jump planner (7 users, repeat users) is not', [by_id($n['candidates'], 'jumpPlanner'), by_id($n['tooNew'], 'jumpPlanner')], [null, null]);
check('never: no release date = not judged', by_id($n['tooNew'], 'maskAdmins')['age'], null);
check('never: a passive feature nobody saw is judged by exposure', [by_id($n['candidates'], 'sizeTags')['reason'] ?? null, by_id($n['candidates'], 'sizeTags')['repeat']], ['fewseen', null]);
check('never: a passive feature 6 users saw is not listed', [by_id($n['candidates'], 'highsecRegion'), by_id($n['tooNew'], 'highsecRegion')], [null, null]);
check('never: before 60 days nothing is a candidate', dash_view($db, 'never', $T)['candidates'], []);

$h = dash_view($db, 'health', $T);
check('health: active users', [$h['wau'], $h['mau'], $h['stickiness'], end($h['dau'])['users']], [12, 12, 100, 12]);
check('health: daily median of the 7 days before today', $h['dauMedian7'], 0);
check('health: new users (first active in the window)', [$h['new7'], $h['new28']], ['<5', '<5']);
check('health: masks', [$h['masks7'], $h['masks28']], [4, 4]);
check('health: heatmap (Friday 20:00 UTC, Saturday 10:00)', [$h['heat'][4][20], $h['heat'][5][10], $h['heat'][0][0]], [12, 10, 0]);
check('health: weeks', array_slice($h['weeks'], -2), [10, 12]);

$t = dash_view($db, 'tips', $T);
check('tips: hint outcomes, events left out for suppressed users, settings not outcomes', $t['hints'], [['action' => 'got_it', 'users' => '<5', 'events' => null], ['action' => 'tip_shown', 'users' => 6, 'events' => 6]]);
check('tips: per feature shown / acted / used within 7 days', $t['tips'], [['id' => 'jumpPlanner', 'title' => 'Jump planner', 'shown' => 6, 'acted' => 5, 'actedPct' => 83, 'used7' => 5, 'used7Pct' => 83]]);
check('tips: "Show feature tips" off', $t['tipsOff'], ['turnedOff' => '<5', 'offNow' => '<5', 'pct' => null, 'active' => 12]);
$r17 = null;
foreach ($t['whatsNew']['releases'] as $r) if ($r['date'] === '2026-10-17') $r17 = $r;
check('tips: What\'s New opened after the 2026-10-17 release', [$r17['active'], $r17['opened'], $r17['pct'], $r17['complete']], [10, 5, 50, true]);

// Salt replaced on 2026-10-25 (rows from before exist): every view says so; per-uid measures keep all data
set_salt_date('2026-10-25');
$v = dash_view($db, 'features', $T);
check('rotation: features note, repeat unchanged', [$v['rotation'], by_id($v['features'], 'jumpPlanner')['repeat']['users']],
    [['date' => '2026-10-25', 'until' => '2027-01-16'], 5]);
$f = dash_view($db, 'funnel', $T, 'jumpPlanner');
check('rotation: the funnel keeps its 28 days and all milestones (released before the replacement)',
    [$f['from'], $f['rotation']['date'], array_column($f['steps'], 'users'), $f['toUse']['users'], $f['toUse']['medianHours'], $f['toUse']['since'], $f['toUse']['saltReplaced']],
    ['2026-10-03', '2026-10-25', [11, 10, 7, 5, 5], 5, 3.0, null, '2026-10-25']);
check('rotation: never used still counts repeat users across it', by_id(dash_view($db, 'never', '2026-12-20')['candidates'], 'jumpPlanner'), null);
// A replacement outside the funnel's 28 days (but inside the kept data): no funnel banner
$daily->execute(['2026-09-01', 'app', 'active', $u(99), 1, 600]);
set_salt_date('2026-09-20');
$f = dash_view($db, 'funnel', $T, 'jumpPlanner');
check('rotation: outside the funnel window: no banner, the caveat stays', [$f['rotation'], $f['toUse']['saltReplaced'], dash_view($db, 'features', $T)['rotation']['date']], [null, '2026-09-20', '2026-09-20']);
$db->prepare('DELETE FROM fork_analytics_daily WHERE uid = ?')->execute([$u(99)]);
set_salt_date('2026-10-25');
$h = dash_view($db, 'health', $T);
check('rotation: no new-user counts across it', [$h['new7'], $h['new28'], $h['rotation']['date']], [null, null, '2026-10-25']);
foreach (['launches', 'off', 'never', 'tips'] as $m) check("rotation: $m says so", dash_view($db, $m, $T)['rotation']['date'] ?? null, '2026-10-25');
set_salt_date('2026-10-17');
check('rotation: not when no rows are older than the salt', dash_view($db, 'features', $T)['rotation'], null);
set_salt_date('2026-01-01');

// Cache: answers are reused for the lifetime, old files are cleaned up
$dir = sys_get_temp_dir() . '/dashtest-cache-' . getmypid();
@mkdir($dir);
$calls = 0;
$fn = function () use (&$calls) { $calls++; return ['n' => $calls]; };
dash_cached('features', $fn, $dir);
check('cache: second read from the file', [dash_cached('features', $fn, $dir), $calls], [['n' => 1], 1]);
touch($dir . '/fork-analytics-stale.json', time() - 2 * 86400);
mt_srand(1);
for ($i = 0; $i < 60; $i++) dash_cached('k' . $i, $fn, $dir);
check('cache: files older than a day are deleted now and then', file_exists($dir . '/fork-analytics-stale.json'), false);
array_map('unlink', glob($dir . '/*') ?: []);
@rmdir($dir);

// ---- 4. HTTP ----
function sess($name, array $data) {
    $sid = 'dashtest' . $name;
    $payload = '';
    foreach ($data as $k => $v) $payload .= $k . '|' . serialize($v);
    $path = '/var/lib/php/session/sess_' . $sid;
    file_put_contents($path, $payload);
    @chown($path, 'www-data');
    @chmod($path, 0600);
    return $sid;
}
function http($method, $path, $sid) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => $sid ? ['Cookie: PHPSESSID=' . $sid] : []]);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$status, (string) $text];
}
// The web server reads ANALYTICS_ADMINS from its own environment (config.php)
$admins = array_values(array_filter(preg_split('/[\s,;]+/', (string) $adminEnv)));
if (!$admins) {
    fwrite(STDERR, "SKIP http checks: ANALYTICS_ADMINS is empty in this container\n");
} else {
    // Only rows of today for the live endpoint: 6 active users, 2 used the region map
    foreach (TABLES as $tbl) $db->exec("DELETE FROM $tbl");
    for ($i = 101; $i <= 106; $i++) $daily->execute([gmdate('Y-m-d'), 'app', 'active', $u($i), 1, 600]);
    for ($i = 101; $i <= 102; $i++) $daily->execute([gmdate('Y-m-d'), 'regionMap', 'opened', $u($i), 1, 600]);
    foreach (glob(__DIR__ . '/../cache/fork-analytics-*.json') ?: [] as $file) @unlink($file);
    $admin = sess('admin', ['userID' => 1, 'mask' => '0.0', 'characterID' => (int) $admins[0]]);
    $other = sess('other', ['userID' => 2, 'mask' => '0.0', 'characterID' => 991901]);
    $anon = sess('anon', ['mask' => '0.0']);
    check('http: no session cookie: 403', http('GET', 'fork_analytics.php?mode=access', null), [403, '']);
    check('http: not logged in: 403', http('GET', 'fork_analytics.php?mode=access', $anon)[0], 403);
    check('http: access for a non-admin: false, nothing else', http('GET', 'fork_analytics.php?mode=access', $other), [200, '{"admin":false}']);
    check('http: access for an admin', http('GET', 'fork_analytics.php?mode=access', $admin), [200, '{"admin":true}']);
    foreach (['features', 'funnel&feature=jumpPlanner', 'launches', 'off', 'never', 'health', 'tips', 'nope'] as $m) {
        check("http: $m for a non-admin: 403, empty", http('GET', "fork_analytics.php?mode=$m", $other), [403, '']);
    }
    list($st, $text) = http('GET', 'fork_analytics.php?mode=features', $admin);
    $j = json_decode($text, true);
    check('http: features for an admin', [$st, $j['active'] ?? null, by_id($j['features'] ?? [], 'regionMap')['used'] ?? null, $j['enabled'] ?? null], [200, 6, '<5', true]);
    check('http: no uids in the answer', strpos($text, 'dashtest'), false);
    foreach (['funnel&feature=jumpPlanner', 'launches', 'off', 'never', 'health', 'tips'] as $m) {
        list($st, $text) = http('GET', "fork_analytics.php?mode=$m", $admin);
        check("http: $m for an admin", [$st, is_array(json_decode($text, true)), strpos($text, 'dashtest')], [200, true, false]);
    }
    check('http: unknown view / feature: 400', [http('GET', 'fork_analytics.php?mode=nope', $admin)[0], http('GET', 'fork_analytics.php?mode=funnel&feature=nope', $admin)[0]], [400, 400]);
    check('http: other methods: 405', http('POST', 'fork_analytics.php?mode=features', $admin)[0], 405);
}

echo ($failures ? "FAILED $failures of $count checks\n" : "OK: $count checks\n");
exit($failures ? 1 : 0);
