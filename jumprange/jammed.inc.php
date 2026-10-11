<?php
//***********************************************************
//	File: 		jumprange/jammed.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	Cyno-jammed systems marked by hand, shared by everyone on a mask (Jump planner). Storage for
//				public/jump_jammed.php. One row per marked system in fork_jump_jammed; who marked it and when are
//				kept so the planner can show the mark's age (ESI has no public cyno jammer feed).
//
//	Reference DDL: docker/sql/jump-jammed.sql (keep in sync). The table is created on first use, so existing
//	databases need no migration. Tests: jumprange/tests/jammed_endpoint_test.php (against the dev database).
//***********************************************************

if (!defined('JUMP_JAMMED_MAX_PER_MASK')) define('JUMP_JAMMED_MAX_PER_MASK', 500);
if (!defined('JUMP_JAMMED_SYSTEMS_FILE')) define('JUMP_JAMMED_SYSTEMS_FILE', __DIR__ . '/../public/jumprange/systems.json');

/** Create fork_jump_jammed if it doesn't exist. Throws PDOException on failure, whatever the connection's error mode
	(it may be persistent and shared, so it isn't changed). */
function jump_jammed_ensure_table($mysql) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_jump_jammed (
		maskID decimal(12,1) NOT NULL,
		systemID int NOT NULL,
		setBy varchar(100) DEFAULT NULL,
		setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (maskID, systemID)
	) DEFAULT CHARSET=utf8mb4');
	if ($created === false) {
		throw new PDOException('Could not create fork_jump_jammed: ' . implode(' ', $mysql->errorInfo()));
	}
}

/** The k-space system IDs the planner knows (public/jumprange/systems.json, delta-encoded): {systemID: true} */
function jump_jammed_known_systems() {
	static $known = null;
	if ($known !== null) return $known;
	$known = array();
	$raw = @file_get_contents(JUMP_JAMMED_SYSTEMS_FILE);
	$data = $raw === false ? null : json_decode($raw, true);
	if (!is_array($data) || !isset($data['ids']) || !is_array($data['ids'])) return $known;
	$id = 0;
	foreach ($data['ids'] as $delta) {
		$id += (int)$delta;
		$known[$id] = true;
	}
	return $known;
}

/** Valid system ID from a request value: a plain decimal integer of a k-space system in systems.json, or false */
function jump_jammed_system_id($value) {
	if (is_int($value)) $value = (string)$value;
	if (!is_string($value) || !preg_match('/^3[0-9]{7}$/', $value)) return false;
	$id = (int)$value;
	if ($id < 30000000 || ($id >= 31000000 && $id !== 30100000)) return false;
	$known = jump_jammed_known_systems();
	return isset($known[$id]) ? $id : false;
}

/** Marked systems of a mask: [{systemID, setBy, age (seconds)}], oldest mark first */
function jump_jammed_list($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT systemID, setBy, GREATEST(0, TIMESTAMPDIFF(SECOND, setAt, CURRENT_TIMESTAMP)) AS age
		FROM fork_jump_jammed WHERE maskID = :mask ORDER BY setAt, systemID');
	if (!$stmt) throw new PDOException('Could not read fork_jump_jammed');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not read fork_jump_jammed: ' . implode(' ', $stmt->errorInfo()));
	$out = array();
	while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
		$out[] = array('systemID' => (int)$row['systemID'], 'setBy' => $row['setBy'], 'age' => (int)$row['age']);
	}
	return $out;
}

function jump_jammed_count($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT COUNT(*) FROM fork_jump_jammed WHERE maskID = :mask');
	if (!$stmt) throw new PDOException('Could not count fork_jump_jammed');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not count fork_jump_jammed: ' . implode(' ', $stmt->errorInfo()));
	return (int)$stmt->fetchColumn();
}

/** Mark a system (or update who/when when it already is) */
function jump_jammed_set($mysql, $mask, $systemID, $setBy) {
	$stmt = $mysql->prepare('INSERT INTO fork_jump_jammed (maskID, systemID, setBy, setAt) VALUES (:mask, :systemID, :setBy, CURRENT_TIMESTAMP)
		ON DUPLICATE KEY UPDATE setBy = VALUES(setBy), setAt = CURRENT_TIMESTAMP');
	if (!$stmt) throw new PDOException('Could not prepare jammed set');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	$stmt->bindValue(':setBy', $setBy === null ? null : mb_substr((string)$setBy, 0, 100, 'UTF-8'));
	if (!$stmt->execute()) throw new PDOException('Could not mark jammed: ' . implode(' ', $stmt->errorInfo()));
}

/** Remove a mark (no error when there is none) */
function jump_jammed_clear($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare('DELETE FROM fork_jump_jammed WHERE maskID = :mask AND systemID = :systemID');
	if (!$stmt) throw new PDOException('Could not prepare jammed clear');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not unmark jammed: ' . implode(' ', $stmt->errorInfo()));
}
