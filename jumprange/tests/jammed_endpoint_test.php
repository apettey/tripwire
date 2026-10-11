<?php
// Fork-owned: tests of public/jump_jammed.php (access, validation, mask isolation, set / clear / list) against the
// dev database. Uses masks that no real user has and removes its rows afterwards.
//   docker compose -f docker-compose.dev.yml exec -T app php jumprange/tests/jammed_endpoint_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../../public');
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/../../db.inc.php');
require_once(__DIR__ . '/../jammed.inc.php');

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

const MASK_A = '999999980.1';
const MASK_B = '999999980.2';
const AMAMAKE = 30002537;
const EC_P8R = 30001984;

/** Run the endpoint in a separate PHP process. @return [status, decoded body] */
function call($method, $params = [], $session = null, $xhr = true) {
	$request = [
		'method' => $method,
		'get' => $method === 'GET' ? $params : [],
		'post' => $method === 'POST' ? $params : [],
		'session' => $session === null ? ['userID' => 900001, 'mask' => MASK_A, 'characterName' => 'Test Pilot'] : $session,
		'headers' => $xhr ? ['X-Requested-With' => 'XMLHttpRequest'] : [],
	];
	$proc = proc_open(['php', __DIR__ . '/endpoint_runner.php'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
	fwrite($pipes[0], json_encode($request));
	fclose($pipes[0]);
	$body = stream_get_contents($pipes[1]);
	$err = stream_get_contents($pipes[2]);
	proc_close($proc);
	$status = preg_match('/STATUS (\d+)/', $err, $m) ? (int) $m[1] : 0;
	return [$status, json_decode($body, true)];
}
/** Marked system IDs of a response, sorted (marks made in the same second have no order) */
function ids($body) { $ids = array_map(function ($j) { return $j['systemID']; }, $body['jammed'] ?? []); sort($ids); return $ids; }
function cleanup($mysql) {
	$mysql->exec('DELETE FROM fork_jump_jammed WHERE maskID IN (' . MASK_A . ', ' . MASK_B . ')');
}

// --- Validation (pure) ---
check('id: k-space', jump_jammed_system_id((string) AMAMAKE), AMAMAKE);
check('id: int', jump_jammed_system_id(AMAMAKE), AMAMAKE);
check('id: Zarzakh is k-space', jump_jammed_system_id('30100000'), 30100000);
check('id: W-space', jump_jammed_system_id('31000005'), false);
check('id: not a system', jump_jammed_system_id('30999999'), false);
check('id: Jove region (no gates in or out, not in systems.json)', jump_jammed_system_id('30000326'), false);
check('id: float', jump_jammed_system_id('30002537.0'), false);
check('id: sign', jump_jammed_system_id('+30002537'), false);
check('id: spaces', jump_jammed_system_id(' 30002537'), false);
check('id: array', jump_jammed_system_id([AMAMAKE]), false);
check('id: empty', jump_jammed_system_id(''), false);
check('id: injection', jump_jammed_system_id('30002537 OR 1=1'), false);

jump_jammed_ensure_table($mysql);
jump_jammed_ensure_table($mysql);	// idempotent
cleanup($mysql);

// --- Access ---
check('no session: 403', call('GET', [], [])[0], 403);
check('session without a mask: 403', call('GET', [], ['userID' => 900001])[0], 403);
check('POST without session: 403', call('POST', ['mode' => 'set', 'systemID' => AMAMAKE], [])[0], 403);
check('POST without X-Requested-With (CSRF): 400', call('POST', ['mode' => 'set', 'systemID' => AMAMAKE], null, false)[0], 400);
check('nothing stored by the refused POST', ids(call('GET')[1]), []);
check('unknown mode: 400', call('POST', ['mode' => 'nope', 'systemID' => AMAMAKE])[0], 400);
check('bad systemID: 400', call('POST', ['mode' => 'set', 'systemID' => '31000005'])[0], 400);
check('missing systemID: 400', call('POST', ['mode' => 'set'])[0], 400);
check('PUT: 405', call('PUT')[0], 405);

// --- Set, list, clear ---
[$status, $body] = call('GET');
check('empty list', [$status, $body['jammed']], [200, []]);
[$status, $body] = call('POST', ['mode' => 'set', 'systemID' => AMAMAKE]);
check('set: 200 and listed', [$status, $body['result'], ids($body)], [200, true, [AMAMAKE]]);
check('set: who and age', [$body['jammed'][0]['setBy'], $body['jammed'][0]['age'] >= 0], ['Test Pilot', true]);
[$status, $body] = call('POST', ['mode' => 'set', 'systemID' => (string) AMAMAKE]);
check('set again: still one row', ids($body), [AMAMAKE]);
[$status, $body] = call('POST', ['mode' => 'set', 'systemID' => EC_P8R], ['userID' => 900002, 'mask' => MASK_A, 'characterName' => 'Other Pilot']);
check('same mask, other user: sees and adds', ids($body), [EC_P8R, AMAMAKE]);

// --- Other masks ---
[$status, $body] = call('GET', [], ['userID' => 900003, 'mask' => MASK_B]);
check('other mask sees nothing', [$status, $body['jammed']], [200, []]);
[$status, $body] = call('POST', ['mode' => 'clear', 'systemID' => AMAMAKE], ['userID' => 900003, 'mask' => MASK_B]);
check("other mask can't clear", [$status, $body['jammed']], [200, []]);
check('still marked on the first mask', ids(call('GET')[1]), [EC_P8R, AMAMAKE]);

[$status, $body] = call('POST', ['mode' => 'clear', 'systemID' => AMAMAKE]);
check('clear', [$status, ids($body)], [200, [EC_P8R]]);
[$status, $body] = call('POST', ['mode' => 'clear', 'systemID' => AMAMAKE]);
check('clear again: no error', [$status, ids($body)], [200, [EC_P8R]]);

// --- Storage helpers ---
check('is marked', jump_jammed_is_marked($mysql, MASK_A, EC_P8R), true);
check('is not marked', jump_jammed_is_marked($mysql, MASK_A, AMAMAKE), false);
check('not marked on another mask', jump_jammed_is_marked($mysql, MASK_B, EC_P8R), false);
check('count', [jump_jammed_count($mysql, MASK_A), jump_jammed_count($mysql, MASK_B)], [1, 0]);

// --- Limit per mask ---
cleanup($mysql);
$known = array_keys(jump_jammed_known_systems());
for ($i = 0; $i < JUMP_JAMMED_MAX_PER_MASK; $i++) jump_jammed_set($mysql, MASK_A, $known[$i], 'Filler');
check('limit: one more is refused', call('POST', ['mode' => 'set', 'systemID' => $known[JUMP_JAMMED_MAX_PER_MASK]])[0], 409);
check('limit: re-marking a marked system is fine', call('POST', ['mode' => 'set', 'systemID' => $known[0]])[0], 200);

cleanup($mysql);
echo "$count checks, $failures failures\n";
exit($failures ? 1 : 0);
