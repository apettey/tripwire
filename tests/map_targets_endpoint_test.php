<?php
// Fork-owned: tests of public/map_targets.php (access, CSRF rule, validation, mask isolation, add / remove / clear /
// reorder, the cap per mask, expiry and purge, audit entries) against the dev database. Uses masks no real user has and
// removes its rows afterwards.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/map_targets_endpoint_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../public');
require_once(__DIR__ . '/../config.php');
require_once(__DIR__ . '/../db.inc.php');
require_once(__DIR__ . '/../map_targets.inc.php');
require_once(__DIR__ . '/../audit/audit.inc.php');

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

const MASK_A = '999999981.1';
const MASK_B = '999999981.2';
const CHAR_A = 999999981;
const AMAMAKE = 30002537;
const EC_P8R = 30001984;
const JITA = 30000142;

function session_a() { return ['userID' => 900011, 'mask' => MASK_A, 'characterID' => CHAR_A, 'characterName' => 'Test Pilot']; }

/** Run the endpoint in a separate PHP process. @return [status, decoded body] */
function call($method, $params = [], $session = null, $xhr = true) {
	$request = [
		'method' => $method,
		'get' => $method === 'GET' ? $params : [],
		'post' => $method === 'POST' ? $params : [],
		'session' => $session === null ? session_a() : $session,
		'headers' => $xhr ? ['X-Requested-With' => 'XMLHttpRequest'] : [],
	];
	$proc = proc_open(['php', __DIR__ . '/map_targets_runner.php'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
	fwrite($pipes[0], json_encode($request));
	fclose($pipes[0]);
	$body = stream_get_contents($pipes[1]);
	$err = stream_get_contents($pipes[2]);
	proc_close($proc);
	$status = preg_match('/STATUS (\d+)/', $err, $m) ? (int) $m[1] : 0;
	return [$status, json_decode($body, true)];
}
/** Several POSTs at the same time (one PHP process each). @return [status, ...] in the order given */
function call_parallel(array $paramsList) {
	$procs = [];
	foreach ($paramsList as $params) {
		$request = ['method' => 'POST', 'get' => [], 'post' => $params, 'session' => session_a(), 'headers' => ['X-Requested-With' => 'XMLHttpRequest']];
		$p = proc_open(['php', __DIR__ . '/map_targets_runner.php'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
		fwrite($pipes[0], json_encode($request));
		fclose($pipes[0]);
		$procs[] = [$p, $pipes];
	}
	$out = [];
	foreach ($procs as [$p, $pipes]) {
		stream_get_contents($pipes[1]);
		$err = stream_get_contents($pipes[2]);
		proc_close($p);
		$out[] = preg_match('/STATUS (\d+)/', $err, $m) ? (int) $m[1] : 0;
	}
	return $out;
}
/** Target system IDs of a response, in list order */
function ids($body) { return array_map(function ($t) { return $t['systemID']; }, $body['targets'] ?? []); }
function cleanup($mysql) {
	$mysql->exec('DELETE FROM fork_map_targets WHERE maskID IN (' . MASK_A . ', ' . MASK_B . ')');
	try { $mysql->exec('DELETE FROM fork_audit_log WHERE maskID IN (' . MASK_A . ', ' . MASK_B . ')'); } catch (Throwable $e) { /* no audit table yet */ }
}
function audit_actions($mysql) {
	try {
		$stmt = $mysql->query("SELECT CONCAT(action, ':', systemID) FROM fork_audit_log WHERE maskID = " . MASK_A . " AND entity = 'target' ORDER BY id");
		return $stmt ? $stmt->fetchAll(PDO::FETCH_COLUMN) : [];
	} catch (Throwable $e) { return []; }
}

// --- Validation (pure) ---
$now = 1800000000;
check('note: trimmed, control characters as spaces', map_targets_note("  hit\tthis\x01 one "), 'hit this one');
check('note: clipped to 60', mb_strlen(map_targets_note(str_repeat('é', 80)), 'UTF-8'), 60);
check('note: html kept as text (escaped on render)', map_targets_note('<b>x</b>'), '<b>x</b>');
check('note: array', map_targets_note(['x']), false);
check('note: bad UTF-8', map_targets_note("\xff\xfe"), false);
check('expiry: default 6 h', map_targets_expiry(null, null, $now), $now + 6 * 3600);
check('expiry: 1 h', map_targets_expiry('1', null, $now), $now + 3600);
check('expiry: 24 h', map_targets_expiry('24', null, $now), $now + 86400);
check('expiry: 5 h is not a choice', map_targets_expiry('5', null, $now), false);
check('expiry: until (a skyhook window end)', map_targets_expiry(null, (string)($now + 5000), $now), $now + 5000);
check('expiry: until in the past', map_targets_expiry(null, (string)($now - 1), $now), false);
check('expiry: until too far', map_targets_expiry(null, (string)($now + 8 * 86400), $now), false);
check('expiry: until junk', map_targets_expiry(null, '1800000000 OR 1', $now), false);
check('order: list', map_targets_order('30002537,30001984'), [AMAMAKE, EC_P8R]);
check('order: empty', map_targets_order(''), []);
check('order: repeat', map_targets_order('30002537,30002537'), false);
check('order: junk', map_targets_order('30002537,x'), false);
check('order: array', map_targets_order(['30002537']), false);
check('order: too many', map_targets_order(implode(',', range(30000001, 30000026))), false);
check('system: k-space', map_targets_system_id((string)AMAMAKE), AMAMAKE);
check('system: wormhole space refused', map_targets_system_id('31000005'), false);
check('system: injection', map_targets_system_id('30002537 OR 1=1'), false);

map_targets_ensure_table($mysql);
map_targets_ensure_table($mysql);	// idempotent
cleanup($mysql);

// --- Access ---
check('no session: 403', call('GET', [], [])[0], 403);
check('session without a mask: 403', call('GET', [], ['userID' => 900011])[0], 403);
check('POST without session: 403', call('POST', ['mode' => 'add', 'systemID' => AMAMAKE], [])[0], 403);
check('POST without X-Requested-With (CSRF): 400', call('POST', ['mode' => 'add', 'systemID' => AMAMAKE], null, false)[0], 400);
check('nothing stored by the refused POST', ids(call('GET')[1]), []);
check('unknown mode: 400', call('POST', ['mode' => 'nope'])[0], 400);
check('wormhole system: 400', call('POST', ['mode' => 'add', 'systemID' => '31000005'])[0], 400);
check('missing systemID: 400', call('POST', ['mode' => 'add'])[0], 400);
check('bad expiry: 400', call('POST', ['mode' => 'add', 'systemID' => AMAMAKE, 'hours' => '5'])[0], 400);
check('bad order: 400', call('POST', ['mode' => 'reorder', 'order' => 'x'])[0], 400);
check('PUT: 405', call('PUT')[0], 405);

// --- Add, list, update, remove ---
[$status, $body] = call('GET');
check('empty list', [$status, $body['targets'], $body['max']], [200, [], 25]);
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => AMAMAKE, 'note' => ' <i>hit</i> ', 'hours' => '3']);
check('add: 200 and listed', [$status, $body['result'], ids($body)], [200, true, [AMAMAKE]]);
$t = $body['targets'][0];
check('add: note, creator, expiry', [$t['note'], $t['createdBy'], $t['expires'] - $body['now']], ['<i>hit</i>', ['id' => CHAR_A, 'name' => 'Test Pilot'], 3 * 3600]);
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => EC_P8R], ['userID' => 900012, 'mask' => MASK_A, 'characterID' => 999999982, 'characterName' => 'Other Pilot']);
check('same mask, other member: sees it and adds at the end', ids($body), [AMAMAKE, EC_P8R]);
check('second target by the other member', $body['targets'][1]['createdBy']['name'], 'Other Pilot');
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => AMAMAKE, 'note' => 'new note', 'hours' => '24']);
check('add again: note and expiry changed, order kept, still two', [ids($body), $body['targets'][0]['note'], $body['targets'][0]['expires'] - $body['now']], [[AMAMAKE, EC_P8R], 'new note', 86400]);
$expiresBefore = $body['targets'][0]['expires'];
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => AMAMAKE, 'note' => 'only the note']);
check('note only (no expiry sent): the expiry is kept', [$status, $body['targets'][0]['note'], $body['targets'][0]['expires']], [200, 'only the note', $expiresBefore]);
[$status, $body] = call('POST', ['mode' => 'reorder', 'order' => EC_P8R . ',' . AMAMAKE]);
check('reorder', [$status, ids($body)], [200, [EC_P8R, AMAMAKE]]);
[$status, $body] = call('POST', ['mode' => 'add', 'systemID' => JITA]);
check('a new one goes last', ids($body), [EC_P8R, AMAMAKE, JITA]);
[$status, $body] = call('POST', ['mode' => 'reorder', 'order' => (string)JITA]);
check('reorder with some: those first, the rest keep their order', ids($body), [JITA, EC_P8R, AMAMAKE]);
[$status, $body] = call('POST', ['mode' => 'reorder', 'order' => '30000001,' . AMAMAKE]);
check('reorder ignores systems that are not targets', ids($body), [AMAMAKE, JITA, EC_P8R]);

// --- Other masks ---
[$status, $body] = call('GET', [], ['userID' => 900013, 'mask' => MASK_B, 'characterID' => 999999983, 'characterName' => 'B']);
check('other mask sees nothing', [$status, $body['targets']], [200, []]);
call('POST', ['mode' => 'remove', 'systemID' => AMAMAKE], ['userID' => 900013, 'mask' => MASK_B, 'characterID' => 999999983, 'characterName' => 'B']);
call('POST', ['mode' => 'clear'], ['userID' => 900013, 'mask' => MASK_B, 'characterID' => 999999983, 'characterName' => 'B']);
check("other mask can't remove or clear", ids(call('GET')[1]), [AMAMAKE, JITA, EC_P8R]);
check('a malformed mask is refused', call('GET', [], ['userID' => 900011, 'mask' => '999999981.1 OR 1=1'])[0], 403);
check('a non-canonical spelling reads its canonical mask only', ids(call('GET', [], ['userID' => 900011, 'mask' => '0999999981.1'])[1]), [AMAMAKE, JITA, EC_P8R]);

[$status, $body] = call('POST', ['mode' => 'remove', 'systemID' => AMAMAKE]);
check('remove', [$status, ids($body)], [200, [JITA, EC_P8R]]);
[$status, $body] = call('POST', ['mode' => 'remove', 'systemID' => AMAMAKE]);
check('remove again: no error', [$status, ids($body)], [200, [JITA, EC_P8R]]);

// --- Expiry purge ---
$mysql->exec('UPDATE fork_map_targets SET expires = ' . (time() - 5) . ' WHERE maskID = ' . MASK_A . ' AND systemID = ' . JITA);
[$status, $body] = call('GET');
check('expired: not listed', ids($body), [EC_P8R]);
$left = $mysql->query('SELECT COUNT(*) FROM fork_map_targets WHERE maskID = ' . MASK_A . ' AND systemID = ' . JITA)->fetchColumn();
check('expired: purged from the table', (int)$left, 0);

// --- Clear ---
[$status, $body] = call('POST', ['mode' => 'clear']);
check('clear', [$status, $body['targets']], [200, []]);

// --- Audit entries (when the audit log records) ---
if (audit_days() > 0) {
	check('audit: add, add (other member), update, add, delete, clear', audit_actions($mysql),
		['add:' . AMAMAKE, 'add:' . EC_P8R, 'update:' . AMAMAKE, 'update:' . AMAMAKE, 'add:' . JITA, 'delete:' . AMAMAKE, 'clear:0']);
	$row = $mysql->query("SELECT detail FROM fork_audit_log WHERE maskID = " . MASK_A . " AND entity = 'target' AND action = 'add' ORDER BY id LIMIT 1")->fetchColumn();
	check('audit: the expiry is HH:MM within a day', preg_match('/^\{"expires":"\d\d:\d\d"\}$/', (string)$row), 1);
	call('POST', ['mode' => 'add', 'systemID' => AMAMAKE, 'until' => (string)(time() + 2 * 86400)]);
	$row = $mysql->query("SELECT detail FROM fork_audit_log WHERE maskID = " . MASK_A . " AND entity = 'target' ORDER BY id DESC LIMIT 1")->fetchColumn();
	check('audit: with the date when more than a day away', preg_match('/^\{"expires":"\d\d-\d\d \d\d:\d\d"\}$/', (string)$row), 1);
}

// --- Cap per mask ---
cleanup($mysql);
$known = array_keys(jump_jammed_known_systems());
$who = ['id' => CHAR_A, 'name' => 'Filler'];
for ($i = 0; $i < MAP_TARGETS_MAX_PER_MASK; $i++) map_targets_add($mysql, MASK_A, $known[$i], '', time() + 3600, $who, time());
check('cap: one more is refused', call('POST', ['mode' => 'add', 'systemID' => $known[MAP_TARGETS_MAX_PER_MASK]])[0], 409);
check('cap: the storage function says full', map_targets_add($mysql, MASK_A, $known[MAP_TARGETS_MAX_PER_MASK], '', time() + 3600, $who, time()), 'full');
check('cap: nothing left in a transaction', $mysql->inTransaction(), false);
check('cap: changing a target is fine', call('POST', ['mode' => 'add', 'systemID' => $known[0], 'note' => 'x'])[0], 200);
check('cap: order numbers 0..24', array_map(function ($t) { return $t['ord']; }, map_targets_list($mysql, MASK_A, time())), range(0, MAP_TARGETS_MAX_PER_MASK - 1));
$mysql->exec('UPDATE fork_map_targets SET expires = ' . (time() - 5) . ' WHERE maskID = ' . MASK_A . ' AND systemID = ' . $known[3]);
check('cap: an expired target frees its place', map_targets_add($mysql, MASK_A, $known[MAP_TARGETS_MAX_PER_MASK], '', null, $who, time()), 'add');
$new = map_targets_get($mysql, MASK_A, $known[MAP_TARGETS_MAX_PER_MASK]);
check('cap: the new one goes last, default 6 h', [(int)$new['ord'], (int)$new['expires'] - time() > 6 * 3600 - 10], [MAP_TARGETS_MAX_PER_MASK, true]);
check('cap: the expired one was purged', map_targets_get($mysql, MASK_A, $known[3]), null);
check('add on an existing row inside the function: update, expiry kept with null', [map_targets_add($mysql, MASK_A, $known[0], 'y', null, $who, time()), (int)map_targets_get($mysql, MASK_A, $known[0])['expires'] > time()], ['update', true]);

// --- Concurrent adds (the named lock): never above the cap, no deadlock (500), no lock left behind ---
cleanup($mysql);
check('parallel adds on an empty mask: all succeed', call_parallel(array_map(function ($i) use ($known) { return ['mode' => 'add', 'systemID' => $known[$i]]; }, range(0, 5))), [200, 200, 200, 200, 200, 200]);
check('parallel adds: six rows, order numbers 0..5', array_map(function ($t) { return $t['ord']; }, map_targets_list($mysql, MASK_A, time())), range(0, 5));
for ($i = 6; $i < MAP_TARGETS_MAX_PER_MASK - 2; $i++) map_targets_add($mysql, MASK_A, $known[$i], '', time() + 3600, $who, time());
$statuses = call_parallel(array_map(function ($i) use ($known) { return ['mode' => 'add', 'systemID' => $known[$i]]; }, range(30, 35)));
sort($statuses);
check('parallel adds at the cap: two fit, four are refused, none fails', $statuses, [200, 200, 409, 409, 409, 409]);
check('parallel adds at the cap: exactly 25', map_targets_count($mysql, MASK_A), MAP_TARGETS_MAX_PER_MASK);
check('the lock is free afterwards', (int)$mysql->query("SELECT IS_FREE_LOCK('map_targets:" . MASK_A . "')")->fetchColumn(), 1);
// Lock held by someone else for longer than the wait: busy (503), not a hang or a 500
$mysql->query("SELECT GET_LOCK('map_targets:" . MASK_A . "', 1)")->fetchColumn();
check('lock held elsewhere: 503', call('POST', ['mode' => 'add', 'systemID' => $known[0], 'note' => 'z'])[0], 503);
$mysql->query("SELECT RELEASE_LOCK('map_targets:" . MASK_A . "')")->fetchColumn();
check('lock released: the change goes through', call('POST', ['mode' => 'add', 'systemID' => $known[0], 'note' => 'z'])[0], 200);
// A reused (persistent) connection that still holds the lock, twice (a request died before releasing it): the next add on
// that connection drops the leaked lock, works, and leaves the lock free for everyone
$mysql->query("SELECT GET_LOCK('map_targets:" . MASK_A . "', 1)")->fetchColumn();
$mysql->query("SELECT GET_LOCK('map_targets:" . MASK_A . "', 1)")->fetchColumn();
check('leaked lock on this connection: add works', map_targets_add($mysql, MASK_A, $known[0], 'leak', null, $who, time()), 'update');
check('leaked lock on this connection: free afterwards', (int)$mysql->query("SELECT IS_FREE_LOCK('map_targets:" . MASK_A . "')")->fetchColumn(), 1);
check('leaked lock: other connections can add again', call('POST', ['mode' => 'add', 'systemID' => $known[0], 'note' => 'after'])[0], 200);

cleanup($mysql);
echo "$count checks, $failures failures\n";
exit($failures ? 1 : 0);
