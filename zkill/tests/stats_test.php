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

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
