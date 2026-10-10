<?php
//***********************************************************
//	File: 		preserve_mass.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	"Preserve mass" flags on chain map connections (wormholes), shared by everyone on a mask.
//				Storage for public/preserve_mass.php. One row per flagged wormhole in fork_preserve_mass.
//
//	A flag belongs to a row of upstream's wormholes table: the foreign key (ON DELETE CASCADE) removes it when
//	the wormhole is deleted (by hand, a collapsed hole, a deleted signature, or the wormholeClean event).
//	preserve_mass_clean() removes flags whose wormhole is gone or now belongs to another mask too, for databases
//	where the key could not be created.
//
//	preserve_mass_clean_reason() is pure; tests/preserve_mass_test.php exercises all of it against the dev database.
//***********************************************************

if (!defined('PRESERVE_MASS_REASON_MAX')) define('PRESERVE_MASS_REASON_MAX', 100);

/** Create fork_preserve_mass if it doesn't exist (no migration needed). Tries with the foreign key to wormholes
	first; if that can't be created (e.g. no REFERENCES privilege), without it. Throws PDOException on failure.
	Doesn't change the connection's error mode (it may be persistent and shared): results are checked instead. */
function preserve_mass_ensure_table($mysql) {
	$columns = 'maskID decimal(12,1) NOT NULL,
		wormholeID int NOT NULL,
		setBy varchar(100) DEFAULT NULL,
		setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		reason varchar(' . PRESERVE_MASS_REASON_MAX . ') NOT NULL DEFAULT \'\',
		PRIMARY KEY (maskID, wormholeID),
		KEY wormholeID (wormholeID)';
	$withKey = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_preserve_mass (' . $columns . ',
		CONSTRAINT fork_preserve_mass_wormhole_fk FOREIGN KEY (wormholeID) REFERENCES wormholes (id) ON DELETE CASCADE
	) DEFAULT CHARSET=utf8mb4');
	if ($withKey !== false) return;
	$plain = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_preserve_mass (' . $columns . ') DEFAULT CHARSET=utf8mb4');
	if ($plain === false) {
		throw new PDOException('Could not create fork_preserve_mass: ' . implode(' ', $mysql->errorInfo()));
	}
}

/** Reason text as stored: control characters and runs of whitespace become one space, trimmed, at most
	PRESERVE_MASS_REASON_MAX characters. Not HTML-escaped: it is stored as text and escaped where it is shown. */
function preserve_mass_clean_reason($text) {
	if (!is_string($text)) return '';
	if (!mb_check_encoding($text, 'UTF-8')) $text = mb_convert_encoding($text, 'UTF-8', 'UTF-8');
	$text = preg_replace('/\p{Cf}+/u', '', $text);	// zero-width and direction marks
	if ($text === null) return '';
	$text = preg_replace('/[\p{Cc}\p{Z}\s]+/u', ' ', $text);
	if ($text === null) return '';
	return mb_substr(trim($text), 0, PRESERVE_MASS_REASON_MAX, 'UTF-8');
}

/** Valid wormhole id from a request value (positive int), or false */
function preserve_mass_wormhole_id($value) {
	if (is_int($value)) return $value > 0 ? $value : false;
	if (!is_string($value) || !preg_match('/^[1-9][0-9]{0,9}$/', $value)) return false;
	$id = filter_var($value, FILTER_VALIDATE_INT);
	return $id === false || $id > 2147483647 ? false : $id;
}

/** Whether the wormhole exists in the mask */
function preserve_mass_wormhole_in_mask($mysql, $mask, $wormholeID) {
	$stmt = $mysql->prepare('SELECT 1 FROM wormholes WHERE id = :id AND maskID = :mask');
	if (!$stmt) throw new PDOException('Could not read wormholes');
	$stmt->bindValue(':id', $wormholeID, PDO::PARAM_INT);
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not read wormholes: ' . implode(' ', $stmt->errorInfo()));
	return $stmt->fetchColumn() !== false;
}

/** Flag the wormhole (or update who/when/reason when it already is) */
function preserve_mass_set($mysql, $mask, $wormholeID, $setBy, $reason) {
	$stmt = $mysql->prepare('INSERT INTO fork_preserve_mass (maskID, wormholeID, setBy, setAt, reason)
		VALUES (:mask, :wormholeID, :setBy, CURRENT_TIMESTAMP, :reason)
		ON DUPLICATE KEY UPDATE setBy = VALUES(setBy), setAt = CURRENT_TIMESTAMP, reason = VALUES(reason)');
	if (!$stmt) throw new PDOException('Could not prepare preserve mass set');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':wormholeID', $wormholeID, PDO::PARAM_INT);
	$stmt->bindValue(':setBy', $setBy === null ? null : mb_substr((string)$setBy, 0, 100, 'UTF-8'));
	$stmt->bindValue(':reason', preserve_mass_clean_reason($reason));
	if (!$stmt->execute()) throw new PDOException('Could not set preserve mass: ' . implode(' ', $stmt->errorInfo()));
}

/** Remove the flag (no error when there is none) */
function preserve_mass_clear($mysql, $mask, $wormholeID) {
	$stmt = $mysql->prepare('DELETE FROM fork_preserve_mass WHERE maskID = :mask AND wormholeID = :wormholeID');
	if (!$stmt) throw new PDOException('Could not prepare preserve mass clear');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':wormholeID', $wormholeID, PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not clear preserve mass: ' . implode(' ', $stmt->errorInfo()));
}

/** Remove the mask's flags whose wormhole no longer exists in the mask. Returns the number removed. */
function preserve_mass_clean($mysql, $mask) {
	$stmt = $mysql->prepare('DELETE p FROM fork_preserve_mass p
		LEFT JOIN wormholes w ON w.id = p.wormholeID AND w.maskID = p.maskID
		WHERE p.maskID = :mask AND w.id IS NULL');
	if (!$stmt) throw new PDOException('Could not prepare preserve mass clean');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not clean preserve mass: ' . implode(' ', $stmt->errorInfo()));
	return $stmt->rowCount();
}

/** The mask's flags: list of array(wormholeID, setBy, setAt (unix seconds), reason), oldest first */
function preserve_mass_list($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT wormholeID, setBy, UNIX_TIMESTAMP(setAt) AS setAt, reason FROM fork_preserve_mass
		WHERE maskID = :mask ORDER BY setAt, wormholeID');
	if (!$stmt) throw new PDOException('Could not read fork_preserve_mass');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not read fork_preserve_mass: ' . implode(' ', $stmt->errorInfo()));
	$flags = array();
	while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
		$flags[] = array(
			'wormholeID' => (int)$row['wormholeID'],
			'setBy' => $row['setBy'],
			'setAt' => (int)$row['setAt'],
			'reason' => (string)$row['reason']
		);
	}
	return $flags;
}
