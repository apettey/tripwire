<?php
// Fork-owned: tests for the pure parts of the zKillboard integration (no database, no network).
//   docker compose -f docker-compose.dev.yml exec -T app php zkill/tests/zkill_test.php
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

// --- zk_killmail_row ---
$esi = [
    'killmail_id' => 139046138, 'killmail_time' => '2026-10-10T09:41:57Z', 'solar_system_id' => 30000142,
    'victim' => ['character_id' => 2116087385, 'corporation_id' => 98754582, 'alliance_id' => 1900696668, 'ship_type_id' => 22444],
    'attackers' => [
        ['character_id' => 1, 'corporation_id' => 10, 'ship_type_id' => 100, 'final_blow' => false],
        ['character_id' => 2, 'corporation_id' => 20, 'alliance_id' => 200, 'ship_type_id' => 29988, 'final_blow' => true],
        ['corporation_id' => 1000125, 'ship_type_id' => 3885, 'final_blow' => false],
    ],
];
$zkb = ['hash' => 'abc123', 'totalValue' => 547378185.224, 'npc' => false, 'solo' => false, 'awox' => true];

// API shape: ESI fields at the top level, zkb next to them
$row = zk_killmail_row($esi + ['zkb' => $zkb]);
check('api: killID', $row['killID'], 139046138);
check('api: killTime', $row['killTime'], '2026-10-10 09:41:57');
check('api: system', $row['systemID'], 30000142);
check('api: hash', $row['hash'], 'abc123');
check('api: victim', [$row['victimCharacterID'], $row['victimCorporationID'], $row['victimAllianceID'], $row['victimShipTypeID']],
    [2116087385, 98754582, 1900696668, 22444]);
check('api: final blow', [$row['finalBlowCharacterID'], $row['finalBlowCorporationID'], $row['finalBlowAllianceID'], $row['finalBlowShipTypeID']],
    [2, 20, 200, 29988]);
check('api: pilots / attackers', [$row['attackerCount'], $row['attackerTotal']], [2, 3]);
check('api: value', $row['totalValue'], 547378185.22);
check('api: flags', [$row['npc'], $row['solo'], $row['awox']], [0, 0, 1]);

// R2Z2 shape: {killmail_id, hash, zkb, esi}
$r2z2 = zk_killmail_row(['killmail_id' => 139046138, 'hash' => 'feedhash', 'zkb' => $zkb, 'esi' => $esi]);
check('r2z2: same row apart from hash', array_diff_key($r2z2, ['hash' => 1]), array_diff_key($row, ['hash' => 1]));
check('r2z2: hash', $r2z2['hash'], 'feedhash');

// Structure loss, NPC final blow, no attackers array
$structure = $esi;
unset($structure['victim']['character_id'], $structure['attackers']);
$srow = zk_killmail_row($structure + ['zkb' => ['npc' => true]]);
check('structure: no pilot', $srow['victimCharacterID'], null);
check('structure: no final blow', $srow['finalBlowCorporationID'], null);
check('structure: npc', [$srow['npc'], $srow['attackerCount'], $srow['totalValue']], [1, 0, 0]);

// API entries without the killmail (id + hash only) and junk
check('id + hash only', zk_killmail_row(['killmail_id' => 1, 'zkb' => ['hash' => 'x']]), null);
check('bad time', zk_killmail_row(['killmail_time' => 'nope'] + $esi), null);
check('no victim', zk_killmail_row(array_diff_key($esi, ['victim' => 1])), null);

// --- zk_coverage_from ---
check('coverage: no stream', zk_coverage_from(null, null), null);
check('coverage: stream only', zk_coverage_from(1000, null), 1000);
check('coverage: back-fill joins the stream', zk_coverage_from(1000, ['status' => 'done', 'completedAt' => 1500, 'coveredFrom' => 400]), 400);
check('coverage: back-fill before a stream restart', zk_coverage_from(1000, ['status' => 'done', 'completedAt' => 900, 'coveredFrom' => 400]), 1000);
check('coverage: failed back-fill', zk_coverage_from(1000, ['status' => 'failed', 'completedAt' => 1500, 'coveredFrom' => 400]), 1000);

// --- zk_backfill_decision ---
$now = 100000;
$queue = ['queue' => true, 'pending' => true];
$wait = ['queue' => false, 'pending' => true];
$none = ['queue' => false, 'pending' => false];
check('decision: unknown system', zk_backfill_decision(null, 1000, 3600, $now), $queue);
check('decision: queued', zk_backfill_decision(['status' => 'queued', 'windowSeconds' => 3600, 'attemptedAt' => null, 'completedAt' => null], 1000, 3600, $now), $wait);
check('decision: queued, wider window', zk_backfill_decision(['status' => 'queued', 'windowSeconds' => 3600, 'attemptedAt' => null, 'completedAt' => null], 1000, 7200, $now), $queue);
check('decision: failed recently', zk_backfill_decision(['status' => 'failed', 'windowSeconds' => 3600, 'attemptedAt' => $now - 60, 'completedAt' => null], 1000, 3600, $now), $none);
check('decision: failed long ago', zk_backfill_decision(['status' => 'failed', 'windowSeconds' => 3600, 'attemptedAt' => $now - 3600, 'completedAt' => null], 1000, 3600, $now), $queue);
check('decision: done, shorter window', zk_backfill_decision(['status' => 'done', 'windowSeconds' => 3600, 'attemptedAt' => $now - 60, 'completedAt' => $now - 60], 1000, 7200, $now), $queue);
check('decision: done, truncated (busy system)', zk_backfill_decision(['status' => 'done', 'windowSeconds' => 7200, 'attemptedAt' => $now - 3600, 'completedAt' => $now - 3600], 1000, 7200, $now), $none);
check('decision: done before a stream restart, recent', zk_backfill_decision(['status' => 'done', 'windowSeconds' => 7200, 'attemptedAt' => $now - 60, 'completedAt' => $now - 60], $now - 10, 7200, $now), $none);
check('decision: done before a stream restart, old', zk_backfill_decision(['status' => 'done', 'windowSeconds' => 7200, 'attemptedAt' => $now - 3600, 'completedAt' => $now - 3600], $now - 10, 7200, $now), $queue);

// --- rate limiter ---
check('limiter: fresh host is ready', zk_http_ready('example.test'), true);
zk_http_record('zkillboard.com', 200, []);
check('limiter: API spacing', zk_http_wait('zkillboard.com') > 0 && zk_http_wait('zkillboard.com') <= zk_api_interval(), true);
zk_http_record('esi.evetech.net', 429, ['retry-after' => '120']);
check('limiter: Retry-After', zk_http_wait('esi.evetech.net') > 100, true);
zk_http_record('r2z2.zkillboard.com', 200, ['x-esi-error-limit-remain' => '5', 'x-esi-error-limit-reset' => '30']);
check('limiter: ESI error limit', zk_http_wait('r2z2.zkillboard.com') > 25, true);
zk_http_record('other.test', 503, []);
check('limiter: backoff on 5xx', zk_http_wait('other.test') >= 9, true);

// --- misc ---
check('system id: J-space', zk_is_system_id(31000005), true);
check('system id: k-space', zk_is_system_id(30000142), true);
check('system id: not a system', zk_is_system_id(60003760), false);
check('iso', zk_iso('2026-10-10 09:41:57'), '2026-10-10T09:41:57Z');

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
