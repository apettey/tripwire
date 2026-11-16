<?php
// Fork-owned: tests for broken_wormholes.inc.php (the paste preview's broken holes, applied and listed by
// public/refresh.php through broken_wormholes_refresh), against the dev database: id checks, CSRF rule, mask
// isolation, mark / restore / list, holes that are gone, audit entries. Uses masks no real user has and removes its rows.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/broken_wormholes_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../broken_wormholes.inc.php');

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

// --- ids (pure) ---
check('id string', broken_wormholes_id('42'), 42);
check('id int', broken_wormholes_id(42), 42);
check('id zero', broken_wormholes_id('0'), false);
check('id negative', broken_wormholes_id(-3), false);
check('id eve-scout', broken_wormholes_id('ES-123'), false);
check('id float', broken_wormholes_id('1.5'), false);
check('id too big', broken_wormholes_id('99999999999'), false);
check('id array', broken_wormholes_id(array(1)), false);
check('ids list', broken_wormholes_ids(array('3', 3, 'x', '4', null)), array(3, 4));
check('ids not a list', broken_wormholes_ids('3'), array());
check('ids capped', count(broken_wormholes_ids(range(1, BROKEN_WORMHOLES_MAX + 50))), BROKEN_WORMHOLES_MAX);

// --- Storage, against the dev database ---
$mysql = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4',
	getenv('DB_USER'), getenv('DB_PASSWORD'));
$maskA = '999990011.0';
$maskB = '999990012.0';
$who = array('id' => 999990011, 'name' => 'Broken Tester');

function bw_sig($mysql, $mask, $systemID, $sigID) {
	$stmt = $mysql->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, maskID)
		VALUES (:sig, :systemID, 'wormhole', '', 86400, 1, 'test', 1, 'test', :mask)");
	$stmt->execute(array(':sig' => $sigID, ':systemID' => $systemID, ':mask' => $mask));
	return (int)$mysql->lastInsertId();
}
function bw_hole($mysql, $mask, $sigID = 'tst001') {
	$a = bw_sig($mysql, $mask, 31001159, $sigID);
	$b = bw_sig($mysql, $mask, 31000005, null);
	$stmt = $mysql->prepare("INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (:a, :b, 'O477', 'initial', 'stable', 'stable', :mask)");
	$stmt->execute(array(':a' => $a, ':b' => $b, ':mask' => $mask));
	return (int)$mysql->lastInsertId();
}
function bw_cleanup($mysql, $masks) {
	foreach ($masks as $m) {
		$mysql->exec("DELETE FROM wormholes WHERE maskID = '$m'");
		$mysql->exec("DELETE FROM signatures WHERE maskID = '$m'");
		try { $mysql->exec("DELETE FROM fork_broken_wormholes WHERE maskID = '$m'"); } catch (Throwable $e) { /* no table yet */ }
		try { $mysql->exec("DELETE FROM fork_audit_log WHERE maskID = '$m'"); } catch (Throwable $e) { /* no audit table yet */ }
	}
}
function bw_ids($list) { return array_map(function ($b) { return $b['wormholeID']; }, $list); }
function bw_audit($mysql, $mask) {
	try {
		$stmt = $mysql->query("SELECT action, detail, subject FROM fork_audit_log WHERE maskID = '$mask' AND entity = 'wormhole' ORDER BY id");
		return $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : array();
	} catch (Throwable $e) { return array(); }
}

bw_cleanup($mysql, array($maskA, $maskB));
try {
	$h1 = bw_hole($mysql, $maskA, 'abc123');
	$h2 = bw_hole($mysql, $maskA, 'def456');
	$hB = bw_hole($mysql, $maskB, 'ghi789');

	// Reading before anything is marked (the table may not exist yet): an empty list, no error
	$out = null;
	broken_wormholes_refresh($mysql, $maskA, null, false, $who, $out);
	check('list empty', $out['brokenHoles'], array());
	check('no result without a request', isset($out['brokenHolesResult']), false);

	// Changes need the CSRF token
	$out = array();
	broken_wormholes_refresh($mysql, $maskA, array('mark' => array((string)$h1)), false, $who, $out);
	check('csrf refused', $out['brokenHolesResult']['result'], false);
	check('csrf: nothing marked', $out['brokenHoles'], array());

	// Mark: own holes only (mask B's hole and unknown ids are skipped)
	$out = array();
	broken_wormholes_refresh($mysql, $maskA, array('mark' => array((string)$h1, (string)$hB, '2147483000', 'x')), true, $who, $out);
	check('mark result', $out['brokenHolesResult']['result'], true);
	check('mark marked', $out['brokenHolesResult']['marked'], array($h1));
	check('mark list', bw_ids($out['brokenHoles']), array($h1));
	check('mark by', $out['brokenHoles'][0]['markedBy'], 'Broken Tester');
	check('mark at', $out['brokenHoles'][0]['markedAt'] > time() - 120, true);
	check('mask B untouched', bw_ids(broken_wormholes_list($mysql, $maskB)), array());

	// Marking again changes nothing (no second audit entry)
	$out = array();
	broken_wormholes_refresh($mysql, $maskA, array('mark' => array($h1, $h2)), true, $who, $out);
	check('mark again', $out['brokenHolesResult']['marked'], array($h2));
	check('list two', bw_ids($out['brokenHoles']), array($h1, $h2));

	// Another mask can't restore ours
	$out = array();
	broken_wormholes_refresh($mysql, $maskB, array('restore' => array($h1)), true, $who, $out);
	check('other mask restore', $out['brokenHolesResult']['restored'], array());
	check('still broken', bw_ids(broken_wormholes_list($mysql, $maskA)), array($h1, $h2));

	// Restore
	$out = array();
	broken_wormholes_refresh($mysql, $maskA, array('restore' => array((string)$h1)), true, $who, $out);
	check('restore', $out['brokenHolesResult']['restored'], array($h1));
	check('restore list', bw_ids($out['brokenHoles']), array($h2));

	// A hole that is gone (expired / deleted) is never listed, and its row goes with the next change
	$mysql->exec("DELETE FROM wormholes WHERE id = $h2");
	check('gone not listed', broken_wormholes_list($mysql, $maskA), array());
	broken_wormholes_refresh($mysql, $maskA, array('mark' => array(), 'restore' => array()), true, $who, $out);
	$left = (int)$mysql->query("SELECT COUNT(*) FROM fork_broken_wormholes WHERE maskID = '$maskA'")->fetchColumn();
	check('gone row cleaned', $left, 0);

	// Audit log: mark h1, mark h2, restore h1
	$audit = bw_audit($mysql, $maskA);
	if (audit_days() > 0) {
		check('audit count', count($audit), 3);
		check('audit mark', json_decode($audit[0]['detail'], true)['changes']['broken'], array('', 'yes'));
		check('audit mark from', json_decode($audit[0]['detail'], true)['from'], 'ABC123');
		check('audit restore', json_decode($audit[2]['detail'], true)['changes']['broken'], array('yes', ''));
		check('audit subject', $audit[0]['subject'], 'O477');
	}

	// A bad request value is ignored, the list still comes back
	$out = array();
	broken_wormholes_refresh($mysql, $maskA, 'mark', true, $who, $out);
	check('string request ignored', isset($out['brokenHolesResult']), false);
	check('string request list', $out['brokenHoles'], array());
} finally {
	bw_cleanup($mysql, array($maskA, $maskB));
}

echo "$count checks, $failures failed\n";
exit($failures ? 1 : 0);
