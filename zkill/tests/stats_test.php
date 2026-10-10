<?php
// Fork-owned: tests for the pure parts of System Threat (zkill/stats.php, zkill/threat.php); no database, no network.
//   docker compose -f docker-compose.dev.yml exec -T app php zkill/tests/stats_test.php
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

// --- zk_stats_compact: shape of https://zkillboard.com/api/stats/solarSystemID/<id>/kills/ (trimmed) ---
$answer = [
    'type' => 'solarSystemID', 'id' => 31000005, 'shipsDestroyed' => 124450, 'gangRatio' => 80, 'avgGangSize' => 3.4,
    'months' => [
        '202608' => ['year' => 2026, 'month' => 8, 'shipsDestroyed' => 695, 'pointsDestroyed' => 2723, 'iskDestroyed' => 86952638503],
        '202610' => ['year' => 2026, 'month' => 10, 'shipsDestroyed' => 303, 'pointsDestroyed' => 1039, 'iskDestroyed' => 65589699490],
        '202609' => ['year' => 2026, 'month' => 9, 'shipsDestroyed' => 572, 'pointsDestroyed' => 2317, 'iskDestroyed' => 48617592138],
        '202607' => ['year' => 2026, 'month' => 7, 'shipsDestroyed' => 805],
        '202606' => ['year' => 2026, 'month' => 6, 'shipsDestroyed' => 900],
        'junk' => 'x',
    ],
    'topLists' => [
        ['type' => 'character', 'title' => 'Top Characters', 'values' => [['kills' => 9, 'characterID' => 1, 'id' => 1]]],
        ['type' => 'corporation', 'title' => 'Top Corporations', 'values' => [
            ['kills' => 55, 'isk' => 9189829303.57, 'corporationID' => 1831131676, 'corporationName' => 'V0LTA', 'cticker' => 'V0LTA', 'id' => 1831131676, 'typeID' => null, 'name' => 'V0LTA'],
            ['kills' => 52, 'corporationID' => 849473841, 'corporationName' => 'Beach Boys', 'cticker' => 'BU FU', 'id' => 849473841],
            ['kills' => 1, 'corporationID' => 0],
        ]],
        ['type' => 'alliance', 'title' => 'Top Alliances', 'values' => [
            ['kills' => 55, 'isk' => 1.5, 'allianceID' => 99005839, 'allianceName' => 'WE FORM V0LTA', 'aticker' => 'GLHF', 'id' => 99005839],
        ]],
    ],
    'activepvp' => [
        'characters' => ['type' => 'Characters', 'count' => 291],
        'corporations' => ['type' => 'Corporations', 'count' => 158],
        'kills' => ['type' => 'Total Kills', 'count' => 236],
    ],
];
$stats = zk_stats_compact($answer);
check('compact: 7-day numbers', [$stats['kills7d'], $stats['pilots7d'], $stats['corporations7d'], $stats['alliances7d']], [236, 291, 158, 0]);
check('compact: newest months first, at most 4', array_map(function ($m) { return $m['year'] * 100 + $m['month']; }, $stats['months']), [202610, 202609, 202608, 202607]);
check('compact: month fields', $stats['months'][0], ['year' => 2026, 'month' => 10, 'kills' => 303, 'isk' => 65589699490.0]);
check('compact: corporations', $stats['corporations'], [
    ['id' => 1831131676, 'name' => 'V0LTA', 'ticker' => 'V0LTA', 'kills' => 55, 'isk' => 9189829303.57],
    ['id' => 849473841, 'name' => 'Beach Boys', 'ticker' => 'BU FU', 'kills' => 52, 'isk' => 0.0],
]);
check('compact: alliances', $stats['alliances'], [['id' => 99005839, 'name' => 'WE FORM V0LTA', 'ticker' => 'GLHF', 'kills' => 55, 'isk' => 1.5]]);
check('compact: ratios', [$stats['gangRatio'], $stats['avgGangSize'], $stats['allTimeKills']], [80, 3.4, 124450]);
// A quiet system: zKillboard leaves out activepvp entries and top lists
$quiet = zk_stats_compact(['type' => 'solarSystemID', 'id' => 31002479, 'shipsDestroyed' => 12, 'months' => [], 'topLists' => [], 'activepvp' => []]);
check('compact: quiet system', [$quiet['kills7d'], $quiet['months'], $quiet['corporations']], [0, [], []]);
check('compact: error answer', zk_stats_compact(['error' => 'Invalid type or id']), null);
check('compact: not stats', zk_stats_compact(['foo' => 1]), null);
check('compact: not an array', zk_stats_compact(null), null);

// --- zk_stats_decision ---
$now = 1791633600;
check('decision: new system is queued', zk_stats_decision(null, $now), ['queue' => true, 'pending' => true]);
check('decision: fresh entry stays', zk_stats_decision(['status' => 'done', 'fetchedAt' => $now - 3600, 'attemptedAt' => $now - 3600, 'priority' => 10], $now),
    ['queue' => false, 'pending' => false]);
check('decision: stale entry is refreshed', zk_stats_decision(['status' => 'done', 'fetchedAt' => $now - ZK_STATS_TTL - 1, 'attemptedAt' => $now - ZK_STATS_TTL - 1, 'priority' => 10], $now),
    ['queue' => true, 'pending' => true]);
check('decision: queued stays queued', zk_stats_decision(['status' => 'queued', 'fetchedAt' => null, 'attemptedAt' => null, 'priority' => 10], $now, 10),
    ['queue' => false, 'pending' => true]);
check('decision: the viewed system raises a queued chain entry', zk_stats_decision(['status' => 'queued', 'fetchedAt' => null, 'attemptedAt' => null, 'priority' => 10], $now, 20),
    ['queue' => true, 'pending' => true]);
check('decision: running is pending', zk_stats_decision(['status' => 'running', 'fetchedAt' => null, 'attemptedAt' => $now, 'priority' => 10], $now, 20),
    ['queue' => false, 'pending' => true]);
check('decision: failed waits out the retry period', zk_stats_decision(['status' => 'failed', 'fetchedAt' => null, 'attemptedAt' => $now - 60, 'priority' => 10], $now),
    ['queue' => false, 'pending' => false]);
check('decision: failed is retried later', zk_stats_decision(['status' => 'failed', 'fetchedAt' => null, 'attemptedAt' => $now - ZK_STATS_RETRY - 1, 'priority' => 10], $now),
    ['queue' => true, 'pending' => true]);

// --- zk_stats_admit ---
check('admit: room', zk_stats_admit(10, 5, 1), true);
check('admit: global cap', zk_stats_admit(ZK_STATS_MAX_QUEUED, 0, 1), false);
check('admit: per-user cap', zk_stats_admit(10, ZK_STATS_MAX_PER_USER, 1), false);
check('admit: no user, no per-user cap', zk_stats_admit(10, 9999, 0), true);

// --- zk_threat_entities ---
$entities = zk_threat_entities(
    [[10, 100, 2, 500.0, 1000], [20, null, 1, 50.0, 2000], [null, null, 1, 1.0, 3000]],   // losses: corp, alliance, count, isk, last
    [[10, 100, 3, 1500], [30, 300, 1, 2500]]                                             // final blows: corp, alliance, count, last
);
check('entities: corporations by activity', array_map(function ($e) { return $e['id']; }, $entities['corporations']), [10, 30, 20]);   // 30 and 20 tie, 30 was seen later
check('entities: kills and losses merged', $entities['corporations'][0], ['id' => 10, 'kills' => 3, 'losses' => 2, 'iskLost' => 500.0, 'lastSeen' => 1500]);
check('entities: alliances', array_map(function ($e) { return [$e['id'], $e['kills'], $e['losses']]; }, $entities['alliances']), [[100, 3, 2], [300, 1, 0]]);
check('entities: ties go to the most recent', array_map(function ($e) { return $e['id']; }, zk_threat_entities([[1, null, 1, 0, 100], [2, null, 1, 0, 200]], [])['corporations']), [2, 1]);
check('entities: limit', count(zk_threat_entities(array_map(function ($i) { return [$i, null, 1, 0, $i]; }, range(1, 30)), [], 5)['corporations']), 5);

// --- zk_stats_run_one: the worker path (fake zKillboard via zk_http_transport, SQLite) ---
function stats_db() {
    $db = new PDO('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->sqliteCreateFunction('UTC_TIMESTAMP', function () { return gmdate('Y-m-d H:i:s'); }, 0);
    $db->exec("CREATE TABLE zkill_system_stats (systemID INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 10, requestedBy INTEGER NOT NULL DEFAULT 0, requestedAt TEXT NOT NULL, wantedAt TEXT NOT NULL,
        attemptedAt TEXT NULL, fetchedAt TEXT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', data TEXT NULL)");
    $db->exec("CREATE TABLE zkill_backfill (systemID INTEGER PRIMARY KEY, status TEXT NOT NULL)");
    return $db;
}
function stats_row(PDO $db, $systemID, array $fields = []) {
    $row = array_merge(['systemID' => $systemID, 'status' => 'queued', 'priority' => 10, 'requestedAt' => gmdate('Y-m-d H:i:s', time() - 60),
        'wantedAt' => gmdate('Y-m-d H:i:s'), 'attemptedAt' => null, 'fetchedAt' => null, 'data' => null], $fields);
    $db->prepare('INSERT INTO zkill_system_stats (' . implode(', ', array_keys($row)) . ') VALUES (' . implode(', ', array_fill(0, count($row), '?')) . ')')
        ->execute(array_values($row));
}
function stats_get(PDO $db, $systemID) {
    return $db->query("SELECT * FROM zkill_system_stats WHERE systemID = $systemID")->fetch(PDO::FETCH_ASSOC);
}
$calls = [];
$stored = json_decode(json_encode(zk_stats_compact($answer)), true);   // as it comes back from the data column
$reply = [200, json_encode($answer), []];
zk_http_transport(function ($method, $url, $body) use (&$calls, &$reply) {
    $calls[] = $url;
    return $reply;
});
$ready = function () { zk_http_pause('zkillboard.com', 0); $state = &zk_http_state(); unset($state['zkillboard.com']); };

// A queued back-fill goes first: no stats request
$db = stats_db();
stats_row($db, 31000005);
$db->exec("INSERT INTO zkill_backfill VALUES (31000005, 'queued')");
$ready();
check('run: nothing while a back-fill is queued', [zk_stats_run_one($db), count($calls), stats_get($db, 31000005)['status']], [null, 0, 'queued']);
// The rate limiter says no (spacing, backoff, 403 block): no request
$db->exec('DELETE FROM zkill_backfill');
zk_http_pause('zkillboard.com', microtime(true) + 60);
check('run: nothing while zKillboard is paused', [zk_stats_run_one($db), count($calls), stats_get($db, 31000005)['status']], [null, 0, 'queued']);
// Success: compacted data, done, fetchedAt set, the URL of the stats route
$ready();
$line = zk_stats_run_one($db);
$row = stats_get($db, 31000005);
check('run: one request to the stats route', $calls, ['https://zkillboard.com/api/stats/solarSystemID/31000005/kills/']);
check('run: done with compacted data', [$row['status'], json_decode($row["data"], true), $row["fetchedAt"] !== null, (int) $row['attempts']],
    ["done", $stored, true, 1]);
check('run: log line', $line, 'stats 31000005: 236 kills in 7 days, 2 top corporations');
$ready();
check('run: nothing left to do', [zk_stats_run_one($db), count($calls)], [null, 1]);
// Failure: failed, old data and fetchedAt kept
$db->exec("UPDATE zkill_system_stats SET status = 'queued', fetchedAt = '2026-01-01 00:00:00' WHERE systemID = 31000005");
$reply = [503, 'busy', []];
$ready();
$line = zk_stats_run_one($db);
$row = stats_get($db, 31000005);
check('run: HTTP error marks failed', [$row['status'], $row['error'], $line], ['failed', 'zKillboard: HTTP 503', 'stats 31000005: zKillboard: HTTP 503']);
check('run: HTTP error keeps old data and fetchedAt', [json_decode($row['data'], true), $row['fetchedAt']], [$stored, "2026-01-01 00:00:00"]);
// zKillboard's error object is a failure too
$db->exec("UPDATE zkill_system_stats SET status = 'queued' WHERE systemID = 31000005");
$reply = [200, '{"error":"Invalid type or id"}', []];
$ready();
zk_stats_run_one($db);
check('run: error answer marks failed', stats_get($db, 31000005)['error'], 'zKillboard: Invalid type or id');
// Not sent after all (-1): straight back in the queue, nothing else changes
$db->exec("UPDATE zkill_system_stats SET status = 'queued', error = '' WHERE systemID = 31000005");
$reply = [-1, 'rate limited', []];
$ready();
check('run: not sent goes back to queued', [zk_stats_run_one($db), stats_get($db, 31000005)['status'], stats_get($db, 31000005)['fetchedAt']],
    [null, 'queued', '2026-01-01 00:00:00']);

// Order: highest priority first, then the oldest request
$db = stats_db();
stats_row($db, 1, ['priority' => 10, 'requestedAt' => '2026-10-10 10:00:00']);
stats_row($db, 2, ['priority' => 20, 'requestedAt' => '2026-10-10 11:00:00']);
stats_row($db, 3, ['priority' => 20, 'requestedAt' => '2026-10-10 10:30:00']);
stats_row($db, 4, ['status' => 'done', 'priority' => 30, 'requestedAt' => '2026-10-10 09:00:00']);
$calls = [];
$reply = [200, json_encode($answer), []];
for ($i = 0; $i < 4; $i++) { $ready(); zk_stats_run_one($db); }
check('run: priority, then oldest request; done rows are skipped', array_map(function ($url) { return (int) explode('/', $url)[6]; }, $calls), [3, 2, 1]);

// Housekeeping: abandoned running rows are queued again, rows nobody wants are pruned
$db = stats_db();
$now = time();
stats_row($db, 1, ['status' => 'running', 'attemptedAt' => gmdate('Y-m-d H:i:s', $now - 600)]);
stats_row($db, 2, ['status' => 'running', 'attemptedAt' => gmdate('Y-m-d H:i:s', $now - 30)]);
stats_row($db, 3, ['status' => 'done', 'wantedAt' => gmdate('Y-m-d H:i:s', $now - ZK_STATS_KEEP_DAYS * 86400 - 60)]);
stats_row($db, 4, ['status' => 'done', 'wantedAt' => gmdate('Y-m-d H:i:s', $now - 86400)]);
zk_stats_housekeeping($db, $now, true);
check('housekeeping: stale running re-queued, fresh running kept', [stats_get($db, 1)['status'], stats_get($db, 2)['status']], ['queued', 'running']);
check('housekeeping: unwanted rows pruned', [stats_get($db, 3), stats_get($db, 4)['status']], [false, 'done']);
zk_http_transport(null, true);

echo ($failures ?"$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
