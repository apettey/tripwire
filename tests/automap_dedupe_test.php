<?php
// Fork-owned: tests for the per-pair automap lock (signatures.php automapLock/automapUnlock, adapted from
// mogglemoss/tripwire 30738532) and for addSignature returning the new row's real id (09bcb40), against the dev
// database. Uses its own test mask and removes everything it created.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/automap_dedupe_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

$_SESSION = array('mask' => '999990021.0', 'userID' => 1, 'characterID' => 1, 'characterName' => 'test');
$mask = $_SESSION['mask'];
require_once(__DIR__ . '/../signatures.php');	// no $_POST on the CLI: only defines the classes and functions

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
	$mysql->prepare('DELETE FROM wormholes WHERE maskID = ?')->execute(array($mask));
	$mysql->prepare('DELETE FROM signatures WHERE maskID = ?')->execute(array($mask));
	$mysql->prepare('DELETE FROM statistics WHERE maskID = ?')->execute(array($mask));
	$mysql->prepare('DELETE FROM jumps WHERE maskID = ?')->execute(array($mask));
	$mysql->prepare('DELETE FROM tracking WHERE maskID = ?')->execute(array($mask));
}

$mysql = connect();
cleanup($mysql, $mask);
try {
	$A = 31000101; $B = 31000102; $C = 31000103;

	// addSignature returns the real id even though the statistics upsert follows the insert
	list($ok, $sig, $msg) = addSignature(array('signatureID' => 'abc123', 'systemID' => $A, 'type' => 'data'), $mysql);
	$stmt = $mysql->prepare('SELECT id FROM signatures WHERE signatureID = ? AND maskID = ?');
	$stmt->execute(array('abc123', $mask));
	$realId = (int)$stmt->fetchColumn();
	check('addSignature ok', $ok, true);
	check('addSignature id is the inserted row id (not 0)', $sig->id, $realId);
	check('addSignature id positive', $realId > 0, true);

	// No connection yet: lock held, nothing existing
	$lock = automapLock(array('systemID' => $A), array('systemID' => $B), $mysql);
	check('lock held', $lock['held'], true);
	check('no existing connection', $lock['existing'], null);

	// A second connection (another pilot's request) cannot take the same pair's lock while it is held
	$other = connect();
	$stmt = $other->prepare('SELECT GET_LOCK(?, 0)');
	$stmt->execute(array($lock['name']));
	check('second request blocked while the first holds the lock', (int)$stmt->fetchColumn(), 0);
	$stmt = $other->prepare('SELECT GET_LOCK(?, 0)');
	$stmt->execute(array(str_replace('.' . $B, '.' . $C, $lock['name'])));
	check('a different pair is not blocked', (int)$stmt->fetchColumn(), 1);
	automapUnlock($lock, $mysql);
	$stmt = $other->prepare('SELECT GET_LOCK(?, 0)');
	$stmt->execute(array($lock['name']));
	check('second request gets the lock once released', (int)$stmt->fetchColumn(), 1);
	$other->prepare('SELECT RELEASE_LOCK(?)')->execute(array($lock['name']));
	$other = null;

	// Same pair, either direction: the lock name is order independent
	$lockReverse = automapLock(array('systemID' => $B), array('systemID' => $A), $mysql);
	check('lock name independent of order', $lockReverse['name'], $lock['name']);
	automapUnlock($lockReverse, $mysql);

	// Add the connection the way the automap request does, then the next request finds it
	list($ok1, $s1, $m1) = addSignature(array('systemID' => $A, 'type' => 'wormhole'), $mysql);
	list($ok2, $s2, $m2) = addSignature(array('systemID' => $B, 'type' => 'wormhole'), $mysql);
	list($okw, $wh, $mw) = addWormhole(array('initialID' => $s1->id, 'secondaryID' => $s2->id, 'type' => null, 'parent' => 'initial', 'life' => 'stable', 'mass' => 'stable'), $mysql);
	check('connection added', $ok1 && $ok2 && $okw, true);
	check('wormhole sig ids are real', $s1->id > 0 && $s2->id > $s1->id, true);

	$lock = automapLock(array('systemID' => $A), array('systemID' => $B), $mysql);
	check('existing connection found (A to B)', $lock['existing'], $wh->id);
	automapUnlock($lock, $mysql);
	$lock = automapLock(array('systemID' => $B), array('systemID' => $A), $mysql);
	check('existing connection found (B to A)', $lock['existing'], $wh->id);
	automapUnlock($lock, $mysql);
	$lock = automapLock(array('systemID' => $A), array('systemID' => $C), $mysql);
	check('other pair has no connection', $lock['existing'], null);
	automapUnlock($lock, $mysql);

	// Other mask: not seen
	$_SESSION['mask'] = '999990022.0';
	$lock = automapLock(array('systemID' => $A), array('systemID' => $B), $mysql);
	check('other mask does not see the connection', $lock['existing'], null);
	automapUnlock($lock, $mysql);
	$_SESSION['mask'] = $mask;

	// Missing system ids: no lock at all
	check('no system ids, no lock', automapLock(array(), array('systemID' => $B), $mysql), null);
	automapUnlock(null, $mysql);

	// Jump direction for the mass log: the client's from/to win over the signature order (re-jump linked to a hole
	// whose initial signature is in the destination), fallback to initial -> secondary
	check('jump ends from the payload', automapJumpEnds(array('character' => 1, 'from' => '31000102', 'to' => '31000101'), $A, $B), array($B, $A));
	check('jump ends spoofed to another system', automapJumpEnds(array('from' => '31000102', 'to' => '30000142'), $A, $B), array($A, $B));
	check('jump ends spoofed pair', automapJumpEnds(array('from' => '1', 'to' => '2'), $A, $B), array($A, $B));
	check('jump ends reject exponent notation', automapJumpEnds(array('from' => '3.1000102e7', 'to' => $A), $A, $B), array($A, $B));
	check('jump ends reject padded/signed/float', automapJumpEnds(array('from' => ' 31000102', 'to' => '+31000101'), $A, $B), array($A, $B));
	check('jump ends reject array values', automapJumpEnds(array('from' => array($B), 'to' => $A), $A, $B), array($A, $B));
	check('jump ends accept int values', automapJumpEnds(array('from' => $B, 'to' => $A), $A, $B), array($B, $A));
	check('jump ends fallback without from/to', automapJumpEnds(array('character' => 1), $A, $B), array($A, $B));
	check('jump ends fallback with junk', automapJumpEnds(array('from' => 'x', 'to' => 5), $A, $B), array($A, $B));
	check('jump ends fallback without payload', automapJumpEnds(null, $A, $B), array($A, $B));

	// Already mapped (another pilot / another of my characters got there first): log this character's jump mass, once
	$jumpRows = function($char) use ($mysql, $mask, $wh) {
		$stmt = $mysql->prepare('SELECT COUNT(*) FROM jumps WHERE maskID = ? AND wormholeID = ? AND characterID = ?');
		$stmt->execute(array($mask, $wh->id, $char));
		return (int)$stmt->fetchColumn();
	};
	$track = $mysql->prepare("INSERT INTO tracking (userID, characterID, characterName, systemID, systemName, shipTypeID, shipTypeName, maskID) VALUES (1, ?, 'Alt|P', ?, 'J', 11182, 'Cheetah', ?)");
	$track->execute(array(990002, $B, $mask));	// its location already reached the server (in the destination)
	$track->execute(array(990003, $A, $mask));	// not yet: the tracking trigger logs it when it arrives
	$automap = array('character' => 990002, 'from' => $A, 'to' => $B);
	check('existing: logs the jump when tracking shows the destination', addAutomapMassExisting($wh->id, array('systemID' => $A), array('systemID' => $B), $automap, $mysql), true);
	check('existing: one jumps row', $jumpRows(990002), 1);
	$stmt = $mysql->prepare('SELECT fromID, toID, shipTypeID FROM jumps WHERE maskID = ? AND characterID = 990002');
	$stmt->execute(array($mask));
	check('existing: row has the jump direction and ship', array_map('intval', $stmt->fetch(PDO::FETCH_NUM)), array($A, $B, 11182));
	check('existing: not twice within 30 s', addAutomapMassExisting($wh->id, array('systemID' => $A), array('systemID' => $B), $automap, $mysql), false);
	check('existing: still one row', $jumpRows(990002), 1);
	check('existing: location not there yet, left to the trigger', addAutomapMassExisting($wh->id, array('systemID' => $A), array('systemID' => $B), array('character' => 990003, 'from' => $A, 'to' => $B), $mysql), false);
	check('existing: no row for it', $jumpRows(990003), 0);
	check('existing: unknown character (no tracking row of this user)', addAutomapMassExisting($wh->id, array('systemID' => $A), array('systemID' => $B), array('character' => 990009, 'from' => $A, 'to' => $B), $mysql), false);
	check('existing: no automap payload', addAutomapMassExisting($wh->id, array('systemID' => $A), array('systemID' => $B), null, $mysql), false);
	check('existing: no wormhole', addAutomapMassExisting(null, array('systemID' => $A), array('systemID' => $B), $automap, $mysql), false);

	// The lock is released after an exception inside try/finally, so a persistent connection does not keep it
	$lock = automapLock(array('systemID' => $A), array('systemID' => $C), $mysql);
	try { try { throw new Exception('boom'); } finally { automapUnlock($lock, $mysql); } } catch (Exception $e) {}
	$other = connect();
	$stmt = $other->prepare('SELECT GET_LOCK(?, 0)');
	$stmt->execute(array($lock['name']));
	check('lock free after exception path', (int)$stmt->fetchColumn(), 1);
	$other = null;
} catch (Throwable $e) {
	$failures++;
	fwrite(STDERR, 'ERROR ' . $e->getMessage() . "\n");
}
cleanup($mysql, $mask);

echo ($failures ? "$failures of $count checks FAILED" : "all $count checks passed") . "\n";
exit($failures ? 1 : 0);
