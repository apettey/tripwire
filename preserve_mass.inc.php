<?php
//***********************************************************
//	File: 		preserve_mass.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	"Preserve mass" flags on chain map connections (wormholes), shared by everyone on a mask.
//				Storage for public/preserve_mass.php. One row per flagged wormhole in fork_preserve_mass.
//
//	A flag belongs to a row of upstream's wormholes table but has no foreign key to it (a key from our table would
//	block TRUNCATE / ALTER / DROP of upstream's table and add us to its cascade chain). Instead, flags whose wormhole
//	is gone (deleted, collapsed, its signature deleted, the wormholeClean event) or now in another mask are never
//	returned (preserve_mass_list joins wormholes), and preserve_mass_clean() deletes them when flags change.
//
//	preserve_mass_clean_reason() is pure; tests/preserve_mass_test.php exercises all of it against the dev database.
//***********************************************************

if (!defined('PRESERVE_MASS_REASON_MAX')) define('PRESERVE_MASS_REASON_MAX', 100);

/** Create fork_preserve_mass if it doesn't exist (no migration needed). Throws PDOException on failure, whatever
	the connection's error mode (it may be persistent and shared, so it isn't changed). */
function preserve_mass_ensure_table($mysql) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_preserve_mass (
		maskID decimal(12,1) NOT NULL,
		wormholeID int NOT NULL,
		setBy varchar(100) DEFAULT NULL,
		setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		reason varchar(' . PRESERVE_MASS_REASON_MAX . ') NOT NULL DEFAULT \'\',
		PRIMARY KEY (maskID, wormholeID)
	) DEFAULT CHARSET=utf8mb4');
	if ($created === false) {
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

/** One wormhole's flag as preserve_mass_list returns it, or null (not flagged, or its wormhole is gone) */
function preserve_mass_get($mysql, $mask, $wormholeID) {
	foreach (preserve_mass_list($mysql, $mask) as $flag) {
		if ($flag['wormholeID'] === (int)$wormholeID) return $flag;
	}
	return null;
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

/** The mask's flags whose wormhole still exists in the mask: list of array(wormholeID, setBy, setAt (unix seconds),
	reason), oldest first. Read-only: orphans are skipped here and deleted by preserve_mass_clean. */
function preserve_mass_list($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT p.wormholeID, p.setBy, UNIX_TIMESTAMP(p.setAt) AS setAt, p.reason FROM fork_preserve_mass p
		INNER JOIN wormholes w ON w.id = p.wormholeID AND w.maskID = p.maskID
		WHERE p.maskID = :mask ORDER BY p.setAt, p.wormholeID');
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
