<?php
// Fork-owned: tests for sovereignty.inc.php (parsing, the region's part, caches, refresh intervals, alliance names) with
// fake ESI calls; no network.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/sovereignty_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../sovereignty.inc.php');

$failures = 0;
function check($name, $actual, $expected) {
	global $failures;
	if ($actual !== $expected) {
		$failures++;
		fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
	}
}

// ---- Parsing ----
$mapBody = json_encode(array(
	array('system_id' => 30000001, 'faction_id' => 500007),
	array('system_id' => 30004759, 'alliance_id' => 1354830081, 'corporation_id' => 98000001),
	array('system_id' => 30004760, 'alliance_id' => 99003581, 'corporation_id' => 98000002),
	array('system_id' => 30004761),
	array('alliance_id' => 1),
	'junk',
));
$map = sov_parse_map($mapBody);
check('map: alliance', $map[30004759], array('a' => 1354830081, 'c' => 98000001));
check('map: faction', $map[30000001], array('f' => 500007));
check('map: unclaimed and junk left out', array_keys($map), array(30000001, 30004759, 30004760));
check('map: not json', sov_parse_map('<html>'), null);
check('map: an object is not a list', sov_parse_map('{"a":1}'), null);
check('map: empty list is fine', sov_parse_map('[]'), array());

$incBody = json_encode(array(
	array('constellation_id' => 20000064, 'faction_id' => 500019, 'has_boss' => true, 'infested_solar_systems' => array(30000440, 30000444, 'x'),
		'influence' => 0.62345, 'staging_solar_system_id' => 30000444, 'state' => 'established', 'type' => 'Incursion'),
	array('constellation_id' => 20000013, 'state' => 'weird', 'influence' => 7),
	array('faction_id' => 1),
));
$inc = sov_parse_incursions($incBody);
check('incursions: count', count($inc), 2);
check('incursions: row', $inc[0], array('constellationID' => 20000064, 'factionID' => 500019, 'boss' => true, 'systems' => array(30000440, 30000444),
	'influence' => 0.623, 'staging' => 30000444, 'state' => 'established', 'type' => 'Incursion'));
check('incursions: unknown state and influence clamped', array($inc[1]['state'], $inc[1]['influence'], $inc[1]['boss']), array('established', 1.0, false));
check('incursions: not json', sov_parse_incursions('x'), null);

check('clean text', sov_clean_text("  Goons\x07warm  ", 5), 'Goons');

// ---- The region's part ----
[$systems, $alliances] = sov_region_shape($map, array(30004759, 30004760, 30004761, 30000001));
check('region: systems', $systems, array(30004759 => array('a' => 1354830081, 'c' => 98000001), 30004760 => array('a' => 99003581, 'c' => 98000002), 30000001 => array('f' => 500007)));
check('region: alliances', $alliances, array(1354830081, 99003581));

$dir = sys_get_temp_dir() . '/sov-test-' . getmypid();
@mkdir($dir);
@mkdir($dir . '/regions');
file_put_contents($dir . '/regions/10000060.json', json_encode(array('id' => 10000060, 'systems' => array(array(30004759, '1DQ1-A', 1, 2, 0, -0.4), array(30004760, '8WA-Z6', 3, 4, 0, -0.6), array('bad')))));
check('region systems from the layout file', sov_region_systems(10000060, $dir . '/regions'), array(30004759, 30004760));
check('unknown region', sov_region_systems(10000999, $dir . '/regions'), null);
check('no region', sov_region_systems(0, $dir . '/regions'), null);

// ---- One cached feed ----
$file = $dir . '/feed.json';
$calls = 0;
$ok = function () use (&$calls) { $calls++; return array(array('x' => 1), null); };
$fail = function () use (&$calls) { $calls++; return array(null, 'ESI answered 500'); };
$t = 2000000;
$r = sov_feed_get($file, 3600, $ok, $t);
check('feed: first call fetches', array($calls, $r['data'], $r['fetched'], $r['stale'], $r['unavailable']), array(1, array('x' => 1), $t, false, false));
sov_feed_get($file, 3600, $ok, $t + 3599);
check('feed: within the TTL: cache', $calls, 1);
sov_feed_get($file, 3600, $ok, $t + 3600);
check('feed: after the TTL: fetch again', $calls, 2);
$r = sov_feed_get($file, 3600, $fail, $t + 7200);
check('feed: failure serves the old copy', array($calls, $r['data'], $r['error'], $r['stale']), array(3, array('x' => 1), 'ESI answered 500', false));
sov_feed_get($file, 3600, $fail, $t + 7200 + SOV_RETRY - 1);
check('feed: no retry within SOV_RETRY', $calls, 3);
$r = sov_feed_get($file, 3600, $fail, $t + 3600 + 7200 + 1);
check('feed: copy older than twice the TTL is stale', array($calls, $r['stale']), array(4, true));
$r = sov_feed_get($dir . '/never.json', 600, $fail, $t);
check('feed: never fetched is unavailable', array($r['unavailable'], $r['stale'], $r['data']), array(true, false, array()));

// ---- Alliance names and tickers ----
$afile = $dir . '/alliances.json';
$asked = array('names' => array(), 'one' => array());
$lookups = array(
	'names' => function ($ids) use (&$asked) { $asked['names'][] = $ids; $out = array(); foreach ($ids as $id) $out[$id] = 'Name ' . $id; return $out; },
	'one' => function ($id) use (&$asked) { $asked['one'][] = $id; return $id === 3 ? null : array('name' => 'Alliance ' . $id, 'ticker' => 'T' . ($id % 10000)); },
);
[$names, $pending] = sov_alliances(array(1, 2, 3, 2), $t, $lookups, $afile);
check('alliances: one names call for the new ones', $asked['names'], array(array(1, 2, 3)));
check('alliances: tickers looked up one by one', $asked['one'], array(1, 2, 3));
check('alliances: result', $names, array(1 => array('name' => 'Alliance 1', 'ticker' => 'T1'), 2 => array('name' => 'Alliance 2', 'ticker' => 'T2'), 3 => array('name' => 'Name 3', 'ticker' => '')));
check('alliances: a failed one is not pending right after its try', $pending, false);
$asked = array('names' => array(), 'one' => array());
sov_alliances(array(1, 2, 3), $t + 60, $lookups, $afile);
check('alliances: cached, the failed one not asked again at once', $asked, array('names' => array(), 'one' => array()));
[$names, $pending] = sov_alliances(array(1, 3), $t + SOV_ALLIANCE_RETRY, $lookups, $afile);
check('alliances: the failed one is asked again after SOV_ALLIANCE_RETRY (it has a name already)', $asked, array('names' => array(), 'one' => array(3)));
sov_alliances(array(1), $t + SOV_ALLIANCE_TTL, $lookups, $afile);
check('alliances: refreshed after a week', $asked['one'], array(3, 1));

// The per-request cap: the rest are pending, with names already
$capFile = $dir . '/alliances-cap.json';
$many = range(1000, 1000 + SOV_ALLIANCE_PER_PASS + 4);
$asked = array('names' => array(), 'one' => array());
[$names, $pending] = sov_alliances($many, $t, $lookups, $capFile);
check('alliances: at most SOV_ALLIANCE_PER_PASS lookups per request', count($asked['one']), SOV_ALLIANCE_PER_PASS);
check('alliances: the rest are pending, named from /universe/names', array($pending, $names[1000 + SOV_ALLIANCE_PER_PASS + 4]), array(true, array('name' => 'Name ' . (1000 + SOV_ALLIANCE_PER_PASS + 4), 'ticker' => '')));
[$names, $pending] = sov_alliances($many, $t + 1, $lookups, $capFile);
check('alliances: the next request finishes them', array($pending, count($asked['one'])), array(false, count($many)));

// ---- The whole answer ----
$deps = array(
	'dir' => $dir, 'regionDir' => $dir . '/regions',
	'map' => function () use ($mapBody) { return array(sov_parse_map($mapBody), null); },
	'incursions' => function () use ($incBody) { return array(sov_parse_incursions($incBody), null); },
	'lookups' => $lookups,
);
$r = sov_region(10000060, $t, $deps);
check('region: shape', array_keys($r), array('region', 'systems', 'alliances', 'pending', 'incursions', 'sov', 'incursionsStatus'));
check('region: systems', json_encode($r['systems']), '{"30004759":{"a":1354830081,"c":98000001},"30004760":{"a":99003581,"c":98000002}}');
check('region: alliances named', json_encode($r['alliances']), '{"1354830081":{"name":"Alliance 1354830081","ticker":"T81"},"99003581":{"name":"Alliance 99003581","ticker":"T3581"}}');
check('region: all incursions', count($r['incursions']), 2);
check('region: status', $r['sov'], array('fetched' => $t, 'stale' => false, 'unavailable' => false, 'error' => null));
check('region: unknown region', sov_region(10000999, $t, $deps), null);

// ESI down from the start: the map still answers (empty), with the reason
$down = $deps;
$down['dir'] = $dir . '/down';
@mkdir($down['dir']);
$down['map'] = function () { return array(null, 'ESI answered 503'); };
$down['incursions'] = $down['map'];
$r = sov_region(10000060, $t, $down);
check('ESI down: unavailable, empty, says why', array($r['sov']['unavailable'], $r['sov']['error'], json_encode($r['systems']), $r['incursions']), array(true, 'ESI answered 503', '{}', array()));

// Clean up
foreach (glob($dir . '/{,*/}*', GLOB_BRACE) as $f) { if (is_file($f)) @unlink($f); }
@rmdir($dir . '/regions'); @rmdir($dir . '/down'); @rmdir($dir);

if ($failures) { fwrite(STDERR, "$failures failure(s)\n"); exit(1); }
echo "sovereignty: all tests passed\n";
