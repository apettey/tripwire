<?php
// Fork-owned: the server behaviour the undo / redo history (app/js/fork/undo-history.js) relies on, against the dev
// database. Undo and redo go through the normal save (signatures.php), sending saved copies of signatures and holes:
//   - adding a saved copy back (undo of a delete) makes new rows with new ids, keeps the copy's fields and timer, and takes
//     the author from the session, not from the copy; a hole comes back with both sides and its life / mass, and the
//     results are in the order of the request (the history maps old ids to new ones by position);
//   - an update with a saved copy (undo of an edit) records the session's character as the last editor, whatever the
//     copy says: the history's conflict check ("someone else changed it since") compares modifiedByID with the user.
// Runs one request through the handler (it executes when signatures.php is loaded with $_POST set). Own test mask; removes
// everything it created.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/undo_history_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

$ME = 990101;
$BOB = 990102;
$_SESSION = array('mask' => '999990031.0', 'userID' => 1, 'characterID' => $ME, 'characterName' => 'Undo Tester');
$mask = $_SESSION['mask'];

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
function connect() {
	return new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
}
function cleanup($mysql, $mask) {
	foreach (array('wormholes', 'signatures', 'statistics', 'jumps') as $table) {
		$mysql->prepare("DELETE FROM $table WHERE maskID = ?")->execute(array($mask));
	}
	try { $mysql->prepare('DELETE FROM fork_audit_log WHERE maskID = ?')->execute(array($mask)); } catch (Throwable $e) { /* no audit table */ }
}
function row($mysql, $id) {
	$stmt = $mysql->prepare('SELECT * FROM signatures WHERE id = ?');
	$stmt->execute(array($id));
	return $stmt->fetch(PDO::FETCH_ASSOC);
}

$mysql = connect();
cleanup($mysql, $mask);
$A = 31000201; $B = 31000202;
try {
	// A signature Bob added earlier, which I then edited (the undo entry is the copy from before my edit)
	$mysql->prepare('INSERT INTO signatures (signatureID, systemID, type, name, lifeTime, lifeLeft, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, modifiedTime, maskID)
		VALUES (?, ?, "data", "mine now", NOW(), NOW() + INTERVAL 3 DAY, 259200, ?, "Bob", ?, "Undo Tester", NOW(), ?)')
		->execute(array('upd111', $A, $BOB, $ME, $mask));
	$editedId = (int)$mysql->lastInsertId();

	$oldTime = '2026-11-14 10:00:00';
	$_POST = array('signatures' => array(
		'add' => array(
			// undo of a delete: the saved copy of a signature (old id, Bob as author, an old timer)
			array('id' => 999999, 'signatureID' => 'del222', 'systemID' => $A, 'type' => 'relic', 'name' => 'Forgotten Perimeter',
				'lifeTime' => $oldTime, 'lifeLeft' => '2026-11-17 10:00:00', 'lifeLength' => 259200,
				'createdByID' => $BOB, 'createdByName' => 'Bob', 'modifiedByID' => $BOB, 'modifiedByName' => 'Bob'),
			// ... and of a hole (both sides, life and mass as they were)
			array('wormhole' => array('id' => 88888, 'type' => 'H296', 'parent' => 'initial', 'life' => 'critical', 'mass' => 'destab'),
				'signatures' => array(
					array('id' => 777771, 'signatureID' => 'hol333', 'systemID' => $A, 'type' => 'wormhole', 'lifeTime' => $oldTime, 'lifeLength' => 86400,
						'createdByID' => $BOB, 'modifiedByID' => $BOB),
					array('id' => 777772, 'signatureID' => '', 'systemID' => $B, 'type' => 'wormhole', 'lifeTime' => $oldTime, 'lifeLength' => 86400,
						'createdByID' => $BOB, 'modifiedByID' => $BOB)))
		),
		// undo of an edit: the copy from before it, still naming Bob as the last editor
		'update' => array(
			array('id' => $editedId, 'signatureID' => 'upd111', 'systemID' => $A, 'type' => 'data', 'name' => 'as Bob left it',
				'modifiedByID' => $BOB, 'modifiedByName' => 'Bob')
		)
	));
	$output = array();
	require(__DIR__ . '/../signatures.php');

	$results = isset($output['results']) ? $output['results'] : array();
	$sets = isset($output['resultSet']) ? $output['resultSet'] : array();
	check('every part saved', count($sets) === 3 && count(array_filter($sets, function($r) { return $r['result'] == true; })) === 3, true);
	check('results in request order (sig, then hole)', count($results) === 2 && !isset($results[0]['wormhole']) && isset($results[1]['wormhole']), true);

	// The re-added signature: a new row with the copy's fields and timer, authored by the session's character
	$sig = $results[0];
	check('re-added signature has a new id', $sig['id'] > 0 && $sig['id'] !== 999999, true);
	$dbSig = row($mysql, $sig['id']);
	check('re-added signature keeps its ID and type', array($dbSig['signatureID'], $dbSig['type'], $dbSig['name']), array('del222', 'relic', 'Forgotten Perimeter'));
	check('re-added signature keeps its age', $dbSig['lifeTime'], $oldTime);
	check('re-added signature: author from the session, not the copy', array((int)$dbSig['createdByID'], (int)$dbSig['modifiedByID']), array($ME, $ME));

	// The re-added hole: both sides, the first side is the initial one, life and mass kept
	$hole = $results[1];
	check('re-added hole has a new id', $hole['wormhole']['id'] > 0 && (int)$hole['wormhole']['id'] !== 88888, true);
	check('hole sides are the new rows, in request order', array((int)$hole['wormhole']['initialID'], (int)$hole['wormhole']['secondaryID']),
		array((int)$hole['signatures'][0]['id'], (int)$hole['signatures'][1]['id']));
	check('hole sides keep their systems', array((int)$hole['signatures'][0]['systemID'], (int)$hole['signatures'][1]['systemID']), array($A, $B));
	$stmt = $mysql->prepare('SELECT type, parent, life, mass FROM wormholes WHERE id = ?');
	$stmt->execute(array($hole['wormhole']['id']));
	check('hole keeps type, parent, life and mass', $stmt->fetch(PDO::FETCH_ASSOC), array('type' => 'H296', 'parent' => 'initial', 'life' => 'critical', 'mass' => 'destab'));
	check('hole sides: author from the session', (int)row($mysql, $hole['signatures'][1]['id'])['modifiedByID'], $ME);

	// The undone edit: the copy's fields, but I am the last editor (so another user's later change shows as theirs)
	$dbEdited = row($mysql, $editedId);
	check('undone edit restores the field', $dbEdited['name'], 'as Bob left it');
	check('undone edit: last editor is the session character, not the copy', array((int)$dbEdited['modifiedByID'], $dbEdited['modifiedByName']), array($ME, 'Undo Tester'));
	check('undone edit keeps the creator', (int)$dbEdited['createdByID'], $BOB);

	// The audit log records the undo like any other change, under my name
	$stmt = $mysql->prepare('SELECT entity, action, characterID FROM fork_audit_log WHERE maskID = ? ORDER BY id');
	$stmt->execute(array($mask));
	$audit = array_map(function($r) { return $r['entity'] . ' ' . $r['action'] . ' ' . $r['characterID']; }, $stmt->fetchAll(PDO::FETCH_ASSOC));
	check('audit log: the re-adds and the undone edit, by me', array_values(array_intersect($audit, array("signature add $ME", "wormhole add $ME", "signature update $ME"))) === $audit && in_array("signature update $ME", $audit, true) && in_array("wormhole add $ME", $audit, true), true);
} finally {
	cleanup($mysql, $mask);
}

echo "undo_history_test: $count checks, $failures failed\n";
exit($failures ? 1 : 0);
