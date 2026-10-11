<?php
// Fork-owned: tests for rolling.inc.php (the storage behind public/rolling.php), against the dev database.
// Uses its own test masks and removes everything it created.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/rolling_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../rolling.inc.php');

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

// --- rolling_clean_note (pure; the preserve mass reason's rules) ---
check('note plain', rolling_clean_note('closing it'), 'closing it');
check('note trimmed', rolling_clean_note("  new\tstatic \n "), 'new static');
check('note html kept as text', rolling_clean_note('<b>x</b>'), '<b>x</b>');
check('note zero-width / bidi removed', rolling_clean_note("a\u{200B}b\u{202E}c"), 'abc');
check('note length', mb_strlen(rolling_clean_note(str_repeat('é', 300))), ROLLING_NOTE_MAX);
check('note not a string', rolling_clean_note(array('x')), '');

// --- Storage, against the dev database ---
$mysql = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4',
	getenv('DB_USER'), getenv('DB_PASSWORD'));
$maskA = '999990011.0';
$maskB = '999990012.0';

function hr_test_sig($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, maskID)
		VALUES ('tst001', :systemID, 'wormhole', '', 86400, 1, 'test', 1, 'test', :mask)");
	$stmt->execute(array(':systemID' => $systemID, ':mask' => $mask));
	return (int)$mysql->lastInsertId();
}
function hr_test_wormhole($mysql, $mask) {
	$a = hr_test_sig($mysql, $mask, 31000001);
	$b = hr_test_sig($mysql, $mask, 31000002);
	$stmt = $mysql->prepare("INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (:a, :b, 'H296', 'initial', 'stable', 'stable', :mask)");
	$stmt->execute(array(':a' => $a, ':b' => $b, ':mask' => $mask));
	return array('id' => (int)$mysql->lastInsertId(), 'a' => $a, 'b' => $b);
}
function hr_test_cleanup($mysql, $masks) {
	foreach ($masks as $mask) {
		$mysql->prepare('DELETE FROM fork_rolling WHERE maskID = ?')->execute(array($mask));
		$mysql->prepare('DELETE FROM wormholes WHERE maskID = ?')->execute(array($mask));
		$mysql->prepare('DELETE FROM signatures WHERE maskID = ?')->execute(array($mask));
	}
}
function hr_ids($flags) { return array_map(function($f) { return $f['wormholeID']; }, $flags); }
function hr_rows($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT wormholeID FROM fork_rolling WHERE maskID = ? ORDER BY wormholeID');
	$stmt->execute(array($mask));
	return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}

try {
	rolling_ensure_table($mysql);
	rolling_ensure_table($mysql);	// idempotent
	hr_test_cleanup($mysql, array($maskA, $maskB));

	$w1 = hr_test_wormhole($mysql, $maskA);
	$w2 = hr_test_wormhole($mysql, $maskA);
	$w3 = hr_test_wormhole($mysql, $maskB);

	check('empty list', rolling_list($mysql, $maskA), array());
	check('get: none', rolling_get($mysql, $maskA, $w1['id']), null);
	rolling_set($mysql, $maskA, $w1['id'], 196379789, 'Chribba', "  closing <it>\n");
	$flags = rolling_list($mysql, $maskA);
	check('set: one flag', count($flags), 1);
	check('set: wormhole', $flags[0]['wormholeID'], $w1['id']);
	check('set: who (name and character id)', array($flags[0]['setBy'], $flags[0]['setByID']), array('Chribba', 196379789));
	check('set: note cleaned', $flags[0]['note'], 'closing <it>');
	check('set: time is unix seconds', abs($flags[0]['setAt'] - time()) < 120, true);
	check('get: the flag', rolling_get($mysql, $maskA, $w1['id']), $flags[0]);
	check('other mask sees nothing', rolling_list($mysql, $maskB), array());

	rolling_set($mysql, $maskA, $w1['id'], '2112625428', 'Kytus Bos', '');
	$flags = rolling_list($mysql, $maskA);
	check('set again: still one', count($flags), 1);
	check('set again: who updated', array($flags[0]['setBy'], $flags[0]['setByID']), array('Kytus Bos', 2112625428));
	check('set again: note updated', $flags[0]['note'], '');

	rolling_set($mysql, $maskA, $w2['id'], null, null, 'x');
	check('two flags', hr_ids(rolling_list($mysql, $maskA)), array($w1['id'], $w2['id']));
	check('null who', array(rolling_list($mysql, $maskA)[1]['setBy'], rolling_list($mysql, $maskA)[1]['setByID']), array(null, null));
	rolling_set($mysql, $maskA, $w2['id'], 'not a number', 'x', 'x');
	check('invalid character id stored as null', rolling_list($mysql, $maskA)[1]['setByID'], null);

	rolling_clear($mysql, $maskA, $w2['id']);
	check('cleared', hr_ids(rolling_list($mysql, $maskA)), array($w1['id']));
	rolling_clear($mysql, $maskA, $w2['id']);	// no error when not flagged
	rolling_clear($mysql, $maskB, $w1['id']);	// another mask can't clear it
	check('other mask clear does nothing', hr_ids(rolling_list($mysql, $maskA)), array($w1['id']));

	// No foreign key to upstream's wormholes (it would block TRUNCATE / ALTER / DROP of that table)
	$keys = (int)$mysql->query("SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
		WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'fork_rolling' AND CONSTRAINT_TYPE = 'FOREIGN KEY'")->fetchColumn();
	check('no foreign key', $keys, 0);

	// A deleted (rolled) wormhole's flag is no longer listed (read-only), and clean deletes it
	rolling_set($mysql, $maskA, $w2['id'], 1, 'x', '');
	$mysql->prepare('DELETE FROM wormholes WHERE id = ?')->execute(array($w2['id']));
	check('wormhole deleted: not listed', hr_ids(rolling_list($mysql, $maskA)), array($w1['id']));
	check('wormhole deleted: get null', rolling_get($mysql, $maskA, $w2['id']), null);
	check('wormhole deleted: row still there until clean', hr_rows($mysql, $maskA), array($w1['id'], $w2['id']));
	check('clean count', rolling_clean($mysql, $maskA), 1);
	check('wormhole deleted: row gone after clean', hr_rows($mysql, $maskA), array($w1['id']));
	$mysql->prepare('DELETE FROM signatures WHERE id = ?')->execute(array($w1['a']));
	check('signature deleted: not listed', rolling_list($mysql, $maskA), array());
	rolling_clean($mysql, $maskA);
	check('signature deleted: row gone after clean', hr_rows($mysql, $maskA), array());

	// A row pointing at a wormhole of another mask is neither listed nor kept
	$mysql->prepare('INSERT INTO fork_rolling (maskID, wormholeID, setBy, note) VALUES (?, ?, ?, ?)')->execute(array($maskA, $w3['id'], 'x', ''));
	check('other mask wormhole: not listed', rolling_list($mysql, $maskA), array());
	check('other mask wormhole: cleaned', rolling_clean($mysql, $maskA), 1);
	rolling_set($mysql, $maskB, $w3['id'], 1, 'x', '');
	rolling_clean($mysql, $maskA);
	check('other mask untouched', hr_ids(rolling_list($mysql, $maskB)), array($w3['id']));
} catch (Throwable $e) {
	$failures++;
	fwrite(STDERR, 'ERROR ' . $e->getMessage() . "\n");
}
hr_test_cleanup($mysql, array($maskA, $maskB));

echo ($failures ? "$failures of $count checks FAILED" : "all $count checks passed") . "\n";
exit($failures ? 1 : 0);
