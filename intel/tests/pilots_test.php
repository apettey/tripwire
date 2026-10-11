<?php
// Fork-owned: tests of intel/pilots.inc.php (local scans: corporations, alliances, threat). Pure parts, then the queue
// and the worker steps against the dev database with ESI and zKillboard replaced by a fake transport (zk_http_transport):
// no request leaves the container. Uses names "Zzt ...", IDs 2100000000+ and mask 999999991.2, and removes them after.
//   docker compose -f docker-compose.dev.yml exec -T app php intel/tests/pilots_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

// The worker steps only run with the feed on; this process never starts the feed and every request is faked
define('ZKILL_FEED_ENABLED', true);
define('INTEL_ZKILL_THREAT_ENABLED', ($argv[1] ?? '') !== '--threat-off');
require_once(__DIR__ . '/../intel.inc.php');
require_once(__DIR__ . '/../pilots.inc.php');

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

// Every outgoing request goes through this fake; anything unexpected fails the test
$calls = [];
$handler = function ($method, $url, $body) { return [599, 'unexpected request', []]; };
zk_http_transport(function ($method, $url, $body) use (&$calls, &$handler) {
    $calls[] = [$method, $url, $body];
    return $handler($method, $url, $body);
});
zk_log_sink(function ($message) { /* expected blocks are part of the test */ });
function limiter_reset() {
    $state = &zk_http_state();
    $state = [];
    zk_names_paused_until(0);
}

$mysql = null;
require(__DIR__ . '/../../db.inc.php');
$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
zk_ensure_schema($mysql);
intel_schema($mysql);
intel_pilots_schema($mysql);

const MASK = '999999991.2';
const SYSTEM = 31000005;
const TEST_STATS_SYSTEM = 30999999;   // not a real system: only this test queues it
const USER = 900771;
const CAP_USER = 900772;
const FRIENDLY_CORP = 2100009100;
const RAIDERS = 2100009001;           // player corporation in an alliance
const LONERS = 2100009002;            // player corporation without an alliance
const ALLIANCE = 2100009501;
const NPC_CORP = 1000167;             // State War Academy

function cleanup(PDO $db) {
    $db->exec("DELETE FROM fork_pilot_affiliation WHERE name LIKE 'Zzt %' OR requestedBy IN (" . USER . ', ' . CAP_USER . ')');
    $db->exec('DELETE FROM fork_pilot_entities WHERE id BETWEEN 2100000000 AND 2199999999');
    $db->exec('DELETE FROM fork_pilot_threat WHERE characterID BETWEEN 2100000000 AND 2199999999');
    $db->exec('DELETE FROM fork_intel_lookups WHERE scanID IN (SELECT id FROM fork_intel_scans WHERE maskID = ' . MASK . ')');
    $db->exec('DELETE FROM fork_intel_scans WHERE maskID = ' . MASK);
    $db->exec('DELETE FROM zkill_system_stats WHERE systemID = ' . TEST_STATS_SYSTEM);
    $db->exec('DELETE FROM zkill_backfill WHERE systemID = ' . TEST_STATS_SYSTEM);
}

// --- Server-wide switch (subprocess with INTEL_ZKILL_THREAT_ENABLED=false) ---
if (($argv[1] ?? '') === '--threat-off') {
    $mysql->prepare("INSERT INTO fork_pilot_threat (characterID, status, requestedAt) VALUES (2100000999, 'queued', UTC_TIMESTAMP())")->execute();
    limiter_reset();
    $line = intel_threat_run_one($mysql);
    $status = $mysql->query('SELECT status FROM fork_pilot_threat WHERE characterID = 2100000999')->fetchColumn();
    $mysql->exec('DELETE FROM fork_pilot_threat WHERE characterID = 2100000999');
    echo json_encode(['line' => $line, 'calls' => count($calls), 'status' => $status, 'enabled' => intel_threat_enabled()]);
    exit();
}

// ===== Pure parts =====

check('friendly: own corp and alliance', intel_friendly_ids(['corporationID' => 98000001, 'allianceID' => 99000001], '98000001.2'),
    ['corporations' => [98000001], 'alliances' => [99000001]]);
check('friendly: alliance mask owner', intel_friendly_ids(['corporationID' => 98000001, 'allianceID' => null], '99000002.3'),
    ['corporations' => [98000001], 'alliances' => [99000002]]);
check('friendly: corp mask of another corp', intel_friendly_ids(['corporationID' => 98000001], '98000003.2'),
    ['corporations' => [98000001, 98000003], 'alliances' => []]);
check('friendly: personal / custom masks add nothing', intel_friendly_ids([], '196379789.1'), ['corporations' => [], 'alliances' => []]);
check('friendly: junk mask', intel_friendly_ids([], 'x.2'), ['corporations' => [], 'alliances' => []]);

check('npc corp: low end', intel_is_npc_corp(1000000), true);
check('npc corp: high end', intel_is_npc_corp(1999999), true);
check('npc corp: player corp', intel_is_npc_corp(98000001), false);
check('npc corp: none', intel_is_npc_corp(null), false);

$now = 1791633600;
$row = function (array $fields) { return array_merge(['status' => 'done', 'characterID' => 5, 'corporationID' => 98000001, 'allianceID' => null, 'fetchedAt' => null, 'attemptedAt' => null], $fields); };
check('decision: new name', intel_affiliation_decision(null, $now), ['queue' => true, 'pending' => true]);
check('decision: queued, nothing known yet', intel_affiliation_decision($row(['status' => 'queued', 'characterID' => null, 'corporationID' => null]), $now), ['queue' => false, 'pending' => true]);
check('decision: queued for a refresh keeps showing the old data', intel_affiliation_decision($row(['status' => 'queued']), $now), ['queue' => false, 'pending' => false]);
check('decision: fresh affiliation', intel_affiliation_decision($row(['fetchedAt' => $now - 600]), $now), ['queue' => false, 'pending' => false]);
check('decision: affiliation older than an hour is refreshed', intel_affiliation_decision($row(['fetchedAt' => $now - INTEL_AFF_TTL - 1]), $now), ['queue' => true, 'pending' => false]);
check('decision: unknown name within the hour', intel_affiliation_decision($row(['characterID' => 0, 'corporationID' => null, 'fetchedAt' => $now - 600]), $now), ['queue' => false, 'pending' => false]);
check('decision: unknown name after the hour', intel_affiliation_decision($row(['characterID' => 0, 'corporationID' => null, 'fetchedAt' => $now - INTEL_AFF_UNKNOWN_TTL - 1]), $now), ['queue' => true, 'pending' => false]);
check('decision: failed waits out the retry period', intel_affiliation_decision($row(['status' => 'failed', 'characterID' => null, 'corporationID' => null, 'attemptedAt' => $now - 60]), $now), ['queue' => false, 'pending' => false]);
check('decision: failed is retried later', intel_affiliation_decision($row(['status' => 'failed', 'characterID' => null, 'corporationID' => null, 'attemptedAt' => $now - INTEL_AFF_RETRY - 1]), $now), ['queue' => true, 'pending' => true]);

check('room: all fit', intel_affiliation_room(0, 0, 1, 2000), 2000);
check('room: global cap', intel_affiliation_room(INTEL_AFF_MAX_QUEUED - 10, 0, 1, 2000), 10);
check('room: per-user cap', intel_affiliation_room(0, INTEL_AFF_MAX_PER_USER - 5, 1, 2000), 5);
check('room: full', intel_affiliation_room(INTEL_AFF_MAX_QUEUED, 0, 1, 3), 0);
check('room: no user, no per-user cap', intel_affiliation_room(0, INTEL_AFF_MAX_PER_USER, 0, 3), 3);
check('threat room: global cap', intel_threat_room(INTEL_THREAT_MAX_QUEUED - 2, 0, 1, 20), 2);
check('threat room: per-user cap', intel_threat_room(0, INTEL_THREAT_MAX_PER_USER, 1, 20), 0);

check('tiers: new in one batch, rejected ones smaller, then single', intel_tier_batches([['a', 0], ['b', 0], ['c', 1], ['d', 2]], 500),
    [['a', 'b'], ['d'], ['c']]);
check('tiers: big batch capped', count(intel_tier_batches(array_map(function ($i) { return [$i, 0]; }, range(1, 1200)), 1000)[0]), 1000);

// Threat pick: friendly never, player corporations before NPC corporations, cached / queued skipped, capped
$pilots = [];
$pilots[] = [2100000001, NPC_CORP, null];                // NPC corp: after the players
$pilots[] = [2100000002, FRIENDLY_CORP, null];           // friendly corporation
$pilots[] = [2100000003, RAIDERS, 2100009999];           // friendly alliance
for ($i = 10; $i < 40; $i++) $pilots[] = [2100000000 + $i, LONERS, null];
$pilots[] = [2100000010, LONERS, null];                  // duplicate
$friendly = ['corporations' => [FRIENDLY_CORP], 'alliances' => [2100009999]];
$cache = [
    2100000010 => ['status' => 'done', 'fetchedAt' => $now - 3600, 'attemptedAt' => $now - 3600],                       // fresh
    2100000011 => ['status' => 'queued', 'fetchedAt' => null, 'attemptedAt' => null],                                   // already queued
    2100000012 => ['status' => 'done', 'fetchedAt' => $now - INTEL_THREAT_TTL - 1, 'attemptedAt' => $now - INTEL_THREAT_TTL - 1], // stale
    2100000013 => ['status' => 'failed', 'fetchedAt' => null, 'attemptedAt' => $now - 60],                              // failed just now
];
$pick = intel_threat_pick($pilots, $friendly, $cache, $now);
check('pick: at most 20 per scan', count($pick), INTEL_THREAT_PER_SCAN);
check('pick: skips fresh, queued and recently failed, refreshes stale', array_slice($pick, 0, 3), [2100000012, 2100000014, 2100000015]);
check('pick: never friendly', array_values(array_intersect($pick, [2100000002, 2100000003])), []);
check('pick: NPC corp pilots only when there is room', in_array(2100000001, $pick, true), false);
check('pick: NPC corp pilots fill up', intel_threat_pick([[2100000001, NPC_CORP, null], [2100000020, LONERS, null]], $friendly, [], $now), [2100000020, 2100000001]);
check('pick: unresolved pilots are skipped', intel_threat_pick([[0, null, null], [null, null, null]], $friendly, [], $now), []);

// zKillboard character stats -> compact summary
$answer = [
    'type' => 'characterID', 'id' => 2100000014, 'dangerRatio' => 87, 'gangRatio' => 22, 'shipsDestroyed' => 1234, 'shipsLost' => 56,
    'soloKills' => 310, 'iskDestroyed' => 1.5e11,
    'months' => [
        '202609' => ['year' => 2026, 'month' => 9, 'shipsDestroyed' => 40],
        '202610' => ['year' => 2026, 'month' => 10, 'shipsLost' => 2],           // losses only
        '202608' => ['year' => 2026, 'month' => 8, 'shipsDestroyed' => 12],
    ],
    'activepvp' => ['kills' => ['type' => 'Total Kills', 'count' => 17]],
    'topLists' => [
        ['type' => 'character', 'values' => [['kills' => 3, 'characterID' => 1]]],
        ['type' => 'shipType', 'values' => [
            ['kills' => 9, 'shipTypeID' => 29984, 'shipName' => 'Tengu', 'groupID' => 963],
            ['kills' => 4, 'id' => 22456, 'name' => 'Sabre'],
            ['kills' => 1, 'shipTypeID' => 0],
            ['kills' => 1, 'shipTypeID' => 11987, 'shipName' => 'Guardian'],
            ['kills' => 1, 'shipTypeID' => 12013, 'shipName' => 'Broadsword'],
        ]],
    ],
];
$compact = intel_threat_compact($answer);
check('compact: ratios and counts', [$compact['danger'], $compact['gang'], $compact['kills'], $compact['losses'], $compact['solo'], $compact['kills7d']],
    [87, 22, 1234, 56, 310, 17]);
check('compact: newest month with kills', $compact['lastMonth'], '2026-09');
check('compact: top ship types', $compact['ships'], [[29984, 'Tengu', 9], [22456, 'Sabre', 4], [11987, 'Guardian', 1]]);
check('compact: no record', intel_threat_compact([]), ['danger' => null, 'gang' => null, 'kills' => 0, 'losses' => 0, 'solo' => 0, 'kills7d' => 0, 'lastMonth' => null, 'ships' => []]);
check('compact: ratios are clamped', intel_threat_compact(['dangerRatio' => 250, 'gangRatio' => -3])['danger'] . '/' . intel_threat_compact(['dangerRatio' => 250, 'gangRatio' => -3])['gang'], '100/0');
check('compact: error answer', intel_threat_compact(['error' => 'Invalid type or id']), null);
check('compact: not an array', intel_threat_compact(null), null);

// ===== Database: queue, worker steps, caps, expiry =====

cleanup($mysql);
foreach (['zkill_backfill', 'zkill_system_stats', 'fork_pilot_threat', 'fork_pilot_affiliation', 'fork_pilot_entities'] as $table) {
    $queued = (int) $mysql->query("SELECT COUNT(*) FROM $table WHERE status = 'queued'")->fetchColumn();
    if ($queued) {
        fwrite(STDERR, "ABORT: $table has $queued queued rows in the dev database; the worker steps would pick them up\n");
        exit(1);
    }
}

// A shared local scan: 25 hostiles (one pasted in lower case), a friendly, a new player in an NPC corporation, a name
// ESI doesn't know and one ESI forgets in the affiliation answer
$names = [];
for ($i = 1; $i <= 25; $i++) $names[] = sprintf('Zzt Hostile %02d', $i);
$names[0] = 'zzt hostile 01';
$names[] = 'Zzt Friend';
$names[] = 'Zzt Newbie';
$names[] = 'Zzt Ghost';
$names[] = 'Zzt Lost';
$characters = [];   // canonical name => [id, corporation, alliance]
for ($i = 1; $i <= 25; $i++) $characters[sprintf('Zzt Hostile %02d', $i)] = [2100000100 + $i, $i <= 15 ? RAIDERS : LONERS, $i <= 15 ? ALLIANCE : null];
$characters['Zzt Friend'] = [2100000201, FRIENDLY_CORP, null];
$characters['Zzt Newbie'] = [2100000202, NPC_CORP, null];
$characters['Zzt Lost'] = [2100000203, null, null];   // left out of the affiliation answer
$byID = [];
foreach ($characters as $name => $c) $byID[$c[0]] = [$name, $c[1], $c[2]];
$entityNames = [RAIDERS => ['Zzt Raiders', 'ZZR'], LONERS => ['Zzt <Loners> & Co', 'Z&L'], FRIENDLY_CORP => ['Zzt Friends', 'ZZF'], ALLIANCE => ['Zzt Alliance', 'ZZA']];
$esiHandler = function ($method, $url, $body) use ($characters, $byID, $entityNames) {
    if (parse_url($url, PHP_URL_HOST) !== 'esi.evetech.net') return [599, 'not ESI', []];
    $path = parse_url($url, PHP_URL_PATH);
    if ($method === 'POST' && $path === '/universe/ids') {
        $out = [];
        foreach (json_decode($body, true) as $name) {
            foreach ($characters as $canonical => $c) {
                if (mb_strtolower($canonical) === mb_strtolower($name)) $out[] = ['id' => $c[0], 'name' => $canonical];
            }
        }
        return [200, json_encode($out ? ['characters' => $out] : new stdClass()), []];
    }
    if ($method === 'POST' && $path === '/characters/affiliation') {
        $out = [];
        foreach (json_decode($body, true) as $id) {
            if (!isset($byID[$id]) || $byID[$id][1] === null) continue;
            $entry = ['character_id' => $id, 'corporation_id' => $byID[$id][1]];
            if ($byID[$id][2]) $entry['alliance_id'] = $byID[$id][2];
            $out[] = $entry;
        }
        return [200, json_encode($out), []];
    }
    if ($method === 'GET' && preg_match('#^/(corporations|alliances)/(\d+)$#', $path, $m) && isset($entityNames[(int) $m[2]])) {
        return [200, json_encode(['name' => $entityNames[(int) $m[2]][0], 'ticker' => $entityNames[(int) $m[2]][1]]), []];
    }
    return [404, '{"error":"not found"}', []];
};

$scanID = intel_insert($mysql, MASK, SYSTEM, 'local', ['names' => $names, 'invalid' => 0], 'Test Pilot', USER);
$queuedNow = intel_pilots_on_share($mysql, $scanID, $names, USER, ['corporations' => [FRIENDLY_CORP], 'alliances' => []]);
check('share: every name queued', [$queuedNow['queued'], $queuedNow['pending'], $queuedNow['queueFull']], [29, 29, false]);
check('share: a lookup job', $mysql->query("SELECT status, friendlyCorporations FROM fork_intel_lookups WHERE scanID = $scanID")->fetch(PDO::FETCH_NUM),
    ['pending', (string) FRIENDLY_CORP]);
$again = intel_affiliation_request($mysql, $names, USER, true);
check('share: asking again queues nothing new', [$again['queued'], $again['pending']], [0, 29]);
$view = intel_pilots_view($mysql, $scanID, $names, USER, ['corporations' => [FRIENDLY_CORP], 'alliances' => []]);
check('view: all pending before the worker ran', [$view['pending'], $view['threatPending'], $view['pilots'][0], count($view['pilots'])],
    [29, true, [null, null, null, null], 29]);

// The lookup job waits for the names
check('lookups: waits for the names', intel_lookups_run($mysql), null);
check('lookups: still pending', $mysql->query("SELECT status FROM fork_intel_lookups WHERE scanID = $scanID")->fetchColumn(), 'pending');

// Worker pass 1: names -> IDs, affiliations, entities (fake ESI)
$handler = $esiHandler;
$calls = [];
limiter_reset();
$line = intel_affiliation_run($mysql, 8);
$routes = array_map(function ($c) { return $c[0] . ' ' . parse_url($c[1], PHP_URL_PATH); }, $calls);
check('worker: ESI requests in order', $routes, ['POST /universe/ids', 'POST /characters/affiliation',
    'GET /corporations/' . RAIDERS, 'GET /corporations/' . LONERS, 'GET /corporations/' . FRIENDLY_CORP, 'GET /alliances/' . ALLIANCE]);
check('worker: only ESI was called', array_values(array_unique(array_map(function ($c) { return parse_url($c[1], PHP_URL_HOST); }, $calls))), ['esi.evetech.net']);
check('worker: one batch of names', count(json_decode($calls[0][2], true)), 29);
check('worker: log line', $line, 'local pilots: 28 names resolved (1 unknown), 28 affiliations, 4 corporations/alliances in 6 ESI requests');
$get = function ($name) use ($mysql) {
    $stmt = $mysql->prepare('SELECT characterID, corporationID, allianceID, status FROM fork_pilot_affiliation WHERE name = ?');
    $stmt->execute([$name]);
    return array_map(function ($v) { return $v === null ? null : (is_numeric($v) ? (int) $v : $v); }, $stmt->fetch(PDO::FETCH_NUM));
};
check('worker: hostile in an alliance', $get('Zzt Hostile 03'), [2100000103, RAIDERS, ALLIANCE, 'done']);
check('worker: name pasted in lower case', $get('zzt hostile 01'), [2100000101, RAIDERS, ALLIANCE, 'done']);
check('worker: NPC corporation', $get('Zzt Newbie'), [2100000202, NPC_CORP, null, 'done']);
check('worker: unknown name', $get('Zzt Ghost'), [0, null, null, 'done']);
check('worker: left out of the affiliation answer', $get('Zzt Lost'), [2100000203, null, null, 'done']);
check('worker: NPC corporations are not looked up', (int) $mysql->query('SELECT COUNT(*) FROM fork_pilot_entities WHERE id = ' . NPC_CORP)->fetchColumn(), 0);
check('worker: tickers', intel_entities($mysql, [RAIDERS, LONERS, ALLIANCE, NPC_CORP]),
    [(string) RAIDERS => ['Zzt Raiders', 'ZZR'], (string) LONERS => ['Zzt <Loners> & Co', 'Z&L'], (string) ALLIANCE => ['Zzt Alliance', 'ZZA']]);
limiter_reset();
$calls = [];
check('worker: nothing left to do', [intel_affiliation_run($mysql, 8), count($calls)], [null, 0]);

// The lookup job now picks the threat lookups: hostiles first (20 at most), never the friendly, NPC corp only if room
$handler = function () { return [599, 'no requests expected', []]; };
$line = intel_lookups_run($mysql);
$picked = array_map('intval', $mysql->query('SELECT characterID FROM fork_pilot_threat WHERE characterID BETWEEN 2100000000 AND 2199999999 ORDER BY characterID')->fetchAll(PDO::FETCH_COLUMN));
check('lookups: 20 pilots queued', [count($picked), $line], [20, "local threat: scan $scanID: 20 pilots queued for zKillboard stats"]);
check('lookups: the first 20 hostiles in paste order', $picked, range(2100000101, 2100000120));
check('lookups: job done', array_map('strval', $mysql->query("SELECT status, threatQueued FROM fork_intel_lookups WHERE scanID = $scanID")->fetch(PDO::FETCH_NUM)), ['done', '20']);
check('lookups: no requests', count($calls), 0);

// View: groups data, entities, threat states
$view = intel_pilots_view($mysql, $scanID, $names, USER, ['corporations' => [FRIENDLY_CORP], 'alliances' => []]);
check('view: resolved', [$view['pending'], $view['threatPending'], $view['lookups'], $view['threat']], [0, false, true, true]);
check('view: hostile with queued threat', $view['pilots'][2], [2100000103, RAIDERS, ALLIANCE, 'q']);
check('view: past the 20 cap', $view['pilots'][24], [2100000125, LONERS, null, null]);
check('view: friendly, unknown', [$view['pilots'][25], $view['pilots'][27]], [[2100000201, FRIENDLY_CORP, null, null], [0, null, null, null]]);
check('view: entities', (array) $view['entities'], intel_entities($mysql, [RAIDERS, LONERS, ALLIANCE, FRIENDLY_CORP]));

// --- Worker priority: system stats before pilot stats, nothing while back-fills wait or zKillboard is paused ---
$statsAnswer = ['type' => 'solarSystemID', 'id' => TEST_STATS_SYSTEM, 'shipsDestroyed' => 1, 'months' => [], 'topLists' => [], 'activepvp' => []];
$handler = function ($method, $url, $body) use ($answer, $statsAnswer) {
    if (parse_url($url, PHP_URL_HOST) !== 'zkillboard.com') return [599, 'not zKillboard', []];
    if (strpos($url, '/api/stats/solarSystemID/') !== false) return [200, json_encode($statsAnswer), []];
    if (preg_match('#/api/stats/characterID/(\d+)/kills/$#', $url, $m)) return [200, json_encode(['id' => (int) $m[1]] + $answer), []];
    return [404, '', []];
};
$mysql->exec('INSERT INTO zkill_system_stats (systemID, status, priority, requestedAt, wantedAt) VALUES (' . TEST_STATS_SYSTEM . ", 'queued', 10, UTC_TIMESTAMP(), UTC_TIMESTAMP())");
$calls = [];
limiter_reset();
check('priority: no back-fills queued (the step would run one)', (int) $mysql->query("SELECT COUNT(*) FROM zkill_backfill WHERE status = 'queued'")->fetchColumn(), 0);
intel_zkill_api_step($mysql);
check('priority: system stats first', array_map(function ($c) { return $c[1]; }, $calls), ['https://zkillboard.com/api/stats/solarSystemID/' . TEST_STATS_SYSTEM . '/kills/']);
check('priority: one zKillboard request per step', [intel_zkill_api_step($mysql), count($calls)], [null, 1]);   // ZKILL_API_INTERVAL not over
limiter_reset();
$line = intel_zkill_api_step($mysql);
check('priority: then pilot stats', [$calls[1][1], $line], ['https://zkillboard.com/api/stats/characterID/2100000101/kills/', 'pilot stats 2100000101: danger 87%, 1234 kills']);
$stored = $mysql->query('SELECT status, data, fetchedAt IS NOT NULL FROM fork_pilot_threat WHERE characterID = 2100000101')->fetch(PDO::FETCH_NUM);
check('threat: stored compact', [$stored[0], json_decode($stored[1], true), (int) $stored[2]], ['done', json_decode(json_encode($compact), true), 1]);
// Back-fill waiting: no pilot stats
$mysql->exec('INSERT INTO zkill_backfill (systemID, windowSeconds, status, priority, requestedAt) VALUES (' . TEST_STATS_SYSTEM . ", 3600, 'queued', 10, UTC_TIMESTAMP())");
limiter_reset();
check('priority: nothing while a back-fill is queued', [intel_threat_run_one($mysql), count($calls)], [null, 2]);
$mysql->exec('DELETE FROM zkill_backfill WHERE systemID = ' . TEST_STATS_SYSTEM);
// System stats waiting: no pilot stats
$mysql->exec("UPDATE zkill_system_stats SET status = 'queued' WHERE systemID = " . TEST_STATS_SYSTEM);
limiter_reset();
check('priority: nothing while system stats are queued', [intel_threat_run_one($mysql), count($calls)], [null, 2]);
$mysql->exec('DELETE FROM zkill_system_stats WHERE systemID = ' . TEST_STATS_SYSTEM);
// zKillboard paused (spacing, backoff, block)
limiter_reset();
zk_http_pause('zkillboard.com', microtime(true) + 60);
check('priority: nothing while zKillboard is paused', [intel_threat_run_one($mysql), count($calls)], [null, 2]);
// A failed lookup
limiter_reset();
$handler = function () { return [503, 'busy', []]; };
check('threat: failure', intel_threat_run_one($mysql), 'pilot stats 2100000102: zKillboard: HTTP 503');
check('threat: failed row', $mysql->query('SELECT status, data FROM fork_pilot_threat WHERE characterID = 2100000102')->fetch(PDO::FETCH_NUM), ['failed', null]);
$view = intel_pilots_view($mysql, $scanID, $names, USER, ['corporations' => [FRIENDLY_CORP], 'alliances' => []]);
check('view: threat done / failed', [$view['pilots'][0][3], $view['pilots'][1][3]], [json_decode(json_encode($compact), true), 'f']);

// --- Expiry: stale affiliations and unknown names are queued again when viewed ---
$mysql->exec("UPDATE fork_pilot_affiliation SET fetchedAt = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE name = 'Zzt Hostile 05'");
$mysql->exec("UPDATE fork_pilot_affiliation SET fetchedAt = UTC_TIMESTAMP() - INTERVAL 2 DAY WHERE name = 'Zzt Ghost'");
$request = intel_affiliation_request($mysql, $names, USER, true);
check('expiry: two names queued again, neither pending (old data shows)', [$request['queued'], $request['pending']], [2, 0]);
check('expiry: a known character keeps its ID', $get('Zzt Hostile 05'), [2100000105, RAIDERS, ALLIANCE, 'queued']);
check('expiry: an unknown name is resolved from scratch', $get('Zzt Ghost'), [null, null, null, 'queued']);
limiter_reset();
$handler = $esiHandler;
$calls = [];
intel_affiliation_run($mysql, 8);
check('expiry: refreshed with one call each', array_map(function ($c) { return $c[0] . ' ' . parse_url($c[1], PHP_URL_PATH) . ' ' . $c[2]; }, $calls),
    ['POST /universe/ids ["Zzt Ghost"]', 'POST /characters/affiliation [2100000105]']);
check('expiry: done again', [$get('Zzt Hostile 05'), $get('Zzt Ghost')], [[2100000105, RAIDERS, ALLIANCE, 'done'], [0, null, null, 'done']]);

// --- Rejected affiliation batch: tiers, then failed alone ---
$mysql->exec("UPDATE fork_pilot_affiliation SET status = 'queued', fetchedAt = NULL WHERE name IN ('Zzt Hostile 06', 'Zzt Hostile 07')");
$handler = function ($method, $url, $body) use ($esiHandler) {
    if (strpos($url, 'characters/affiliation') !== false && in_array(2100000107, json_decode($body, true), true)) return [400, '{"error":"Invalid character ID"}', []];
    return $esiHandler($method, $url, $body);
};
$passes = [];
for ($i = 0; $i < 4; $i++) {
    limiter_reset();
    $calls = [];
    intel_affiliation_run($mysql, 8);
    $passes[] = array_map(function ($c) { return $c[2]; }, $calls);
}
check('reject: big batch, then small batch, then alone', $passes, [['[2100000106,2100000107]'], ['[2100000106,2100000107]'], ['[2100000106]', '[2100000107]'], []]);
check('reject: the bad one failed, the good one done', [$get('Zzt Hostile 07')[3], $get('Zzt Hostile 06')[3]], ['failed', 'done']);

// --- Caps: per user and hour, whatever became of the names (unknown names resolve within seconds) ---
$fill = [];
for ($i = 0; $i < INTEL_AFF_MAX_PER_USER - 1; $i++) $fill[] = sprintf('Zzt Cap %05d', $i);
foreach (array_chunk($fill, 1000) as $chunk) {
    $mysql->prepare('INSERT INTO fork_pilot_affiliation (name, characterID, status, requestedBy, requestedAt, wantedAt, fetchedAt) VALUES '
        . implode(',', array_fill(0, count($chunk), "(?, 0, 'done', " . CAP_USER . ', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())')))->execute($chunk);
}
$capped = intel_affiliation_request($mysql, ['Zzt Over One', 'Zzt Over Two', 'Zzt Over Three'], CAP_USER, true);
check('cap: one more name fits, the rest is refused', [$capped['queued'], $capped['pending'], $capped['queueFull']], [1, 1, true]);
check('cap: other users are not affected', intel_affiliation_request($mysql, ['Zzt Other User'], USER, true)['queued'], 1);
// Pending is only lowered for names that counted as pending: a stale unknown name (not pending) and a name another
// user already queued (pending, not queued again) next to a refused new one
$mysql->exec("INSERT INTO fork_pilot_affiliation (name, characterID, status, requestedBy, requestedAt, wantedAt, fetchedAt) VALUES
    ('Zzt Stale Unknown', 0, 'done', " . USER . ", UTC_TIMESTAMP() - INTERVAL 2 HOUR, UTC_TIMESTAMP(), UTC_TIMESTAMP() - INTERVAL 2 HOUR)");
$mysql->exec("INSERT INTO fork_pilot_affiliation (name, status, requestedBy, requestedAt, wantedAt) VALUES ('Zzt Queued Other', 'queued', " . USER . ', UTC_TIMESTAMP(), UTC_TIMESTAMP())');
$capped = intel_affiliation_request($mysql, ['Zzt Stale Unknown', 'Zzt Queued Other', 'Zzt Over Four'], CAP_USER, true);
check('cap: pending keeps the queued name, drops the refused one', [$capped['queued'], $capped['pending'], $capped['queueFull']], [0, 1, true]);
$mysql->exec("DELETE FROM fork_pilot_affiliation WHERE name IN ('Zzt Stale Unknown', 'Zzt Queued Other')");
$mysql->exec('DELETE FROM fork_pilot_affiliation WHERE requestedBy = ' . CAP_USER);
check('cap: an hour later the user may queue again', intel_affiliation_room(0, 0, CAP_USER, 3), 3);
check('cap: one user alone can never fill the queue', INTEL_AFF_MAX_PER_USER < INTEL_AFF_MAX_QUEUED / 2, true);

// --- Housekeeping: names nobody could resolve are given up after an hour ---
$mysql->exec("UPDATE fork_pilot_affiliation SET status = 'queued', characterID = NULL, requestedAt = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE name = 'Zzt Other User'");
intel_pilots_housekeeping($mysql, time(), false);
check('housekeeping: gave up', $get('Zzt Other User')[3], 'failed');
$view = intel_pilots_view($mysql, $scanID, ['Zzt Other User'], 0, ['corporations' => [], 'alliances' => []]);
check('view: given up counts as unknown', $view['pilots'][0], [0, null, null, null]);

// --- Names outside EVE's charset: unknown, never looked up or queued (full-width letters fold to ASCII in MySQL) ---
check('charset: plain', intel_lookup_name('Zzt Hostile 03'), true);
check("charset: ' . - _", intel_lookup_name("O'Neil Mc-Fly_2.0"), true);
check('charset: full-width', intel_lookup_name('Ｚzt Hostile 03'), false);
check('charset: accented', intel_lookup_name('Zzt Hóstile'), false);
check('charset: too short / trailing space', [intel_lookup_name('Ab'), intel_lookup_name('Abc ')], [false, false]);
$before = $get('Zzt Hostile 03');
$odd = intel_affiliation_request($mysql, ['Ｚzt Hostile 03', 'Zzt Hóstile'], USER, true);
check('charset: not queued, not pending', [$odd['queued'], $odd['pending']], [0, 0]);
check('charset: the real row is left alone', $get('Zzt Hostile 03'), $before);
check('charset: no rows for them', (int) $mysql->query("SELECT COUNT(*) FROM fork_pilot_affiliation WHERE name LIKE '%stile 03' AND name <> 'Zzt Hostile 03'")->fetchColumn(), 0);
$view = intel_pilots_view($mysql, $scanID, ['Ｚzt Hostile 03', 'Zzt Hostile 03'], USER, ['corporations' => [], 'alliances' => []]);
check('charset: shown as unknown', [$view['pilots'][0], $view['pilots'][1][0]], [[0, null, null, null], 2100000103]);

// --- Renamed characters: name -> ID is checked again after a day ---
$mysql->exec("UPDATE fork_pilot_affiliation SET fetchedAt = UTC_TIMESTAMP() - INTERVAL 2 HOUR, resolvedAt = UTC_TIMESTAMP() - INTERVAL 2 DAY WHERE name = 'Zzt Hostile 08'");
$mysql->exec("UPDATE fork_pilot_affiliation SET fetchedAt = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE name = 'Zzt Hostile 09'");
intel_affiliation_request($mysql, ['Zzt Hostile 08', 'Zzt Hostile 09'], USER, true);
check('rename: old mapping kept on show while it is checked', $get('Zzt Hostile 08'), [2100000108, RAIDERS, ALLIANCE, 'queued']);
$view = intel_pilots_view($mysql, $scanID, ['Zzt Hostile 08'], USER, ['corporations' => [], 'alliances' => []]);
check('rename: not pending meanwhile', [$view['pending'], $view['pilots'][0][0]], [0, 2100000108]);
$handler = function ($method, $url, $body) use ($esiHandler) {
    if (strpos($url, 'universe/ids') !== false) return [200, '{}', []];   // the old name is gone
    return $esiHandler($method, $url, $body);
};
limiter_reset();
$calls = [];
intel_affiliation_run($mysql, 8);
check('rename: only the old mapping is asked again', array_map(function ($c) { return parse_url($c[1], PHP_URL_PATH) . ' ' . $c[2]; }, $calls),
    ['/universe/ids ["Zzt Hostile 08"]', '/characters/affiliation [2100000109]']);
check('rename: the old name is now unknown', $get('Zzt Hostile 08'), [0, null, null, 'done']);

// --- Unknown names are deleted after an hour ---
$mysql->exec("UPDATE fork_pilot_affiliation SET fetchedAt = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE name = 'Zzt Hostile 08'");
intel_pilots_housekeeping($mysql, time(), false);
check('prune: unknown name gone', (int) $mysql->query("SELECT COUNT(*) FROM fork_pilot_affiliation WHERE name = 'Zzt Hostile 08'")->fetchColumn(), 0);
check('prune: known names kept', $get('Zzt Hostile 09')[0], 2100000109);

// --- Entity refresh: failed lookups retried after a day, stale names after a week, the rest untouched ---
$mysql->exec("INSERT INTO fork_pilot_entities (id, kind, name, ticker, status, requestedAt, wantedAt, fetchedAt, attempts) VALUES
    (2100007001, 'corporation', NULL, NULL, 'failed', UTC_TIMESTAMP() - INTERVAL 2 DAY, UTC_TIMESTAMP() - INTERVAL 2 DAY, NULL, 3),
    (2100007002, 'corporation', NULL, NULL, 'failed', UTC_TIMESTAMP() - INTERVAL 2 HOUR, UTC_TIMESTAMP() - INTERVAL 2 HOUR, NULL, 3),
    (2100007003, 'alliance', 'Old Name', 'OLD', 'done', UTC_TIMESTAMP() - INTERVAL 8 DAY, UTC_TIMESTAMP() - INTERVAL 8 DAY, UTC_TIMESTAMP() - INTERVAL 8 DAY, 0),
    (2100007004, 'corporation', 'Fresh', 'FRSH', 'done', UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP() - INTERVAL 1 DAY, 0)");
intel_queue_entities($mysql, [2100007001 => 'corporation', 2100007002 => 'corporation', 2100007003 => 'alliance', 2100007004 => 'corporation']);
$entity = function ($id) use ($mysql) {
    return array_map('strval', $mysql->query("SELECT status, attempts, requestedAt > UTC_TIMESTAMP() - INTERVAL 1 MINUTE, wantedAt > UTC_TIMESTAMP() - INTERVAL 1 MINUTE
        FROM fork_pilot_entities WHERE id = $id")->fetch(PDO::FETCH_NUM));
};
check('entities: failed more than a day ago is queued again', $entity(2100007001), ['queued', '0', '1', '1']);
check('entities: failed recently is left alone', $entity(2100007002), ['failed', '3', '0', '1']);
check('entities: stale name is queued again', $entity(2100007003), ['queued', '0', '1', '1']);
check('entities: fresh name is left alone', $entity(2100007004), ['done', '0', '0', '1']);
intel_queue_entities($mysql, [2100007002 => 'corporation']);
check('entities: asking again does not reset the retry clock', $entity(2100007002), ['failed', '3', '0', '1']);
$mysql->exec('DELETE FROM fork_pilot_entities WHERE id BETWEEN 2100007001 AND 2100007004');

// --- Wall-clock budget: no new ESI request after INTEL_AFF_PASS_SECONDS ---
$budget = ['requests' => 0, 'max' => 8, 'until' => microtime(true) - 1];
check('budget: past the deadline', [intel_esi_take($budget), $budget['requests']], [false, 0]);
$values = [];
for ($i = 0; $i < 8; $i++) $values[] = '(' . (2100008000 + $i) . ", 'corporation', 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())";
$mysql->exec('INSERT INTO fork_pilot_entities (id, kind, status, requestedAt, wantedAt) VALUES ' . implode(',', $values));
$handler = function ($method, $url, $body) { usleep(1100000); return [200, '{"name":"Slow Corp","ticker":"SLOW"}', []]; };
limiter_reset();
$calls = [];
$started = microtime(true);
intel_affiliation_run($mysql, 8);
check('budget: a slow ESI stops the pass after about 3 s', [count($calls), microtime(true) - $started < 4.5], [3, true]);
$mysql->exec('DELETE FROM fork_pilot_entities WHERE id BETWEEN 2100008000 AND 2100008007');

// --- zKillboard character stats: answer shapes (no request; the stats route of zKillboard's view/apistats.php) ---
$zeros = intel_threat_compact([]);
check('answer: empty body', intel_threat_answer(200, ''), [$zeros, '', false]);
check('answer: null', intel_threat_answer(200, 'null'), [$zeros, '', false]);
check('answer: []', intel_threat_answer(200, ' [] '), [$zeros, '', false]);
check('answer: {}', intel_threat_answer(200, '{}'), [$zeros, '', false]);
check('answer: no record of the character', intel_threat_answer(200, '{"error":"Invalid type or id"}'), [$zeros, '', false]);
check('answer: other error', intel_threat_answer(200, '{"error":"entity is disqualified"}'), [null, 'zKillboard: entity is disqualified', false]);
check('answer: stats', intel_threat_answer(200, json_encode($answer))[0], $compact);
check('answer: challenge page blocks', array_slice(intel_threat_answer(200, '<html><title>Just a moment...</title></html>'), 1), ['HTTP 200 without JSON: Just a moment...', true]);
check('answer: HTTP error', intel_threat_answer(503, 'busy'), [null, 'zKillboard: HTTP 503', false]);
// The worker path with empty answers: zeros stored, zKillboard not blocked
foreach (['', 'null', '[]'] as $i => $body) {
    $id = 2100000501 + $i;
    $mysql->exec("INSERT INTO fork_pilot_threat (characterID, status, requestedAt) VALUES ($id, 'queued', UTC_TIMESTAMP() - INTERVAL 1 DAY)");
    $handler = function () use ($body) { return [200, $body, []]; };
    limiter_reset();
    $calls = [];
    $line = intel_threat_run_one($mysql);
    $row = $mysql->query("SELECT status, data FROM fork_pilot_threat WHERE characterID = $id")->fetch(PDO::FETCH_NUM);
    check("worker: answer '$body' is no stats", [$calls[0][1] ?? null, $row[0], json_decode($row[1], true), zk_http_wait('zkillboard.com') <= zk_api_interval()],
        [intel_threat_url($id), 'done', json_decode(json_encode($zeros), true), true]);
}
$mysql->exec("INSERT INTO fork_pilot_threat (characterID, status, requestedAt) VALUES (2100000504, 'queued', UTC_TIMESTAMP() - INTERVAL 1 DAY)");
$handler = function () { return [200, '<html>challenge</html>', []]; };
limiter_reset();
intel_threat_run_one($mysql);
check('worker: a challenge page still blocks zKillboard', zk_http_wait('zkillboard.com') > 300, true);
limiter_reset();


// --- Server-wide switch ---
$off = json_decode(shell_exec('php ' . escapeshellarg(__FILE__) . ' --threat-off'), true);
check('threat off: no request, stays queued', $off, ['line' => null, 'calls' => 0, 'status' => 'queued', 'enabled' => false]);

cleanup($mysql);
echo ($failures ? "FAILED: $failures of $count checks\n" : "OK: $count checks\n");
exit($failures ? 1 : 0);
