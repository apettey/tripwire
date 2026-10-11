<?php
// Fork-owned: tests for system_status.inc.php (validation, storage) and public/system_status.php (over HTTP, mask
// scoping), against the dev stack. Uses its own test masks and removes everything it created.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/system_status_test.php
// The HTTP part logs in as the dev user (docker/dev-seed.sh) and removes the rows it set for the dev mask again.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

define('SYSTEM_STATUS_MAX_ROWS', 3);	// small cap for the eviction checks (the HTTP part below talks to the server, which has its own)
require_once(__DIR__ . '/../system_status.inc.php');

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

// --- pure ---
check('system id wormhole', system_status_system_id('31000001'), 31000001);
check('system id k-space', system_status_system_id(30000142), 30000142);
check('system id abyssal refused', system_status_system_id('32000001'), false);
check('system id junk', system_status_system_id('3100000a'), false);
check('system id array', system_status_system_id(array('31000001')), false);
check('system id too long', system_status_system_id('310000011'), false);
check('status ok', system_status_clean_status('hostile'), 'hostile');
check('status empty clears', system_status_clean_status(''), null);
check('status null clears', system_status_clean_status(null), null);
check('status unknown', system_status_clean_status('red'), false);
check('status case', system_status_clean_status('Hostile'), false);
check('status array', system_status_clean_status(array('hostile')), false);
check('text trimmed', system_status_clean_text("  Home\t 2 \n", 24), 'Home 2');
check('text html kept as text', system_status_clean_text('<b>x</b>', 24), '<b>x</b>');
check('text bidi removed', system_status_clean_text("a\u{200B}b\u{202E}c", 24), 'abc');
check('text length', mb_strlen(system_status_clean_text(str_repeat('é', 100), SYSTEM_STATUS_ALIAS_MAX)), SYSTEM_STATUS_ALIAS_MAX);
check('text not a string', system_status_clean_text(array('x'), 24), '');
check('text bad utf-8', mb_check_encoding(system_status_clean_text("ab\xC3", 24), 'UTF-8'), true);

// --- storage ---
$mysql = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4',
	getenv('DB_USER'), getenv('DB_PASSWORD'));
$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
system_status_ensure_table($mysql);
system_status_ensure_table($mysql);	// twice: no error
$maskA = '999990011.0';
$maskB = '999990012.0';
$cleanup = function() use ($mysql, $maskA, $maskB) {
	$mysql->exec("DELETE FROM fork_system_status WHERE maskID IN ('$maskA', '$maskB')");
};
$cleanup();

check('empty list', system_status_list($mysql, $maskA), array());
$row = system_status_update($mysql, $maskA, 31000001, array('status' => 'hostile'), 'Alice');
check('set status', array($row['status'], $row['alias'], $row['occupier'], $row['setBy']), array('hostile', '', '', 'Alice'));
$row = system_status_update($mysql, $maskA, 31000001, array('alias' => ' Staging '), 'Bob');
check('alias keeps status', array($row['status'], $row['alias'], $row['setBy']), array('hostile', 'Staging', 'Bob'));
$row = system_status_update($mysql, $maskA, 31000001, array('occupier' => '[HSTL] Hostile Corp'), 'Bob');
check('occupier keeps rest', array($row['status'], $row['alias'], $row['occupier']), array('hostile', 'Staging', '[HSTL] Hostile Corp'));
$row = system_status_update($mysql, $maskA, 31000001, array('status' => null), 'Bob');
check('clear status keeps alias', array($row['status'], $row['alias']), array(null, 'Staging'));
check('longer than the column is cut', mb_strlen(system_status_update($mysql, $maskA, 31000002, array('alias' => str_repeat('x', 80)), 'A')['alias']), SYSTEM_STATUS_ALIAS_MAX);

// Mask scoping: same system, other mask
system_status_update($mysql, $maskB, 31000001, array('status' => 'friendly', 'alias' => 'Home'), 'Carol');
check('mask A unchanged by B', system_status_get($mysql, $maskA, 31000001)['alias'], 'Staging');
check('mask B own row', system_status_get($mysql, $maskB, 31000001)['status'], 'friendly');
check('list only own mask', array_map(function($r) { return $r['systemID']; }, system_status_list($mysql, $maskA)), array(31000001, 31000002));
check('list other mask', count(system_status_list($mysql, $maskB)), 1);
system_status_clear($mysql, $maskA, 31000001);
check('clear only own mask', system_status_get($mysql, $maskB, 31000001) !== null, true);
check('cleared', system_status_get($mysql, $maskA, 31000001), null);

// A row with nothing left is deleted
system_status_update($mysql, $maskA, 31000003, array('alias' => 'x'), 'A');
check('emptied row is gone', system_status_update($mysql, $maskA, 31000003, array('alias' => ''), 'A'), null);
check('emptied row is deleted', system_status_get($mysql, $maskA, 31000003), null);
check('clearing nothing is fine', system_status_update($mysql, $maskA, 31000009, array('status' => null), 'A'), null);

// Cap (3 in this test): when full, the oldest row of a system NOT on the mask's chain is dropped; never one on the chain
function ss_test_sig($mysql, $mask, $sig, $systemID) {
	$mysql->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, maskID)
		VALUES (:sig, :sid, 'wormhole', '', 86400, 1, 'test', 1, 'test', :mask)")->execute(array(':sig' => $sig, ':sid' => $systemID, ':mask' => $mask));
}
$cleanup();
check('cap is the test value', SYSTEM_STATUS_MAX_ROWS, 3);
$mysql->exec("DELETE FROM signatures WHERE maskID = '$maskA'");
ss_test_sig($mysql, $maskA, 'tst002', 31000001);
foreach (array(31000001, 31000002, 31000003) as $i => $sid) {
	system_status_update($mysql, $maskA, $sid, array('status' => 'active'), 'A');
	$mysql->exec("UPDATE fork_system_status SET setAt = FROM_UNIXTIME(" . (1700000000 + $i * 100) . ") WHERE maskID = '$maskA' AND systemID = $sid");
}
check('full: new system evicts the oldest off-chain row', system_status_update($mysql, $maskA, 31000004, array('status' => 'hostile'), 'A')['systemID'], 31000004);
check('chain system (oldest) kept', system_status_get($mysql, $maskA, 31000001) !== null, true);
check('oldest off-chain row dropped', system_status_get($mysql, $maskA, 31000002), null);
check('still at the cap', count(system_status_list($mysql, $maskA)), 3);
check('updating an existing row at the cap needs no room', system_status_update($mysql, $maskA, 31000003, array('alias' => 'x'), 'A')['alias'], 'x');
ss_test_sig($mysql, $maskA, 'tst003', 31000003);
ss_test_sig($mysql, $maskA, 'tst004', 31000004);
check('full and all on the chain: refused', system_status_update($mysql, $maskA, 31000005, array('status' => 'hostile'), 'A'), false);
$mysql->exec("DELETE FROM signatures WHERE maskID = '$maskA'");
// A signature with a NULL systemID (NOT IN would match nothing then) must not stop eviction
$nullable = $mysql->query("SELECT IS_NULLABLE FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'signatures' AND column_name = 'systemID'")->fetchColumn();
if ($nullable === 'YES') {
	$mysql->exec("INSERT INTO signatures (signatureID, systemID, type, name, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, maskID)
		VALUES ('tstnul', NULL, 'wormhole', '', 86400, 1, 'test', 1, 'test', '$maskA')");
	check('NULL-systemID signature: still evicts', system_status_update($mysql, $maskA, 31000006, array('status' => 'hostile'), 'A')['systemID'], 31000006);
	$mysql->exec("DELETE FROM signatures WHERE maskID = '$maskA'");
} else {
	check('signatures.systemID is NOT NULL here (NULL case not reachable)', true, true);
}
// Poll hash: same rows, same hash; any change, other hash
$rowsNow = system_status_list($mysql, $maskA);
check('hash stable', system_status_hash($rowsNow), system_status_hash(system_status_list($mysql, $maskA)));
system_status_update($mysql, $maskA, 31000003, array('alias' => 'y'), 'A');
check('hash changes with the data', system_status_hash($rowsNow) !== system_status_hash(system_status_list($mysql, $maskA)), true);

// Survives the system leaving the chain: nothing in this table refers to signatures or wormholes
$cleanup();

// --- public/system_status.php over HTTP ---
$base = getenv('STATUS_BASE') ?: 'http://127.0.0.1';
$user = getenv('DEV_USERNAME') ?: 'dev';
$password = getenv('DEV_PASSWORD') ?: 'dev-password';
function http($method, $path, $jar, $body = null, array $headers = array()) {
	global $base;
	$ch = curl_init($base . '/' . ltrim($path, '/'));
	curl_setopt_array($ch, array(CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEJAR => $jar,
		CURLOPT_COOKIEFILE => $jar, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20));
	if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
	$text = curl_exec($ch);
	$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
	curl_close($ch);
	return array($status, json_decode((string)$text, true));
}
$xhr = array('X-Requested-With: XMLHttpRequest');
$anon = sys_get_temp_dir() . '/status-anon.cookies';
$jar = sys_get_temp_dir() . '/status-dev.cookies';
@unlink($anon); @unlink($jar);
check('anonymous GET is 403', http('GET', 'system_status.php', $anon)[0], 403);
check('anonymous POST is 403', http('POST', 'system_status.php', $anon, 'mode=clear&systemID=31000001', $xhr)[0], 403);

list($s, $out) = http('POST', 'login.php', $jar, http_build_query(array('mode' => 'login', 'username' => $user, 'password' => $password)));
if (($out['result'] ?? '') !== 'success') { fwrite(STDERR, "login failed (run docker/dev-seed.sh first)\n"); exit(1); }
$stmt = $mysql->prepare('SELECT c.corporationID FROM accounts a INNER JOIN characters c ON c.userID = a.id WHERE a.username = ?');
$stmt->execute(array($user));
$devMask = $stmt->fetchColumn() . '.2';
$mysql->exec("DELETE FROM fork_system_status WHERE maskID = '" . $devMask . "' AND systemID IN (31999991, 31999992)");
$mysql->exec("DELETE FROM fork_system_status WHERE maskID = '$maskB'");
system_status_update($mysql, $maskB, 31999991, array('status' => 'friendly', 'alias' => 'Other mask'), 'Carol');	// must never show up

list($s, $first) = http('GET', 'system_status.php', $jar);
check('GET ok', $s, 200);
check('GET has a hash and the systems', isset($first['hash'], $first['systems']), true);
check('GET with the current hash: unchanged', http('GET', 'system_status.php?have=' . $first['hash'], $jar)[1], array('unchanged' => true, 'hash' => $first['hash']));
check('GET with an old hash: full answer', isset(http('GET', 'system_status.php?have=0123', $jar)[1]['systems']), true);
check('POST without header', http('POST', 'system_status.php', $jar, 'mode=set&systemID=31999991&status=hostile')[0], 400);
check('POST bad system', http('POST', 'system_status.php', $jar, 'mode=set&systemID=1&status=hostile', $xhr)[0], 400);
check('POST abyssal system', http('POST', 'system_status.php', $jar, 'mode=set&systemID=32000001&status=hostile', $xhr)[0], 400);
check('POST bad status', http('POST', 'system_status.php', $jar, 'mode=set&systemID=31999991&status=red', $xhr)[0], 400);
check('POST nothing to set', http('POST', 'system_status.php', $jar, 'mode=set&systemID=31999991', $xhr)[0], 400);
check('POST array alias', http('POST', 'system_status.php', $jar, 'mode=set&systemID=31999991&alias[]=x', $xhr)[0], 400);
check('POST unknown mode', http('POST', 'system_status.php', $jar, 'mode=nope&systemID=31999991', $xhr)[0], 400);
check('PUT refused', http('PUT', 'system_status.php', $jar, 'mode=clear&systemID=31999991', $xhr)[0], 405);

list($s, $out) = http('POST', 'system_status.php', $jar, 'mode=set&systemID=31999991&status=hostile&alias=Staging&occupier=%5BHSTL%5D+Hostile+Corp', $xhr);
check('set 200', $s, 200);
$mine = null;
foreach ($out['systems'] as $r) { if ($r['systemID'] === 31999991) $mine = $r; }
check('set returned', $mine !== null ? array($mine['status'], $mine['alias'], $mine['occupier']) : null, array('hostile', 'Staging', '[HSTL] Hostile Corp'));
check('other mask not in the answer', count(array_filter($out['systems'], function($r) { return $r['alias'] === 'Other mask'; })), 0);
list($s, $out) = http('POST', 'system_status.php', $jar, 'mode=set&systemID=31999991&status=', $xhr);
$mine = null;
foreach ($out['systems'] as $r) { if ($r['systemID'] === 31999991) $mine = $r; }
check('empty status clears only the status', $mine !== null ? array($mine['status'], $mine['alias']) : null, array(null, 'Staging'));
list($s, $out) = http('POST', 'system_status.php', $jar, 'mode=clear&systemID=31999991', $xhr);
check('clear 200', $s, 200);
check('cleared in the answer', count(array_filter($out['systems'], function($r) { return $r['systemID'] === 31999991; })), 0);
check('clearing did not touch the other mask', system_status_get($mysql, $maskB, 31999991)['alias'], 'Other mask');

$cleanup();
$mysql->exec("DELETE FROM fork_system_status WHERE maskID = '" . $devMask . "' AND systemID IN (31999991, 31999992)");
@unlink($anon); @unlink($jar);

echo $failures ? "$failures of $count checks FAILED\n" : "All $count checks passed\n";
exit($failures ? 1 : 0);
