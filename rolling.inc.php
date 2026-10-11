<?php
//***********************************************************
//	File: 		rolling.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	"Rolling" flags on chain map connections (wormholes): "we are rolling this hole", shared by everyone on
//				a mask. Storage for public/rolling.php. One row per flagged wormhole in fork_rolling.
//
//	A sibling of preserve mass (preserve_mass.inc.php, whose request helpers it reuses) and built the same way: no
//	foreign key to upstream's wormholes table (a key from our table would block TRUNCATE / ALTER / DROP of upstream's
//	table and add us to its cascade chain). Flags whose wormhole is gone (rolled, collapsed, deleted, its signature
//	deleted, the wormholeClean event) or now in another mask are never returned (rolling_list joins wormholes), and
//	rolling_clean() deletes them when flags change.
//
//	tests/rolling_test.php exercises all of it against the dev database.
//***********************************************************

require_once(__DIR__ . '/preserve_mass.inc.php');	// preserve_mass_clean_reason, preserve_mass_wormhole_id, preserve_mass_wormhole_in_mask

if (!defined('ROLLING_NOTE_MAX')) define('ROLLING_NOTE_MAX', 100);

/** Create fork_rolling if it doesn't exist (no migration needed). Throws PDOException on failure, whatever the
	connection's error mode (it may be persistent and shared, so it isn't changed). */
function rolling_ensure_table($mysql) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_rolling (
		maskID decimal(12,1) NOT NULL,
		wormholeID int NOT NULL,
		setByID int DEFAULT NULL,
		setBy varchar(100) DEFAULT NULL,
		setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		note varchar(' . ROLLING_NOTE_MAX . ') NOT NULL DEFAULT \'\',
		PRIMARY KEY (maskID, wormholeID)
	) DEFAULT CHARSET=utf8mb4');
	if ($created === false) {
		throw new PDOException('Could not create fork_rolling: ' . implode(' ', $mysql->errorInfo()));
	}
}

/** Note as stored: cleaned like the preserve mass reason (control, zero-width and direction characters removed,
	whitespace collapsed, trimmed, at most 100 characters). Not HTML-escaped: escaped where it is shown. */
function rolling_clean_note($text) {
	return preserve_mass_clean_reason($text);
}

/** Flag the wormhole (or update who/when/note when it already is) */
function rolling_set($mysql, $mask, $wormholeID, $setByID, $setBy, $note) {
	$stmt = $mysql->prepare('INSERT INTO fork_rolling (maskID, wormholeID, setByID, setBy, setAt, note)
		VALUES (:mask, :wormholeID, :setByID, :setBy, CURRENT_TIMESTAMP, :note)
		ON DUPLICATE KEY UPDATE setByID = VALUES(setByID), setBy = VALUES(setBy), setAt = CURRENT_TIMESTAMP, note = VALUES(note)');
	if (!$stmt) throw new PDOException('Could not prepare rolling set');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':wormholeID', $wormholeID, PDO::PARAM_INT);
	$id = is_numeric($setByID) && (int) $setByID > 0 && (int) $setByID <= 2147483647 ? (int) $setByID : null;
	$stmt->bindValue(':setByID', $id, $id === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
	$stmt->bindValue(':setBy', $setBy === null ? null : mb_substr((string)$setBy, 0, 100, 'UTF-8'));
	$stmt->bindValue(':note', rolling_clean_note($note));
	if (!$stmt->execute()) throw new PDOException('Could not set rolling: ' . implode(' ', $stmt->errorInfo()));
}

/** One wormhole's flag as rolling_list returns it, or null (not flagged, or its wormhole is gone) */
function rolling_get($mysql, $mask, $wormholeID) {
	foreach (rolling_list($mysql, $mask) as $flag) {
		if ($flag['wormholeID'] === (int)$wormholeID) return $flag;
	}
	return null;
}

/** Remove the flag (no error when there is none) */
function rolling_clear($mysql, $mask, $wormholeID) {
	$stmt = $mysql->prepare('DELETE FROM fork_rolling WHERE maskID = :mask AND wormholeID = :wormholeID');
	if (!$stmt) throw new PDOException('Could not prepare rolling clear');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':wormholeID', $wormholeID, PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not clear rolling: ' . implode(' ', $stmt->errorInfo()));
}

/** Remove the mask's flags whose wormhole no longer exists in the mask. Returns the number removed. */
function rolling_clean($mysql, $mask) {
	$stmt = $mysql->prepare('DELETE r FROM fork_rolling r
		LEFT JOIN wormholes w ON w.id = r.wormholeID AND w.maskID = r.maskID
		WHERE r.maskID = :mask AND w.id IS NULL');
	if (!$stmt) throw new PDOException('Could not prepare rolling clean');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not clean rolling: ' . implode(' ', $stmt->errorInfo()));
	return $stmt->rowCount();
}

/** The mask's flags whose wormhole still exists in the mask: list of array(wormholeID, setByID, setBy, setAt (unix
	seconds), note), oldest first. Read-only: orphans are skipped here and deleted by rolling_clean. */
function rolling_list($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT r.wormholeID, r.setByID, r.setBy, UNIX_TIMESTAMP(r.setAt) AS setAt, r.note FROM fork_rolling r
		INNER JOIN wormholes w ON w.id = r.wormholeID AND w.maskID = r.maskID
		WHERE r.maskID = :mask ORDER BY r.setAt, r.wormholeID');
	if (!$stmt) throw new PDOException('Could not read fork_rolling');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not read fork_rolling: ' . implode(' ', $stmt->errorInfo()));
	$flags = array();
	while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
		$flags[] = array(
			'wormholeID' => (int)$row['wormholeID'],
			'setByID' => $row['setByID'] === null ? null : (int)$row['setByID'],
			'setBy' => $row['setBy'],
			'setAt' => (int)$row['setAt'],
			'note' => (string)$row['note']
		);
	}
	return $flags;
}
