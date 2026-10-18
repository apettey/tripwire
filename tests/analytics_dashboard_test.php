<?php
// Fork-owned: tests for the analytics dashboard (analytics/dashboard.inc.php, public/fork_analytics.php) against the dev
// stack's database and nginx/PHP. The analytics tables are moved aside (renamed *_dashtest) for the run and put back at the
// end, so the numbers checked are exactly the rows seeded here.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/analytics_dashboard_test.php
// 1. Access list, suppression, Wilson interval.
// 2. Fresh install (no tables): every view answers with empty numbers and creates nothing.
// 3. Each view's numbers on seeded rows (fixed day 2026-10-30), suppression and hidden splits.
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
register_shutdown_function(function () use ($db, $adminEnv) {
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
check('eligible: exact, or a range when the number turned off is suppressed', [dash_eligible(40, 0), dash_eligible(40, 6), dash_eligible(40, 2)], [40, 34, '36-39']);
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
check('no tables: funnel', dash_view($db, 'funnel', $T, 'jumpPlanner')['steps'][2], ['key' => 'tried', 'users' => 0]);
check('no tables: none created', array_map('exists', TABLES), [false, false, false]);
check('unknown view / feature', [dash_view($db, 'nope', $T), dash_view($db, 'funnel', $T, 'nope'), dash_view($db, 'funnel', $T, "x' OR 1")], [null, null, null]);

// ---- 3. seeded numbers ----
analytics_ensure_schema($db);
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
$add(-20, 'jumpPlanner', 'setting_changed', 12);                               // not a use
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
for ($i = 1; $i <= 6; $i++) $add(0, 'hints', 'shown', $i);
for ($i = 1; $i <= 2; $i++) $add(0, 'hints', 'got_it', $i);
// What's New opened in the week after 2026-10-17 by u1-5
for ($i = 1; $i <= 5; $i++) $add(-13, 'whatsNew', 'opened', $i);

$v = dash_view($db, 'features', $T);
$jp = by_id($v['features'], 'jumpPlanner');
check('features: active users', $v['active'], 12);
check('features: jump planner counts', [$jp['eligible'], $jp['exposed'], $jp['used']], ['8-11', 10, 7]);
check('features: adoption with Wilson interval', $jp['adoption'], ['pct' => 64, 'lo' => 35, 'hi' => 85]);
check('features: repeat', $jp['repeat'], ['users' => 5, 'pct' => 71]);
check('features: opt-out suppressed', $jp['optOut'], ['users' => '<5', 'pct' => null]);
check('features: masks', $jp['masks'], 4);
check('features: sparkline (weeks before the release are null)', $jp['spark'], array_merge(array_fill(0, 9, null), [0, 5, 7]));
check('features: no flags on a used feature', $jp['flags'], []);
$st = by_id($v['features'], 'sizeTags');
check('features: size tags off for 6 (old snapshot ignored)', [$st['eligible'], $st['optOut']], [6, ['users' => 6, 'pct' => 50]]);
$rm = by_id($v['features'], 'regionMap');
check('features: small use suppressed, no adoption, masks <3', [$rm['used'], $rm['adoption'], $rm['repeat'], $rm['masks']], ['<5', null, ['users' => 0, 'pct' => null], '<3']);
$at = by_id($v['features'], 'apiTokens');
check('features: zero use flagged, nothing at all since release flagged', $at['flags'], ['silent', 'unused']);
check('features: a passive feature with only snapshots is not silent', by_id($v['features'], 'sizeTags')['flags'], []);
check('features: no uid anywhere', strpos(json_encode($v), 'dashtest'), false);

$f = dash_view($db, 'funnel', $T, 'jumpPlanner');
check('funnel: steps', array_column($f['steps'], 'users'), ['8-11', 10, 7, 5, 5]);
check('funnel: median hours from first seen to first use', $f['toUse'], ['medianHours' => 3.0, 'users' => 5, 'usedBeforeShown' => '<5']);
check('funnel: setting_changed is not a use', dash_view($db, 'funnel', $T, 'jumpPlanner')['steps'][2]['users'], 7);

$l = dash_view($db, 'launches', $T);
check('launches: last 15', count($l['launches']), DASH_LAUNCHES);
$l114 = null;
$l112 = null;
foreach ($l['launches'] as $x) { if ($x['pr'] === 114) $l114 = $x; if ($x['pr'] === 112) $l112 = $x; }
check('launches: #114 is a jump planner follow-up', $l114['feature'], ['id' => 'jumpPlanner', 'title' => 'Jump planner', 'followUp' => true]);
check('launches: #114 by day 1 / 7 / 14 / 28', [$l114['days']['1'], $l114['days']['7'], $l114['days']['14'], $l114['days']['28']],
    [['users' => 5, 'active' => 10, 'pct' => 50], ['users' => 5, 'active' => 10, 'pct' => 50], ['users' => 7, 'active' => 12, 'pct' => 58], null]);
check('launches: #114 not flagged', $l114['flag'], false);
check('launches: #112 (kill reporting, nobody used it) flagged at day 14', [$l112['days']['14']['users'], $l112['flag']], [0, true]);

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
check('never: before 60 days nothing is a candidate', dash_view($db, 'never', $T)['candidates'], []);

$h = dash_view($db, 'health', $T);
check('health: active users', [$h['wau'], $h['mau'], $h['stickiness'], end($h['dau'])['users']], [12, 12, 100, 12]);
check('health: daily median of the 7 days before today', $h['dauMedian7'], 0);
check('health: new users (first active in the window)', [$h['new7'], $h['new28']], ['<5', '<5']);
check('health: masks', [$h['masks7'], $h['masks28']], [4, 4]);
check('health: heatmap (Friday 20:00 UTC, Saturday 10:00)', [$h['heat'][4][20], $h['heat'][5][10], $h['heat'][0][0]], [12, 10, 0]);
check('health: weeks', array_slice($h['weeks'], -2), [10, 12]);

$t = dash_view($db, 'tips', $T);
check('tips: hint actions, events left out for suppressed users', $t['hints'], [['action' => 'got_it', 'users' => '<5', 'events' => null], ['action' => 'shown', 'users' => 6, 'events' => 6]]);
$r17 = null;
foreach ($t['whatsNew']['releases'] as $r) if ($r['date'] === '2026-10-17') $r17 = $r;
check('tips: What\'s New opened after the 2026-10-17 release', [$r17['active'], $r17['opened'], $r17['pct'], $r17['complete']], [10, 5, 50, true]);

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
