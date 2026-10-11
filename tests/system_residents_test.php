<?php
// Fork-owned: tests for system_residents.inc.php (Set residents, behind public/system_residents.php): validation, the
// ESI lookups with a fake transport (no network), and the storage against the dev database (own test masks, removed
// afterwards).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/system_residents_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../system_residents.inc.php');

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

// --- validation (pure) ---
check('system wormhole', system_residents_system_id('31002012'), 31002012);
check('system k-space', system_residents_system_id('30000142'), 30000142);
check('system int', system_residents_system_id(31000005), 31000005);
check('system abyssal', system_residents_system_id('32000001'), false);
check('system out of range', system_residents_system_id('34000001'), false);
check('system short', system_residents_system_id('3100201'), false);
check('system junk', system_residents_system_id('31002012x'), false);
check('system array', system_residents_system_id(array('31002012')), false);

check('entity id', system_residents_entity_id('98700001'), 98700001);
check('entity id int', system_residents_entity_id(99700001), 99700001);
check('entity id zero', system_residents_entity_id('0'), false);
check('entity id negative', system_residents_entity_id(-5), false);
check('entity id too big', system_residents_entity_id('99999999999'), false);
check('entity id float', system_residents_entity_id('1.5'), false);

check('picks', system_residents_parse_picks('[{"kind":"corporation","id":98700001,"name":"<b>ignored</b>"},{"kind":"alliance","id":"99700001"}]'),
	array(array('kind' => 'corporation', 'id' => 98700001), array('kind' => 'alliance', 'id' => 99700001)));
check('picks deduped', count(system_residents_parse_picks('[{"kind":"corporation","id":5},{"kind":"corporation","id":5}]')), 1);
check('picks empty', system_residents_parse_picks(''), array());
check('picks bad kind', system_residents_parse_picks('[{"kind":"character","id":5}]'), 'Invalid entity');
check('picks bad id', system_residents_parse_picks('[{"kind":"corporation","id":"5; DROP"}]'), 'Invalid entity');
check('picks not a list', system_residents_parse_picks('{"kind":"corporation","id":5}'), 'entities must be a JSON list');
check('picks not json', system_residents_parse_picks('nope'), 'entities must be a JSON list');
check('picks too long', system_residents_parse_picks(str_repeat(' ', 5000)), 'entities must be a JSON list');

check('names', system_residents_parse_names('["  Deep  Space Dwellers ","deep space dwellers","", "WNDR"]'), array('Deep Space Dwellers', 'WNDR'));
check('names not strings', system_residents_parse_names('[5]'), 'Invalid name');
check('names too long', is_string(system_residents_parse_names(json_encode(array(str_repeat('a', 60))))), true);

check('note cleaned', system_residents_clean_text("  EU\tTZ \n<b>x</b>", SYSTEM_RESIDENTS_NOTE_MAX), 'EU TZ <b>x</b>');
check('note length', mb_strlen(system_residents_clean_text(str_repeat('é', 500), SYSTEM_RESIDENTS_NOTE_MAX)), SYSTEM_RESIDENTS_NOTE_MAX);
check('ticker ok', system_residents_clean_ticker('A.B-C'), 'A.B-C');
check('ticker html', system_residents_clean_ticker('<b>'), '');
check('ticker long', system_residents_clean_ticker('ABCDEF'), '');

check('decode drops junk', system_residents_decode_entities('[{"kind":"corporation","id":1,"name":"A","ticker":"<x>"},{"kind":"x","id":2},{"id":3},"s"]'),
	array(array('kind' => 'corporation', 'id' => 1, 'name' => 'A', 'ticker' => '')));
check('decode not json', system_residents_decode_entities('nope'), array());

// --- ESI lookups (fake transport) ---
$calls = array();
esi_transport(function($method, $url, $headers, $body) use (&$calls) {
	$calls[] = $method . ' ' . preg_replace('#^https://esi\.evetech\.net/#', '', $url) . ($body !== null ? ' ' . $body : '');
	if ($method === 'POST' && strpos($url, 'universe/ids/') !== false) {
		$names = json_decode($body, true);
		$out = array();
		if (in_array('Deep Space Dwellers', $names, true) || in_array('deep space dwellers', $names, true)) $out['corporations'] = array(array('id' => 98700001, 'name' => 'Deep Space Dwellers'));
		if (in_array('Twin', $names, true)) { $out['corporations'][] = array('id' => 98700009, 'name' => 'Twin'); $out['alliances'] = array(array('id' => 99700009, 'name' => 'Twin')); }
		if (in_array('Somebody', $names, true)) $out['characters'] = array(array('id' => 90000001, 'name' => 'Somebody'));
		return array(200, json_encode($out), array());
	}
	if (preg_match('#/(corporations|alliances)/(\d+)/$#', $url, $m)) {
		$known = array('corporations' => array(98700001 => array('Deep Space Dwellers', 'DSD'), 98700009 => array('Twin', 'TWC'), 98700002 => array('Static <Hunters>', '<x>')),
			'alliances' => array(99700001 => array('Wanderers Collective', 'WNDR'), 99700009 => array('Twin', 'TWA')));
		if ((int)$m[2] === 98700500) return array(503, 'down', array());
		if (!isset($known[$m[1]][(int)$m[2]])) return array(404, '{"error":"not found"}', array());
		return array(200, json_encode(array('name' => $known[$m[1]][(int)$m[2]][0], 'ticker' => $known[$m[1]][(int)$m[2]][1])), array());
	}
	return array(500, 'unexpected', array());
});

$r = system_residents_resolve(array(array('kind' => 'alliance', 'id' => 99700001)), array('deep space dwellers'));
check('resolve: names and tickers from ESI', $r, array('entities' => array(
	array('kind' => 'alliance', 'id' => 99700001, 'name' => 'Wanderers Collective', 'ticker' => 'WNDR'),
	array('kind' => 'corporation', 'id' => 98700001, 'name' => 'Deep Space Dwellers', 'ticker' => 'DSD')), 'unknown' => array(), 'error' => null, 'invalid' => false));

$r = system_residents_resolve(array(), array('No Such Corp', 'Somebody'));
check('resolve: unknown names (characters do not count)', $r['unknown'], array('No Such Corp', 'Somebody'));
check('resolve: unknown names stored nothing', $r['entities'], array());

$r = system_residents_resolve(array(), array('Twin'));
check('resolve: a name shared by a corporation and an alliance gives both', array_map(function($e) { return $e['kind'] . ':' . $e['ticker']; }, $r['entities']), array('corporation:TWC', 'alliance:TWA'));

$r = system_residents_resolve(array(array('kind' => 'alliance', 'id' => 98700001)), array());
check('resolve: an ID of another kind is refused', $r['error'], 'Unknown alliance 98700001');
check('resolve: an unknown entity is a client error (400)', $r['invalid'], true);

$r = system_residents_resolve(array(array('kind' => 'corporation', 'id' => 98700002)), array());
check('resolve: ESI text is cleaned', $r['entities'], array(array('kind' => 'corporation', 'id' => 98700002, 'name' => 'Static <Hunters>', 'ticker' => '')));

$calls = array();
$known = array('corporation:98700001' => array('kind' => 'corporation', 'id' => 98700001, 'name' => 'Stored', 'ticker' => 'ST'));
$local = function($entities) { return array('alliance:99700001' => array('name' => 'Cached Alliance', 'ticker' => 'CA'), 'corporation:98700500' => array('name' => 'Cached Corp', 'ticker' => '')); };
$r = system_residents_resolve(array(array('kind' => 'corporation', 'id' => 98700001), array('kind' => 'alliance', 'id' => 99700001), array('kind' => 'corporation', 'id' => 98700500)), array(), $known, $local);
check('resolve: stored and cached entities', array_map(function($e) { return $e['name'] . '/' . $e['ticker']; }, $r['entities']), array('Stored/ST', 'Cached Alliance/CA', 'Cached Corp/'));
check('resolve: a cached name without ticker is enough, ESI is not asked', $calls, array());

$r = system_residents_resolve(array(array('kind' => 'corporation', 'id' => 98700500)), array());
check('resolve: ESI down without a cached name is an error', $r['error'], 'ESI could not look up corporation 98700500 (HTTP 503)');
check('resolve: ESI down is an upstream error (502)', $r['invalid'], false);

$many = array();
for ($i = 1; $i <= SYSTEM_RESIDENTS_MAX + 1; $i++) $many[] = array('kind' => 'corporation', 'id' => 98700100 + $i);
$r = system_residents_resolve($many, array());
check('resolve: at most ' . SYSTEM_RESIDENTS_MAX, $r['error'], 'At most ' . SYSTEM_RESIDENTS_MAX . ' corporations and alliances');
check('resolve: too many is a client error', $r['invalid'], true);

esi_transport(function() { return array(0, 'timeout', array()); });
$r = system_residents_resolve(array(), array('Deep Space Dwellers'));
check('resolve: ESI unreachable for names', $r['error'], 'ESI could not look up the names (no answer)');
check('resolve: ESI unreachable is an upstream error', $r['invalid'], false);
esi_transport(null, true);

// --- Storage, against the dev database ---
if (getenv('DB_HOST')) {
	$mysql = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
	$maskA = '999990011.0';
	$maskB = '999990012.0';
	$cleanup = function() use ($mysql, $maskA, $maskB) {
		$mysql->prepare('DELETE FROM fork_system_residents WHERE maskID IN (?, ?)')->execute(array($maskA, $maskB));
	};
	try {
		system_residents_ensure_table($mysql);
		$cleanup();
		check('nothing set', system_residents_get($mysql, $maskA, 31002012), null);
		$entities = array(array('kind' => 'corporation', 'id' => 98700001, 'name' => 'Deep Space Dwellers', 'ticker' => 'DSD'));
		system_residents_set($mysql, $maskA, 31002012, $entities, "  EU TZ\n", 'Pilot');
		$got = system_residents_get($mysql, $maskA, 31002012);
		check('set: entities', $got['entities'], $entities);
		check('set: note cleaned', $got['note'], 'EU TZ');
		check('set: by', $got['setBy'], 'Pilot');
		check('set: at', abs($got['setAt'] - time()) < 120, true);
		check('other mask does not see it', system_residents_get($mysql, $maskB, 31002012), null);
		check('other system does not see it', system_residents_get($mysql, $maskA, 31002013), null);
		system_residents_set($mysql, $maskA, 31002012, array(), 'x', 'Other');
		check('set again replaces', system_residents_get($mysql, $maskA, 31002012)['setBy'], 'Other');
		system_residents_clear($mysql, $maskA, 31002012);
		check('cleared', system_residents_get($mysql, $maskA, 31002012), null);
		system_residents_clear($mysql, $maskA, 31002012);
		check('clear twice is fine', system_residents_get($mysql, $maskA, 31002012), null);
		check('local info without stats', system_residents_local_info($mysql, 31999999, array(array('kind' => 'corporation', 'id' => 1))), array());
	} catch (Throwable $e) {
		$failures++;
		fwrite(STDERR, 'ERROR ' . $e->getMessage() . "\n");
	}
	$cleanup();
} else {
	echo "(no DB_HOST: storage checks skipped)\n";
}

echo ($failures ? "$failures of $count checks FAILED" : "all $count checks passed") . "\n";
exit($failures ? 1 : 0);
