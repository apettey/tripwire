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
check('decision: queued', zk_backfill_decision(['status' => 'queued', 'windowSeconds' => 3600, 'priority' => 10, 'attemptedAt' => null, 'completedAt' => null], 1000, 3600, $now), $wait);
check('decision: queued, wider window', zk_backfill_decision(['status' => 'queued', 'windowSeconds' => 3600, 'priority' => 10, 'attemptedAt' => null, 'completedAt' => null], 1000, 7200, $now), $queue);
check('decision: failed recently', zk_backfill_decision(['status' => 'failed', 'windowSeconds' => 3600, 'attemptedAt' => $now - 60, 'completedAt' => null], 1000, 3600, $now), $none);
check('decision: failed long ago', zk_backfill_decision(['status' => 'failed', 'windowSeconds' => 3600, 'attemptedAt' => $now - 3600, 'completedAt' => null], 1000, 3600, $now), $queue);
check('decision: done, shorter window', zk_backfill_decision(['status' => 'done', 'windowSeconds' => 3600, 'attemptedAt' => $now - 60, 'completedAt' => $now - 60], 1000, 7200, $now), $queue);
check('decision: done, truncated (busy system)', zk_backfill_decision(['status' => 'done', 'windowSeconds' => 7200, 'attemptedAt' => $now - 3600, 'completedAt' => $now - 3600], 1000, 7200, $now), $none);
check('decision: done before a stream restart, recent', zk_backfill_decision(['status' => 'done', 'windowSeconds' => 7200, 'attemptedAt' => $now - 60, 'completedAt' => $now - 60], $now - 10, 7200, $now), $none);
check('decision: queued at lower priority (chain request)', zk_backfill_decision(['status' => 'queued', 'windowSeconds' => 7200, 'priority' => 10, 'attemptedAt' => null, 'completedAt' => null], 1000, 3600, $now, 20), $queue);
check('decision: queued at same priority', zk_backfill_decision(['status' => 'queued', 'windowSeconds' => 7200, 'priority' => 20, 'attemptedAt' => null, 'completedAt' => null], 1000, 3600, $now, 10), $wait);
check('decision: done before a stream restart, old', zk_backfill_decision(['status' => 'done', 'windowSeconds' => 7200, 'attemptedAt' => $now - 3600, 'completedAt' => $now - 3600], $now - 10, 7200, $now), $queue);

// --- zk_backfill_covered_from ---
$started = 100000;
check('covered: short answer covers the whole window', zk_backfill_covered_from($started, 3600, 10, [0 => $started - 60, 9 => $started - 3000], null), $started - 3600);
check('covered: full page starts at its oldest kill', zk_backfill_covered_from($started, 86400, 200, [0 => $started - 60, 199 => $started - 7000], null), $started - 7000);
check('covered: ESI cap / budget skipped entries: up to the first gap only',
    zk_backfill_covered_from($started, 86400, 50, [0 => $started - 60, 1 => $started - 120, 2 => $started - 600, 4 => $started - 9000], 3), $started - 600);
check('covered: gap at the start covers nothing', zk_backfill_covered_from($started, 86400, 50, [1 => $started - 120], 0), $started);
check('covered: nothing returned', zk_backfill_covered_from($started, 3600, 0, [], null), $started - 3600);
check('covered: ESI cap reaches the page size', ZK_BACKFILL_ESI_MAX >= 200, true);

// --- rate limiter ---
check('limiter: fresh host is ready', zk_http_ready('example.test'), true);
zk_http_record('zkillboard.com', 200, []);
check('limiter: a success alone does not pause', zk_http_ready('zkillboard.com'), true);
zk_http_record('esi.evetech.net', 429, ['retry-after' => '120']);
check('limiter: Retry-After', zk_http_wait('esi.evetech.net') > 100, true);
zk_http_record('r2z2.zkillboard.com', 200, ['x-esi-error-limit-remain' => '5', 'x-esi-error-limit-reset' => '30']);
check('limiter: ESI error limit', zk_http_wait('r2z2.zkillboard.com') > 25, true);
zk_http_record('other.test', 503, []);
check('limiter: backoff on 5xx', zk_http_wait('other.test') >= 9, true);
$logged = [];
zk_log_sink(function ($m) use (&$logged) { $logged[] = $m; });
zk_http_record('blocked.test', 403, []);
check('limiter: 403 blocks for at least the floor', zk_http_wait('blocked.test') >= ZK_HTTP_BLOCK_FLOOR - 1, true);
check('limiter: 403 is logged', count($logged) === 1 && strpos($logged[0], 'BLOCKED by blocked.test') === 0, true);
zk_http_record('blocked2.test', 403, ['retry-after' => '3600']);
check('limiter: 403 honours a longer Retry-After', zk_http_wait('blocked2.test') > 3500, true);
zk_http_record('esi-rl.test', 200, ['x-ratelimit-remaining' => '3', 'x-ratelimit-limit' => '3600/15m']);
check('limiter: ESI rate-limit group nearly used up', zk_http_wait('esi-rl.test') > 50, true);
zk_http_record('esi-ok.test', 200, ['x-ratelimit-remaining' => '3000', 'x-ratelimit-limit' => '3600/15m']);
check('limiter: ESI rate-limit group fine', zk_http_wait('esi-ok.test'), 0.0);
zk_http_reserve('zkillboard.com');
check('limiter: a starting request reserves the spacing', zk_http_wait('zkillboard.com') > 0 && zk_http_wait('zkillboard.com') <= zk_api_interval(), true);

// --- read-only requests report queued / running back-fills as pending ---
check('in progress: queued / running', [zk_backfill_in_progress('queued'), zk_backfill_in_progress('running')], [true, true]);
check('in progress: done / failed / none', [zk_backfill_in_progress('done'), zk_backfill_in_progress('failed'), zk_backfill_in_progress(null)], [false, false, false]);

// --- misc ---
check('system id: J-space', zk_is_system_id(31000005), true);
check('system id: k-space', zk_is_system_id(30000142), true);
check('system id: first / last range', [zk_is_system_id(30000001), zk_is_system_id(30005334), zk_is_system_id(30005335)], [true, true, false]);
check('system id: not a system (station)', zk_is_system_id(60003760), false);
check('system id: inside the old range check but not a system', zk_is_system_id(32999999), false);
check('system id: strings are not accepted', zk_is_system_id('30000142'), false);
check('iso', zk_iso('2026-10-10 09:41:57'), '2026-10-10T09:41:57Z');

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
