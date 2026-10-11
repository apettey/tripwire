<?php
//***********************************************************
//	File: 		system_status.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	System status colour, occupier and alias, shared by everyone on a mask. Storage and validation for
//				public/system_status.php. One row per mask and solar system in fork_system_status (created on first
//				use, so no migration is needed; reference DDL in docker/sql/system-status.sql).
//
//	It belongs to the SYSTEM, not to a signature or hole: it survives deleting the system from the chain and adding it
//	again, and there is no link to upstream's tables. A row with no status, alias and occupier is deleted.
//	Pure functions and storage are tested by tests/system_status_test.php (storage against the dev database).
//***********************************************************

if (!defined('SYSTEM_STATUS_ALIAS_MAX')) define('SYSTEM_STATUS_ALIAS_MAX', 24);
if (!defined('SYSTEM_STATUS_OCCUPIER_MAX')) define('SYSTEM_STATUS_OCCUPIER_MAX', 60);
// Per mask: bounds the poll answer. When full, the oldest row of a system that is not on the mask's current chain
// (no signature of the mask in it) is dropped to make room; when every row is on the chain, the new one is refused.
if (!defined('SYSTEM_STATUS_MAX_ROWS')) define('SYSTEM_STATUS_MAX_ROWS', 2000);

/** Version of a list as system_status_list returns it: changes whenever anything a viewer sees changes */
function system_status_hash(array $rows) {
	return md5(json_encode($rows));
}

/** Drop the mask's oldest row (by setAt) of a system with no signature of the mask in it. True when one was dropped. */
function system_status_evict($mysql, $mask) {
	$stmt = $mysql->prepare('DELETE FROM fork_system_status WHERE maskID = :mask
		AND NOT EXISTS (SELECT 1 FROM signatures s WHERE s.maskID = :mask2 AND s.systemID = fork_system_status.systemID)
		ORDER BY setAt, systemID LIMIT 1');
	if (!$stmt) throw new PDOException('Could not prepare system status evict');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':mask2', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not evict system status: ' . implode(' ', $stmt->errorInfo()));
	return $stmt->rowCount() > 0;
}

function system_status_values() {
	return array('friendly', 'hostile', 'active', 'empty', 'unscanned');
}

/** Create fork_system_status if it doesn't exist. Throws PDOException on failure, whatever the error mode. */
function system_status_ensure_table($mysql) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_system_status (
		maskID decimal(12,1) NOT NULL,
		systemID int NOT NULL,
		status varchar(12) DEFAULT NULL,
		alias varchar(' . SYSTEM_STATUS_ALIAS_MAX . ') NOT NULL DEFAULT \'\',
		occupier varchar(' . SYSTEM_STATUS_OCCUPIER_MAX . ') NOT NULL DEFAULT \'\',
		setBy varchar(100) DEFAULT NULL,
		setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (maskID, systemID)
	) DEFAULT CHARSET=utf8mb4');
	if ($created === false) {
		throw new PDOException('Could not create fork_system_status: ' . implode(' ', $mysql->errorInfo()));
	}
}

/** Valid solar system ID (k-space 30xxxxxx, wormholes 31xxxxxx) from a request value, or false */
function system_status_system_id($value) {
	if (is_int($value)) $value = (string)$value;
	if (!is_string($value) || !preg_match('/^3[01][0-9]{6}$/', $value)) return false;
	return (int)$value;
}

/** A status from a request value: one of system_status_values(), null for '' / null (clear), false when invalid */
function system_status_clean_status($value) {
	if ($value === null || $value === '') return null;
	if (!is_string($value)) return false;
	return in_array($value, system_status_values(), true) ? $value : false;
}

/** One line of plain text: zero-width / direction marks dropped, control characters and whitespace runs become one
	space, trimmed, at most $max characters. Not HTML-escaped: it is stored as text and escaped where it is shown. */
function system_status_clean_text($text, $max) {
	if (!is_string($text)) return '';
	if (!mb_check_encoding($text, 'UTF-8')) $text = mb_convert_encoding($text, 'UTF-8', 'UTF-8');
	$text = preg_replace('/\p{Cf}+/u', '', $text);
	if ($text === null) return '';
	$text = preg_replace('/[\p{Cc}\p{Z}\s]+/u', ' ', $text);
	if ($text === null) return '';
	return mb_substr(trim($text), 0, $max, 'UTF-8');
}

function system_status_row($row) {
	return array(
		'systemID' => (int)$row['systemID'],
		'status' => $row['status'] === null ? null : (string)$row['status'],
		'alias' => (string)$row['alias'],
		'occupier' => (string)$row['occupier'],
		'setBy' => $row['setBy'],
		'setAt' => (int)$row['setAt']
	);
}

/** The mask's row for one system, or null */
function system_status_get($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare('SELECT systemID, status, alias, occupier, setBy, UNIX_TIMESTAMP(setAt) AS setAt
		FROM fork_system_status WHERE maskID = :mask AND systemID = :systemID');
	if (!$stmt) throw new PDOException('Could not read fork_system_status');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not read fork_system_status: ' . implode(' ', $stmt->errorInfo()));
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	return $row ? system_status_row($row) : null;
}

/** Change a system's fields. $changes: any of 'status' (valid value or null), 'alias', 'occupier' (raw text); fields
	not in $changes keep their value. The row is deleted when nothing is left. Returns the row, null (nothing left)
	or false (the mask already marks SYSTEM_STATUS_MAX_ROWS systems). */
function system_status_update($mysql, $mask, $systemID, array $changes, $setBy) {
	$current = system_status_get($mysql, $mask, $systemID);
	$row = $current ? $current : array('systemID' => $systemID, 'status' => null, 'alias' => '', 'occupier' => '');
	if (array_key_exists('status', $changes)) $row['status'] = $changes['status'];
	if (array_key_exists('alias', $changes)) $row['alias'] = system_status_clean_text($changes['alias'], SYSTEM_STATUS_ALIAS_MAX);
	if (array_key_exists('occupier', $changes)) $row['occupier'] = system_status_clean_text($changes['occupier'], SYSTEM_STATUS_OCCUPIER_MAX);

	if ($row['status'] === null && $row['alias'] === '' && $row['occupier'] === '') {
		system_status_clear($mysql, $mask, $systemID);
		return null;
	}
	if (!$current) {
		$count = $mysql->prepare('SELECT COUNT(*) FROM fork_system_status WHERE maskID = :mask');
		if (!$count) throw new PDOException('Could not count fork_system_status');
		$count->bindValue(':mask', $mask);
		if (!$count->execute()) throw new PDOException('Could not count fork_system_status');
		if ((int)$count->fetchColumn() >= SYSTEM_STATUS_MAX_ROWS && !system_status_evict($mysql, $mask)) return false;
	}
	$stmt = $mysql->prepare('INSERT INTO fork_system_status (maskID, systemID, status, alias, occupier, setBy, setAt)
		VALUES (:mask, :systemID, :status, :alias, :occupier, :setBy, CURRENT_TIMESTAMP)
		ON DUPLICATE KEY UPDATE status = VALUES(status), alias = VALUES(alias), occupier = VALUES(occupier),
			setBy = VALUES(setBy), setAt = CURRENT_TIMESTAMP');
	if (!$stmt) throw new PDOException('Could not prepare system status set');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	$stmt->bindValue(':status', $row['status']);
	$stmt->bindValue(':alias', $row['alias']);
	$stmt->bindValue(':occupier', $row['occupier']);
	$stmt->bindValue(':setBy', $setBy === null ? null : mb_substr((string)$setBy, 0, 100, 'UTF-8'));
	if (!$stmt->execute()) throw new PDOException('Could not set system status: ' . implode(' ', $stmt->errorInfo()));
	return system_status_get($mysql, $mask, $systemID);
}

/** Remove everything set for the system (no error when there is nothing) */
function system_status_clear($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare('DELETE FROM fork_system_status WHERE maskID = :mask AND systemID = :systemID');
	if (!$stmt) throw new PDOException('Could not prepare system status clear');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not clear system status: ' . implode(' ', $stmt->errorInfo()));
}

/** All rows of the mask (only that mask), by system ID */
function system_status_list($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT systemID, status, alias, occupier, setBy, UNIX_TIMESTAMP(setAt) AS setAt
		FROM fork_system_status WHERE maskID = :mask ORDER BY systemID LIMIT ' . (int)SYSTEM_STATUS_MAX_ROWS);
	if (!$stmt) throw new PDOException('Could not read fork_system_status');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not read fork_system_status: ' . implode(' ', $stmt->errorInfo()));
	$rows = array();
	while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) $rows[] = system_status_row($row);
	return $rows;
}
