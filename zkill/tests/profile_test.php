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

$now = gmdate_to_unix('2026-10-11 12:00:00');
function gmdate_to_unix($text) { return strtotime($text . ' UTC'); }
function kill($time, $victimCorp, $victimAlliance, $killerCorp, $killerAlliance, $npc = 0, $char = 1) {
    return ['killTime' => $time, 'npc' => $npc, 'victimCorporationID' => $victimCorp, 'victimAllianceID' => $victimAlliance,
        'finalBlowCharacterID' => $char, 'finalBlowCorporationID' => $killerCorp, 'finalBlowAllianceID' => $killerAlliance];
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

// --- period: histogram, groups on >= 3 distinct days, NPC corporations and NPC kills ---
$rows = [];
foreach (['2026-10-01 18:10:00', '2026-10-02 19:30:00', '2026-10-03 20:00:00', '2026-10-03 20:40:00'] as $t) $rows[] = kill($t, 500, 600, 700, 800);   // alliance 800: 4 kills, 3 days
foreach (['2026-10-04 03:00:00', '2026-10-04 04:00:00', '2026-10-04 05:00:00'] as $t) $rows[] = kill($t, 500, 600, 710, 0);   // corp 710: 3 kills, one day: not listed
foreach (['2026-10-05 21:00:00', '2026-10-06 21:00:00', '2026-10-07 21:00:00'] as $t) $rows[] = kill($t, 500, 600, 1000125, 0);   // NPC corporation: never a group
$rows[] = kill('2026-10-08 12:00:00', 500, 600, 800, 0, 1);       // NPC kill: not a kill, not in the histogram
$rows[] = kill('2026-10-09 22:00:00', 801, 800, 900, 0, 0, null); // final blow by an NPC pilot-less ship: a kill, no group
$p = zk_profile_period($rows, $now - 90 * 86400);
check('period: kills exclude NPC kills', $p['kills'], 11);
check('period: hours', [$p['hours'][18], $p['hours'][19], $p['hours'][20], $p['hours'][21], $p['hours'][22], $p['hours'][3]], [1, 1, 2, 3, 1, 1]);
check('period: only the alliance on 3 days is a group', array_map(function ($g) { return [$g['kind'], $g['id'], $g['kills'], $g['days']]; }, $p['groups']), [['alliance', 800, 4, 3]]);
check('period: its losses are counted (victim alliance 800)', $p['groups'][0]['losses'], 1);
check('period: last seen', $p['groups'][0]['lastSeen'], '2026-10-03T20:40:00Z');
// Days are UTC dates: two kills just before and after midnight are two days
$edge = [kill('2026-10-01 23:59:59', 1, 0, 70, 0), kill('2026-10-02 00:00:01', 1, 0, 70, 0), kill('2026-10-02 10:00:00', 1, 0, 70, 0)];
check('period: distinct UTC days', count(zk_profile_period($edge, 0)['groups']), 0);
$edge[] = kill('2026-10-03 10:00:00', 1, 0, 70, 0);
check('period: three UTC days', zk_profile_period($edge, 0)['groups'][0]['days'], 3);
// Period start
check('period: starts at from', zk_profile_period($rows, gmdate_to_unix('2026-10-05 00:00:00'))['kills'], 4);
// Top 5, ordered by kills, then days
$many = [];
for ($g = 1; $g <= 7; $g++) for ($d = 1; $d <= 2 + $g; $d++) $many[] = kill(sprintf('2026-09-%02d 10:00:00', $d), 9, 0, 3000 + $g, 0);
$top = zk_profile_period($many, 0)['groups'];
check('period: top five by kills', array_map(function ($g) { return $g['id']; }, $top), [3007, 3006, 3005, 3004, 3003]);
check('period: victim-only groups are not listed', array_map(function ($g) { return $g['id']; }, zk_profile_period([kill('2026-09-01 10:00:00', 55, 0, 3001, 0)], 0)['groups']), []);

// --- compute ---
$rows = [];
for ($i = 0; $i < 20; $i++) $rows[] = kill(gmdate('Y-m-d', $now - ($i * 4 + 1) * 86400) . ' 19:00:00', 5, 6, 7000 + ($i % 2), 0);
$rows[] = kill(gmdate('Y-m-d', $now - 100 * 86400) . ' 19:00:00', 5, 6, 7000, 0);   // older than 90 days
$profile = zk_profile_compute($rows, $now, $now - 10 * 86400);
check('compute: 90-day kills and level', [$profile['d90']['kills'], $profile['level']], [20, 'high']);
check('compute: 7-day kills (days 1 and 5 back are inside... 1 only)', $profile['d7']['kills'], 2);
check('compute: covered days', $profile['coveredDays'], 10.0);
check('compute: unknown coverage is 0 days', zk_profile_compute([], $now, null)['coveredDays'], 0.0);
check('compute: coverage capped at 90', zk_profile_compute([], $now, $now - 400 * 86400)['coveredDays'], 90.0);
check('compute: analysed at', $profile['analysedAt'], '2026-10-11T12:00:00Z');
check('compute: empty system', [zk_profile_compute([], $now, $now)['level'], zk_profile_compute([], $now, $now)['d90']['busiest']], ['none', null]);

// --- keep set, profile cache (SQLite) ---
$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE zkill_system_keep (systemID INTEGER PRIMARY KEY, keepSince TEXT NOT NULL, wantedAt TEXT NOT NULL, analysedAt TEXT NULL, profile TEXT NULL)');
$db->exec("CREATE TABLE zkill_killmails (id INTEGER PRIMARY KEY AUTOINCREMENT, killID INTEGER, systemID INTEGER, killTime TEXT, npc INTEGER DEFAULT 0,
    victimCorporationID INTEGER, victimAllianceID INTEGER, finalBlowCharacterID INTEGER, finalBlowCorporationID INTEGER, finalBlowAllianceID INTEGER)");
check('keep: nothing before anything is watched', zk_keep_wants($db, 31000005, $now - 5 * 86400, $now), false);
check('keep: touch adds', zk_keep_touch($db, [31000005, 31000006], $now), 2);
check('keep: touch again adds nothing', zk_keep_touch($db, [31000005], $now + 10), 0);
check('keep: touch refreshes wantedAt after an hour', [zk_keep_touch($db, [31000005], $now + 7200), $db->query('SELECT wantedAt FROM zkill_system_keep WHERE systemID = 31000005')->fetchColumn()],
    [0, gmdate('Y-m-d H:i:s', $now + 7200)]);
// The set is cached for a minute, so a new reader sees the rows after it expires
check('keep: cached set is reloaded after a minute', zk_keep_wants($db, 31000005, $now - 5 * 86400, $now + 120), true);
check('keep: another system is not kept', zk_keep_wants($db, 30000142, $now - 5 * 86400, $now + 121), false);
check('keep: beyond the keep days is not kept', zk_keep_wants($db, 31000005, $now - 91 * 86400, $now + 122), false);
check('keep: the prune spares them', strpos(zk_keep_prune_exception($db), 'systemID IN (SELECT systemID FROM zkill_system_keep)') !== false, true);
// Cap on watched systems
$db2 = new PDO('sqlite::memory:');
$db2->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db2->exec('CREATE TABLE zkill_system_keep (systemID INTEGER PRIMARY KEY, keepSince TEXT NOT NULL, wantedAt TEXT NOT NULL, analysedAt TEXT NULL, profile TEXT NULL)');
check('keep: capped', [zk_keep_touch($db2, range(1, ZK_KEEP_MAX_SYSTEMS + 5), $now), (int) $db2->query('SELECT COUNT(*) FROM zkill_system_keep')->fetchColumn()], [ZK_KEEP_MAX_SYSTEMS, ZK_KEEP_MAX_SYSTEMS]);

// zk_profile_get: computes from the stored kills, caches in the keep row, reuses it for an hour
$insert = $db->prepare('INSERT INTO zkill_killmails (killID, systemID, killTime, npc, victimCorporationID, victimAllianceID, finalBlowCharacterID, finalBlowCorporationID, finalBlowAllianceID)
    VALUES (?, 31000005, ?, 0, 5, 6, 1, 7000, 0)');
foreach ([1, 3, 6, 10] as $i => $daysBack) $insert->execute([100 + $i, gmdate('Y-m-d', $now - $daysBack * 86400) . ' 19:00:00']);
$db->exec("UPDATE zkill_system_keep SET keepSince = '" . gmdate('Y-m-d H:i:s', $now - 20 * 86400) . "' WHERE systemID = 31000005");
$p1 = zk_profile_get($db, 31000005, $now, $now - 2 * 86400);
check('get: computed from stored kills', [$p1['d90']['kills'], $p1['d7']['kills'], $p1['d90']['groups'][0]['id']], [4, 3, 7000]);
check('get: covered since the watch began', $p1['coveredDays'], 20.0);
$db->exec('DELETE FROM zkill_killmails');
$p2 = zk_profile_get($db, 31000005, $now + 600, $now - 2 * 86400);
check('get: reused within the hour', [$p2['analysedAt'], $p2['d90']['kills']], [$p1['analysedAt'], 4]);
$p3 = zk_profile_get($db, 31000005, $now + 3700, $now - 2 * 86400);
check('get: recomputed after the hour', [$p3['analysedAt'], $p3['d90']['kills']], ['2026-10-11T13:01:40Z', 0]);
// Not watched (feed off): only the retention window is known, nothing is cached
check('get: unwatched system uses the retention coverage', zk_profile_get($db, 31999999, $now, $now - 2 * 86400)['coveredDays'], 2.0);
check('get: unwatched system is not cached', (int) $db->query('SELECT COUNT(*) FROM zkill_system_keep WHERE systemID = 31999999')->fetchColumn(), 0);

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
