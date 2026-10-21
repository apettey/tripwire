<?php
// Fork-owned: tests for the 90-day threat profile (zkill/profile.php); fixtures only, SQLite, no network.
//   docker compose -p <project> -f docker-compose.dev.yml exec -T app php zkill/tests/profile_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../zkill.inc.php');

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

function gmdate_to_unix($text) { return strtotime($text . ' UTC'); }
$now = gmdate_to_unix('2026-10-11 12:00:00');
function kill($time, $victimCorp, $victimAlliance, $killerCorp, $killerAlliance, $npc = 0, $char = 1) {
    return ['killTime' => $time, 'npc' => $npc, 'victimCorporationID' => $victimCorp, 'victimAllianceID' => $victimAlliance,
        'finalBlowCharacterID' => $char, 'finalBlowCorporationID' => $killerCorp, 'finalBlowAllianceID' => $killerAlliance];
}
function profile_db() {
    $db = new Pdo\Sqlite('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('CREATE TABLE zkill_system_keep (systemID INTEGER PRIMARY KEY, requestedBy INTEGER NOT NULL DEFAULT 0, keepSince TEXT NOT NULL, wantedAt TEXT NOT NULL)');
    $db->exec('CREATE TABLE zkill_profile_cache (systemID INTEGER PRIMARY KEY, analysedAt TEXT NOT NULL, profile TEXT NOT NULL)');
    $db->exec("CREATE TABLE zkill_killmails (id INTEGER PRIMARY KEY AUTOINCREMENT, killID INTEGER, systemID INTEGER, killTime TEXT, npc INTEGER DEFAULT 0,
        victimCorporationID INTEGER, victimAllianceID INTEGER, finalBlowCharacterID INTEGER, finalBlowCorporationID INTEGER, finalBlowAllianceID INTEGER)");
    $db->exec("CREATE TABLE signatures (id INTEGER PRIMARY KEY AUTOINCREMENT, maskID TEXT, systemID INTEGER, type TEXT, lifeLength INTEGER NOT NULL DEFAULT 0,
        lifeLeft TEXT NULL, modifiedTime TEXT NOT NULL DEFAULT '2026-01-01 00:00:00')");
    $db->createFunction('NOW', function () { return gmdate('Y-m-d H:i:s'); }, 0);
    return $db;
}
function add_kills(PDO $db, $systemID, array $rows) {
    static $killID = 1000;
    $insert = $db->prepare('INSERT INTO zkill_killmails (killID, systemID, killTime, npc, victimCorporationID, victimAllianceID, finalBlowCharacterID, finalBlowCorporationID, finalBlowAllianceID)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    foreach ($rows as $r) $insert->execute([++$killID, $systemID, $r['killTime'], $r['npc'], $r['victimCorporationID'], $r['victimAllianceID'],
        $r['finalBlowCharacterID'], $r['finalBlowCorporationID'], $r['finalBlowAllianceID']]);
}
/** One period computed through the SQL aggregates, from kill fixtures */
function period_of(array $rows, $from) {
    $db = profile_db();
    add_kills($db, 31000005, $rows);
    return zk_profile_period_db($db, 31000005, $from);
}

// --- levels (WormholeSystems: Critical >= 50, High >= 15) ---
check('level: none', zk_profile_level(0), 'none');
check('level: low', zk_profile_level(1), 'low');
check('level: moderate', zk_profile_level(5), 'moderate');
check('level: high', zk_profile_level(15), 'high');
check('level: just below high', zk_profile_level(14), 'moderate');
check('level: critical', zk_profile_level(50), 'critical');

// --- busiest window ---
$hours = array_fill(0, 24, 0);
check('busiest: too few kills', zk_profile_busiest($hours), null);
$hours[18] = 3; $hours[19] = 4; $hours[20] = 5; $hours[21] = 2; $hours[3] = 1;
check('busiest: 18:00-22:00', zk_profile_busiest($hours), ['start' => 18, 'end' => 22, 'kills' => 14, 'share' => 93]);
$hours = array_fill(0, 24, 0);
$hours[22] = 4; $hours[23] = 3; $hours[0] = 3; $hours[1] = 2;
check('busiest: wraps around midnight', zk_profile_busiest($hours), ['start' => 22, 'end' => 2, 'kills' => 12, 'share' => 100]);
$hours = array_fill(0, 24, 1);
check('busiest: tie goes to the earliest start', zk_profile_busiest($hours)['start'], 0);

// --- period from the SQL aggregates: histogram, groups on >= 3 distinct days, NPC corporations and NPC kills ---
$rows = [];
foreach (['2026-10-01 18:10:00', '2026-10-02 19:30:00', '2026-10-03 20:00:00', '2026-10-03 20:40:00'] as $t) $rows[] = kill($t, 500, 600, 700, 800);   // alliance 800: 4 kills, 3 days
foreach (['2026-10-04 03:00:00', '2026-10-04 04:00:00', '2026-10-04 05:00:00'] as $t) $rows[] = kill($t, 500, 600, 710, 0);   // corp 710: 3 kills, one day: not listed
foreach (['2026-10-05 21:00:00', '2026-10-06 21:00:00', '2026-10-07 21:00:00'] as $t) $rows[] = kill($t, 500, 600, 1000125, 0);   // NPC corporation: never a group
$rows[] = kill('2026-10-08 12:00:00', 500, 600, 800, 0, 1);       // NPC kill: not a kill, not in the histogram
$rows[] = kill('2026-10-09 22:00:00', 801, 800, 900, 0, 0, null); // no pilot on the final blow: a kill, no group
$p = period_of($rows, $now - 90 * 86400);
check('period: kills exclude NPC kills', $p['kills'], 11);
check('period: hours', [$p['hours'][18], $p['hours'][19], $p['hours'][20], $p['hours'][21], $p['hours'][22], $p['hours'][3]], [1, 1, 2, 3, 1, 1]);
check('period: only the alliance on 3 days is a group', array_map(function ($g) { return [$g['kind'], $g['id'], $g['kills'], $g['days']]; }, $p['groups']), [['alliance', 800, 4, 3]]);
check('period: its losses are counted (victim alliance 800), NPC kills included', $p['groups'][0]['losses'], 1);
check('period: last seen', $p['groups'][0]['lastSeen'], '2026-10-03T20:40:00Z');
// Days are UTC dates: two kills just before and after midnight are two days
$edge = [kill('2026-10-01 23:59:59', 1, 0, 70, 0), kill('2026-10-02 00:00:01', 1, 0, 70, 0), kill('2026-10-02 10:00:00', 1, 0, 70, 0)];
check('period: distinct UTC days', count(period_of($edge, 0)['groups']), 0);
$edge[] = kill('2026-10-03 10:00:00', 1, 0, 70, 0);
check('period: three UTC days', period_of($edge, 0)['groups'][0]['days'], 3);
check('period: starts at from', period_of($rows, gmdate_to_unix('2026-10-05 00:00:00'))['kills'], 4);
// Top 5, ordered by kills, then days
$many = [];
for ($g = 1; $g <= 7; $g++) for ($d = 1; $d <= 2 + $g; $d++) $many[] = kill(sprintf('2026-09-%02d 10:00:00', $d), 9, 0, 3000 + $g, 0);
check('period: top five by kills', array_map(function ($g) { return $g['id']; }, period_of($many, 0)['groups']), [3007, 3006, 3005, 3004, 3003]);
check('period: victim-only groups are not listed', array_map(function ($g) { return $g['id']; }, period_of([kill('2026-09-01 10:00:00', 55, 0, 3001, 0)], 0)['groups']), []);
// A group splits into several (corp, day) aggregate rows: kills add up, days are distinct
$split = [kill('2026-09-01 10:00:00', 1, 0, 61, 99), kill('2026-09-01 11:00:00', 1, 0, 62, 99), kill('2026-09-02 11:00:00', 1, 0, 61, 99), kill('2026-09-03 11:00:00', 1, 0, 62, 99)];
check('period: corporations of one alliance count together', array_map(function ($g) { return [$g['id'], $g['kills'], $g['days']]; }, period_of($split, 0)['groups']), [[99, 4, 3]]);
// The aggregation reads no more than the (group, day) rows, whatever the number of kills
$big = [];
for ($i = 0; $i < 3000; $i++) $big[] = kill(gmdate('Y-m-d', $now - ($i % 60) * 86400) . sprintf(' %02d:00:00', $i % 24), 5, 6, 7 + ($i % 3), 0);
$agg = zk_profile_aggregate(call_user_func(function ($rows) { $db = profile_db(); add_kills($db, 31000005, $rows); return $db; }, $big), 31000005, 0);
check('aggregate: far fewer rows than kills', [count($agg['killers']) <= 3 * 60, count($agg['hours']) <= 60 * 24, count($agg['victims'])], [true, true, 1]);

// --- compute ---
$db = profile_db();
$rows = [];
for ($i = 0; $i < 20; $i++) $rows[] = kill(gmdate('Y-m-d', $now - ($i * 4 + 1) * 86400) . ' 19:00:00', 5, 6, 7000 + ($i % 2), 0);
$rows[] = kill(gmdate('Y-m-d', $now - 100 * 86400) . ' 19:00:00', 5, 6, 7000, 0);   // older than 90 days
add_kills($db, 31000005, $rows);
$profile = zk_profile_compute($db, 31000005, $now, $now - 10 * 86400);
check('compute: 90-day kills and level', [$profile['d90']['kills'], $profile['level']], [20, 'high']);
check('compute: 7-day kills', $profile['d7']['kills'], 2);
check('compute: covered days', $profile['coveredDays'], 10.0);
check('compute: unknown coverage is 0 days', zk_profile_compute($db, 31000005, $now, null)['coveredDays'], 0.0);
check('compute: coverage capped at 90', zk_profile_compute($db, 31000005, $now, $now - 400 * 86400)['coveredDays'], 90.0);
check('compute: analysed at', $profile['analysedAt'], '2026-10-11T12:00:00Z');
$empty = zk_profile_compute($db, 31999999, $now, $now);
check('compute: empty system', [$empty['level'], $empty['d90']['busiest'], $empty['d90']['kills']], ['none', null, 0]);

// --- keep set: batched touch, caps, never throws ---
$db = profile_db();
check('keep: nothing before anything is watched', zk_keep_wants($db, 31000005, $now - 5 * 86400, $now), false);
check('keep: touch adds', zk_keep_touch($db, [31000005, 31000006], $now, 7), 2);
check('keep: touch again adds nothing', zk_keep_touch($db, [31000005], $now + 10, 7), 0);
check('keep: wantedAt is refreshed only after an hour', [zk_keep_touch($db, [31000005], $now + 1800, 7), $db->query('SELECT wantedAt FROM zkill_system_keep WHERE systemID = 31000005')->fetchColumn()],
    [0, gmdate('Y-m-d H:i:s', $now)]);
check('keep: refresh after an hour', [zk_keep_touch($db, [31000005, 31000006, 31000007], $now + 7200, 7), $db->query('SELECT wantedAt FROM zkill_system_keep WHERE systemID = 31000005')->fetchColumn(),
    $db->query('SELECT keepSince FROM zkill_system_keep WHERE systemID = 31000005')->fetchColumn()], [1, gmdate('Y-m-d H:i:s', $now + 7200), gmdate('Y-m-d H:i:s', $now)]);
check('keep: the user is recorded', $db->query('SELECT requestedBy FROM zkill_system_keep WHERE systemID = 31000007')->fetchColumn(), 7);
check('keep: cached set is reloaded after a minute', zk_keep_wants($db, 31000005, $now - 5 * 86400, $now + 120), true);
check('keep: another system is not kept', zk_keep_wants($db, 30000142, $now - 5 * 86400, $now + 121), false);
check('keep: beyond the keep days is not kept', zk_keep_wants($db, 31000005, $now - 91 * 86400, $now + 122), false);
check('keep: the prune spares them', strpos(zk_keep_prune_exception($db), 'systemID IN (SELECT systemID FROM zkill_system_keep)') !== false, true);
$db2 = profile_db();
check('keep: capped overall', [zk_keep_touch($db2, range(31000000, 31000000 + ZK_KEEP_MAX_SYSTEMS + 5), $now, 0), (int) $db2->query('SELECT COUNT(*) FROM zkill_system_keep')->fetchColumn()], [ZK_KEEP_MAX_SYSTEMS, ZK_KEEP_MAX_SYSTEMS]);
$db3 = profile_db();
check('keep: capped per user', [zk_keep_touch($db3, range(31000000, 31000000 + ZK_KEEP_MAX_PER_USER + 9), $now, 5), zk_keep_touch($db3, [31900000], $now, 5), zk_keep_touch($db3, [31900001], $now, 6)],
    [ZK_KEEP_MAX_PER_USER, 0, 1]);
$broken = new Pdo\Sqlite('sqlite::memory:');
$broken->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$previous = ini_set('error_log', '/dev/null');
check('keep: a database error never escapes', zk_keep_touch($broken, [31000005], $now, 1), 0);
ini_set('error_log', (string) $previous);

// --- watch set: decided on the server from the mask chain ---
$db = profile_db();
$future = gmdate('Y-m-d H:i:s', time() + 86400);
$past = gmdate('Y-m-d H:i:s', time() - 86400);
$db->exec("INSERT INTO signatures (maskID, systemID, type, lifeLength, lifeLeft, modifiedTime) VALUES
    ('1.0', 31000010, 'wormhole', 86400, '$future', '2026-10-01 00:00:00'), ('1.0', 31000011, 'wormhole', 86400, '$future', '2026-10-05 00:00:00'),
    ('1.0', 31000010, 'wormhole', 86400, '$future', '2026-10-02 00:00:00'), ('1.0', 31000012, 'combat', 0, NULL, '2026-10-09 00:00:00'),
    ('2.0', 31000013, 'wormhole', 0, NULL, '2026-10-09 00:00:00'), ('1.0', 0, 'wormhole', 0, NULL, '2026-10-09 00:00:00'), ('1.0', 5, 'wormhole', 0, NULL, '2026-10-09 00:00:00'),
    ('1.0', 31000014, 'wormhole', 86400, '$past', '2026-10-10 00:00:00'), ('1.0', 31000015, 'wormhole', 0, NULL, '2026-09-01 00:00:00')");
check('watch: viewed system plus the live mask chain, most recently modified first, once each', zk_watch_systems($db, 31000005, '1.0'), [31000005, 31000011, 31000010, 31000015]);
check('watch: another mask is not mixed in', zk_watch_systems($db, null, '2.0'), [31000013]);
check('watch: the viewed system is not repeated', zk_watch_systems($db, 31000010, '1.0'), [31000010, 31000011, 31000015]);
check('watch: no mask, only the viewed system', zk_watch_systems($db, 31000005, null), [31000005]);
check('watch: limit keeps the most recently modified', zk_watch_systems($db, 31000005, '1.0', 3), [31000005, 31000011, 31000010]);

// --- per-system storage cap ---
$db = profile_db();
$retention = zk_retention_seconds();
$oldStart = $now - $retention - 86400;   // kills older than the retention window
$sys = 31000005;
$db->exec("INSERT INTO zkill_system_keep (systemID, keepSince, wantedAt) VALUES ($sys, '2026-07-01 00:00:00', '" . gmdate('Y-m-d H:i:s', $now) . "')");
$insert = $db->prepare('INSERT INTO zkill_killmails (killID, systemID, killTime, npc) VALUES (?, ?, ?, 0)');
$db->beginTransaction();
for ($i = 0; $i < ZK_KEEP_MAX_PER_SYSTEM + 300; $i++) $insert->execute([$i + 1, $sys, gmdate('Y-m-d H:i:s', $oldStart - $i * 60)]);   // newest first
$insert->execute([900001, $sys, gmdate('Y-m-d H:i:s', $now - 3600)]);   // inside the retention window: not counted by the cap
$insert->execute([900002, 31000099, gmdate('Y-m-d H:i:s', $oldStart - 5)]);   // unwatched system: left to the normal prune
$db->commit();
$oldestBefore = zk_unix($db->query("SELECT MIN(killTime) FROM zkill_killmails WHERE systemID = $sys")->fetchColumn());
check('capped: flagged while over the cap, from the oldest kill', zk_profile_capped_from($db, $sys, $now), $oldestBefore);
check('cap: the oldest are dropped', zk_keep_housekeeping($db, $now, true), 300);
check('cap: exactly the cap is left beyond the retention', (int) $db->query("SELECT COUNT(*) FROM zkill_killmails WHERE systemID = $sys AND killTime < '" . gmdate('Y-m-d H:i:s', $now - $retention) . "'")->fetchColumn(), ZK_KEEP_MAX_PER_SYSTEM);
check('cap: the newest are kept', (int) $db->query("SELECT MIN(id) FROM zkill_killmails WHERE systemID = $sys AND killID <= " . ZK_KEEP_MAX_PER_SYSTEM)->fetchColumn(), 1);
check('cap: recent and unwatched kills untouched', (int) $db->query('SELECT COUNT(*) FROM zkill_killmails WHERE killID >= 900001')->fetchColumn(), 2);
check('cap: nothing more to drop', zk_keep_housekeeping($db, $now, true), 0);
check('capped: exactly the cap (after the housekeeping) is not capped', zk_profile_capped_from($db, $sys, $now), null);
check('capped: a system under the cap is not capped', zk_profile_capped_from($db, 31000099, $now), null);
// The profile reports where history really starts while the cap is exceeded
$insert->execute([900003, $sys, gmdate('Y-m-d H:i:s', $oldStart - 86400)]);
$oldest = zk_unix($db->query("SELECT MIN(killTime) FROM zkill_killmails WHERE systemID = $sys")->fetchColumn());
$p = zk_profile_get($db, $sys, $now, $now - 2 * 86400);
check('capped: the profile says so', $p['coveredDays'], round(($now - $oldest) / 86400, 1));
// The cap query is throttled in the worker (not forced): the first call runs it, the next within ten minutes does not
$insert->execute([900004, $sys, gmdate('Y-m-d H:i:s', $oldStart - 90000)]);
check('cap: the worker runs it once', zk_keep_housekeeping($db, $now), 2);
$insert->execute([900005, $sys, gmdate('Y-m-d H:i:s', $oldStart - 95000)]);
check('cap: and not again within ten minutes', zk_keep_housekeeping($db, $now + 300), 0);
check('cap: but after ten minutes', zk_keep_housekeeping($db, $now + ZK_KEEP_CAP_INTERVAL + 1), 1);

// --- profile cache: computed from the stored kills, reused, per-system TTL ---
$db = profile_db();
$sys = 31000005;
$db->exec("INSERT INTO zkill_system_keep (systemID, keepSince, wantedAt) VALUES ($sys, '" . gmdate('Y-m-d H:i:s', $now - 20 * 86400) . "', '" . gmdate('Y-m-d H:i:s', $now) . "')");
foreach ([1, 3, 6, 10] as $daysBack) add_kills($db, $sys, [kill(gmdate('Y-m-d', $now - $daysBack * 86400) . ' 19:00:00', 5, 6, 7000, 0)]);
$p1 = zk_profile_get($db, $sys, $now, $now - 2 * 86400);
check('get: computed from stored kills', [$p1['d90']['kills'], $p1['d7']['kills']], [4, 3]);
check('get: covered since the watch began', $p1['coveredDays'], 20.0);
$db->exec('DELETE FROM zkill_killmails');
$p2 = zk_profile_get($db, $sys, $now + 600, $now - 2 * 86400);
check('get: watched system reused within the hour', [$p2['analysedAt'], $p2['d90']['kills']], [$p1['analysedAt'], 4]);
$p3 = zk_profile_get($db, $sys, $now + 3700, $now - 2 * 86400);
check('get: recomputed after the hour', [$p3['analysedAt'], $p3['d90']['kills']], ['2026-10-11T13:01:40Z', 0]);
// Not watched (feed off, or nobody asked yet): only the retention window is known, cached for ten minutes
$other = 31999999;
add_kills($db, $other, [kill(gmdate('Y-m-d', $now - 86400) . ' 10:00:00', 5, 6, 7000, 0)]);
$u1 = zk_profile_get($db, $other, $now, $now - 2 * 86400);
check('get: unwatched system uses the retention coverage', [$u1['coveredDays'], $u1['d90']['kills']], [2.0, 1]);
check('get: unwatched profile is cached too', (int) $db->query("SELECT COUNT(*) FROM zkill_profile_cache WHERE systemID = $other")->fetchColumn(), 1);
check('get: not a watched system', (int) $db->query("SELECT COUNT(*) FROM zkill_system_keep WHERE systemID = $other")->fetchColumn(), 0);
$db->exec('DELETE FROM zkill_killmails');
check('get: unwatched reused within ten minutes', zk_profile_get($db, $other, $now + 500, null)['d90']['kills'], 1);
check('get: unwatched recomputed after ten minutes', zk_profile_get($db, $other, $now + ZK_PROFILE_TTL_UNWATCHED + 5, null)['d90']['kills'], 0);
// Housekeeping drops cached profiles older than a day
$db->exec("UPDATE zkill_profile_cache SET analysedAt = '" . gmdate('Y-m-d H:i:s', $now - 2 * 86400) . "' WHERE systemID = $sys");
zk_keep_housekeeping($db, $now);
check('housekeeping: old cached profiles are dropped', (int) $db->query('SELECT COUNT(*) FROM zkill_profile_cache WHERE systemID = ' . $sys)->fetchColumn(), 0);

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
