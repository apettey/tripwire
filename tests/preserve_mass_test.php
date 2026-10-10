<?php
// Fork-owned: tests for preserve_mass.inc.php (the storage behind public/preserve_mass.php), against the dev database.
// Uses its own test masks and removes everything it created.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/preserve_mass_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../preserve_mass.inc.php');

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

// --- preserve_mass_clean_reason (pure) ---
check('reason plain', preserve_mass_clean_reason('home static'), 'home static');
check('reason trimmed', preserve_mass_clean_reason("  fleet\tout \n "), 'fleet out');
check('reason html kept as text', preserve_mass_clean_reason('<b>x</b> & "y"'), '<b>x</b> & "y"');
check('reason control chars', preserve_mass_clean_reason("a\x00b\x07c"), 'a b c');
check('reason zero-width / bidi removed', preserve_mass_clean_reason("a\u{200B}b\u{202E}c"), 'abc');
check('reason length', mb_strlen(preserve_mass_clean_reason(str_repeat('é', 300))), PRESERVE_MASS_REASON_MAX);
check('reason not a string', preserve_mass_clean_reason(array('x')), '');
check('reason null', preserve_mass_clean_reason(null), '');
check('reason bad utf-8', mb_check_encoding(preserve_mass_clean_reason("ab\xC3"), 'UTF-8'), true);

// --- preserve_mass_wormhole_id (pure) ---
check('id string', preserve_mass_wormhole_id('42'), 42);
check('id int', preserve_mass_wormhole_id(42), 42);
check('id zero', preserve_mass_wormhole_id('0'), false);
check('id negative', preserve_mass_wormhole_id('-3'), false);
check('id eve-scout', preserve_mass_wormhole_id('ES-123'), false);
check('id float', preserve_mass_wormhole_id('1.5'), false);
check('id too big', preserve_mass_wormhole_id('99999999999'), false);
check('id array', preserve_mass_wormhole_id(array(1)), false);
check('id leading zero', preserve_mass_wormhole_id('012'), false);

// --- Storage, against the dev database ---
$mysql = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4',
	getenv('DB_USER'), getenv('DB_PASSWORD'));
$maskA = '999990001.0';
$maskB = '999990002.0';

function pm_test_sig($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, maskID)
		VALUES ('tst001', :systemID, 'wormhole', '', 86400, 1, 'test', 1, 'test', :mask)");
	$stmt->execute(array(':systemID' => $systemID, ':mask' => $mask));
	return (int)$mysql->lastInsertId();
}
function pm_test_wormhole($mysql, $mask) {
	$a = pm_test_sig($mysql, $mask, 31000001);
	$b = pm_test_sig($mysql, $mask, 31000002);
	$stmt = $mysql->prepare("INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (:a, :b, 'H296', 'initial', 'stable', 'stable', :mask)");
	$stmt->execute(array(':a' => $a, ':b' => $b, ':mask' => $mask));
	return array('id' => (int)$mysql->lastInsertId(), 'a' => $a, 'b' => $b);
}
function pm_test_cleanup($mysql, $masks) {
	foreach ($masks as $mask) {
		$mysql->prepare('DELETE FROM fork_preserve_mass WHERE maskID = ?')->execute(array($mask));
		$mysql->prepare('DELETE FROM wormholes WHERE maskID = ?')->execute(array($mask));
		$mysql->prepare('DELETE FROM signatures WHERE maskID = ?')->execute(array($mask));
	}
}
function pm_ids($flags) { return array_map(function($f) { return $f['wormholeID']; }, $flags); }

try {
	preserve_mass_ensure_table($mysql);
	preserve_mass_ensure_table($mysql);	// idempotent
	pm_test_cleanup($mysql, array($maskA, $maskB));

	$w1 = pm_test_wormhole($mysql, $maskA);
	$w2 = pm_test_wormhole($mysql, $maskA);
	$w3 = pm_test_wormhole($mysql, $maskB);

	check('in mask', preserve_mass_wormhole_in_mask($mysql, $maskA, $w1['id']), true);
	check('other mask', preserve_mass_wormhole_in_mask($mysql, $maskA, $w3['id']), false);
	check('no such wormhole', preserve_mass_wormhole_in_mask($mysql, $maskA, 2147483000), false);

	check('empty list', preserve_mass_list($mysql, $maskA), array());
	preserve_mass_set($mysql, $maskA, $w1['id'], 'Chribba', "  home <static>\n");
	$flags = preserve_mass_list($mysql, $maskA);
	check('set: one flag', count($flags), 1);
	check('set: wormhole', $flags[0]['wormholeID'], $w1['id']);
	check('set: who', $flags[0]['setBy'], 'Chribba');
	check('set: reason cleaned', $flags[0]['reason'], 'home <static>');
	check('set: time is unix seconds', abs($flags[0]['setAt'] - time()) < 120, true);
	check('other mask sees nothing', preserve_mass_list($mysql, $maskB), array());

	preserve_mass_set($mysql, $maskA, $w1['id'], 'Kytus Bos', '');
	$flags = preserve_mass_list($mysql, $maskA);
	check('set again: still one', count($flags), 1);
	check('set again: who updated', $flags[0]['setBy'], 'Kytus Bos');
	check('set again: reason updated', $flags[0]['reason'], '');

	preserve_mass_set($mysql, $maskA, $w2['id'], null, 'fleet out');
	check('two flags', pm_ids(preserve_mass_list($mysql, $maskA)), array($w1['id'], $w2['id']));
	check('null who', preserve_mass_list($mysql, $maskA)[1]['setBy'], null);

	preserve_mass_clear($mysql, $maskA, $w2['id']);
	check('cleared', pm_ids(preserve_mass_list($mysql, $maskA)), array($w1['id']));
	preserve_mass_clear($mysql, $maskA, $w2['id']);	// no error when not flagged
	preserve_mass_clear($mysql, $maskB, $w1['id']);	// another mask can't clear it
	check('other mask clear does nothing', pm_ids(preserve_mass_list($mysql, $maskA)), array($w1['id']));

	function pm_rows($mysql, $mask) {
		$stmt = $mysql->prepare('SELECT wormholeID FROM fork_preserve_mass WHERE maskID = ? ORDER BY wormholeID');
		$stmt->execute(array($mask));
		return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
	}

	// No foreign key to upstream's wormholes (it would block TRUNCATE / ALTER / DROP of that table)
	$keys = (int)$mysql->query("SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
		WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'fork_preserve_mass' AND CONSTRAINT_TYPE = 'FOREIGN KEY'")->fetchColumn();
	check('no foreign key', $keys, 0);

	// A deleted wormhole's flag is no longer listed (read-only), and clean deletes it
	preserve_mass_set($mysql, $maskA, $w2['id'], 'x', '');
	$mysql->prepare('DELETE FROM wormholes WHERE id = ?')->execute(array($w2['id']));
	check('wormhole deleted: not listed', pm_ids(preserve_mass_list($mysql, $maskA)), array($w1['id']));
	check('wormhole deleted: row still there until clean', pm_rows($mysql, $maskA), array($w1['id'], $w2['id']));
	check('clean count', preserve_mass_clean($mysql, $maskA), 1);
	check('wormhole deleted: row gone after clean', pm_rows($mysql, $maskA), array($w1['id']));
	// ... same when a signature of it is deleted (upstream's wormholes cascade from signatures)
	$mysql->prepare('DELETE FROM signatures WHERE id = ?')->execute(array($w1['a']));
	check('signature deleted: not listed', preserve_mass_list($mysql, $maskA), array());
	preserve_mass_clean($mysql, $maskA);
	check('signature deleted: row gone after clean', pm_rows($mysql, $maskA), array());

	// A row pointing at a wormhole of another mask is neither listed nor kept
	$stmt = $mysql->prepare('INSERT INTO fork_preserve_mass (maskID, wormholeID, setBy, reason) VALUES (?, ?, ?, ?)');
	$stmt->execute(array($maskA, $w3['id'], 'x', ''));
	check('other mask wormhole: not listed', preserve_mass_list($mysql, $maskA), array());
	check('other mask wormhole: cleaned', preserve_mass_clean($mysql, $maskA), 1);
	check('clean nothing', preserve_mass_clean($mysql, $maskA), 0);
	// clean only touches its own mask
	preserve_mass_set($mysql, $maskB, $w3['id'], 'x', '');
	preserve_mass_clean($mysql, $maskA);
	check('other mask untouched', pm_ids(preserve_mass_list($mysql, $maskB)), array($w3['id']));
} catch (Throwable $e) {
	$failures++;
	fwrite(STDERR, 'ERROR ' . $e->getMessage() . "\n");
}
pm_test_cleanup($mysql, array($maskA, $maskB));

echo ($failures ? "$failures of $count checks FAILED" : "all $count checks passed") . "\n";
exit($failures ? 1 : 0);
