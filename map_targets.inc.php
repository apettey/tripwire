<?php
//***********************************************************
//	File: 		map_targets.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	Region map targets: k-space systems marked by any member of a mask, shared by everyone on it, with an
//				optional short note, an order (for multi-stop waypoints) and an expiry. Storage for public/map_targets.php.
//				One row per target in fork_map_targets. Times are unix seconds (no time zone questions).
//
//	Reference DDL: docker/sql/map-targets.sql (keep in sync). The table is created on first use, so existing databases
//	need no migration. Tests: tests/map_targets_endpoint_test.php (against the dev database).
//***********************************************************

require_once(__DIR__ . '/jumprange/jammed.inc.php');	// jump_jammed_known_systems(): the k-space systems

if (!defined('MAP_TARGETS_MAX_PER_MASK')) define('MAP_TARGETS_MAX_PER_MASK', 25);
if (!defined('MAP_TARGETS_NOTE_MAX')) define('MAP_TARGETS_NOTE_MAX', 60);
if (!defined('MAP_TARGETS_HOURS')) define('MAP_TARGETS_HOURS', '1,3,6,24');	// expiry choices
if (!defined('MAP_TARGETS_MAX_SECONDS')) define('MAP_TARGETS_MAX_SECONDS', 7 * 86400);	// "until" (a skyhook window's end) at most this far ahead

/** Create fork_map_targets if it doesn't exist. Throws PDOException on failure (the connection's error mode is left alone). */
function map_targets_ensure_table($mysql) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_map_targets (
		maskID decimal(12,1) NOT NULL,
		systemID int NOT NULL,
		note varchar(60) NOT NULL DEFAULT \'\',
		ord int NOT NULL DEFAULT 0,
		createdByID bigint NOT NULL DEFAULT 0,
		createdByName varchar(100) NOT NULL DEFAULT \'\',
		created int unsigned NOT NULL,
		expires int unsigned NOT NULL,
		PRIMARY KEY (maskID, systemID),
		KEY expires (expires)
	) DEFAULT CHARSET=utf8mb4');
	if ($created === false) {
		throw new PDOException('Could not create fork_map_targets: ' . implode(' ', $mysql->errorInfo()));
	}
}

function map_targets_exec($stmt, $what) {
	if (!$stmt) throw new PDOException('Could not prepare ' . $what);
	if (!$stmt->execute()) throw new PDOException('Could not ' . $what . ': ' . implode(' ', $stmt->errorInfo()));
	return $stmt;
}

/** A k-space system ID from a request value (plain decimal integer of a system in public/jumprange/systems.json), or false */
function map_targets_system_id($value) {
	return jump_jammed_system_id($value);
}

/** The note as stored: plain text, control characters as spaces, trimmed, at most 60 characters; false when not a string */
function map_targets_note($value) {
	if ($value === null) return '';
	if (!is_string($value)) return false;
	if (!mb_check_encoding($value, 'UTF-8')) return false;
	$clean = trim(preg_replace('/[\x00-\x1F\x7F\s]+/u', ' ', $value) ?? '');
	return mb_substr($clean, 0, MAP_TARGETS_NOTE_MAX, 'UTF-8');
}

/** When a target expires: `hours` (one of MAP_TARGETS_HOURS) or `until` (unix seconds, in the future, at most 7 days ahead).
	@return unix seconds, or false when neither is valid */
function map_targets_expiry($hours, $until, $now) {
	if ($until !== null && $until !== '') {
		if (!is_string($until) && !is_int($until)) return false;
		if (!preg_match('/^[0-9]{9,11}$/', (string)$until)) return false;
		$t = (int)$until;
		return $t > $now && $t <= $now + MAP_TARGETS_MAX_SECONDS ? $t : false;
	}
	if ($hours === null || $hours === '') $hours = '6';
	if (!is_string($hours) && !is_int($hours)) return false;
	$allowed = explode(',', MAP_TARGETS_HOURS);
	return in_array((string)$hours, $allowed, true) ? $now + 3600 * (int)$hours : false;
}

/** Delete the mask's expired targets; returns how many */
function map_targets_purge($mysql, $mask, $now) {
	$stmt = $mysql->prepare('DELETE FROM fork_map_targets WHERE maskID = :mask AND expires <= :now');
	if ($stmt) { $stmt->bindValue(':mask', $mask); $stmt->bindValue(':now', $now, PDO::PARAM_INT); }
	return map_targets_exec($stmt, 'purge fork_map_targets')->rowCount();
}

/** The mask's targets in order: [{systemID, note, ord, createdBy: {id, name}, created, expires}] (expired ones left out) */
function map_targets_list($mysql, $mask, $now) {
	$stmt = $mysql->prepare('SELECT systemID, note, ord, createdByID, createdByName, created, expires FROM fork_map_targets
		WHERE maskID = :mask AND expires > :now ORDER BY ord, created, systemID');
	if ($stmt) { $stmt->bindValue(':mask', $mask); $stmt->bindValue(':now', $now, PDO::PARAM_INT); }
	map_targets_exec($stmt, 'read fork_map_targets');
	$out = array();
	while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
		$out[] = array(
			'systemID' => (int)$row['systemID'], 'note' => $row['note'], 'ord' => (int)$row['ord'],
			'createdBy' => array('id' => (int)$row['createdByID'], 'name' => $row['createdByName']),
			'created' => (int)$row['created'], 'expires' => (int)$row['expires']
		);
	}
	return $out;
}

/** The mask's target row for a system (array) or null */
function map_targets_get($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare('SELECT systemID, note, ord, expires FROM fork_map_targets WHERE maskID = :mask AND systemID = :systemID');
	if ($stmt) { $stmt->bindValue(':mask', $mask); $stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT); }
	$row = map_targets_exec($stmt, 'read fork_map_targets')->fetch(PDO::FETCH_ASSOC);
	return $row ?: null;
}

function map_targets_count($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT COUNT(*) FROM fork_map_targets WHERE maskID = :mask');
	if ($stmt) $stmt->bindValue(':mask', $mask);
	return (int)map_targets_exec($stmt, 'count fork_map_targets')->fetchColumn();
}

/** Add a target at the end of the list, or (already a target) change its note, and its expiry unless $expires is null
	(null for a new target: the default 6 h). One transaction that locks the mask's rows first (SELECT ... FOR UPDATE, which
	also locks the gap where a new row of the mask would go), so two members adding at the same time can neither pass the
	cap together nor collide on the primary key; the write itself is INSERT ... ON DUPLICATE KEY UPDATE.
	@return 'add', 'update' or 'full' (a new target and the mask has $max already) */
function map_targets_add($mysql, $mask, $systemID, $note, $expires, $who, $now, $max = MAP_TARGETS_MAX_PER_MASK) {
	$own = !$mysql->inTransaction();
	if ($own && !$mysql->beginTransaction()) throw new PDOException('Could not start a transaction');
	try {
		$stmt = $mysql->prepare('SELECT systemID, ord, expires FROM fork_map_targets WHERE maskID = :mask FOR UPDATE');
		if ($stmt) $stmt->bindValue(':mask', $mask);
		$rows = map_targets_exec($stmt, 'lock fork_map_targets')->fetchAll(PDO::FETCH_ASSOC);
		$exists = false;
		$live = 0;
		$maxOrd = -1;
		foreach ($rows as $row) {
			if ((int)$row['expires'] <= $now) continue;	// expired: purged below, doesn't count
			$live++;
			$maxOrd = max($maxOrd, (int)$row['ord']);
			if ((int)$row['systemID'] === (int)$systemID) $exists = true;
		}
		if (!$exists && $live >= $max) {
			if ($own) $mysql->rollBack();
			return 'full';
		}
		$purge = $mysql->prepare('DELETE FROM fork_map_targets WHERE maskID = :mask AND expires <= :now');
		if ($purge) { $purge->bindValue(':mask', $mask); $purge->bindValue(':now', $now, PDO::PARAM_INT); }
		map_targets_exec($purge, 'purge fork_map_targets');

		$stmt = $mysql->prepare('INSERT INTO fork_map_targets (maskID, systemID, note, ord, createdByID, createdByName, created, expires)
			VALUES (:mask, :systemID, :note, :ord, :byID, :byName, :created, :expires)
			ON DUPLICATE KEY UPDATE note = :note2, expires = COALESCE(:keep, expires)');
		if ($stmt) {
			$stmt->bindValue(':mask', $mask);
			$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
			$stmt->bindValue(':note', $note);
			$stmt->bindValue(':note2', $note);
			$stmt->bindValue(':ord', $maxOrd + 1, PDO::PARAM_INT);
			$stmt->bindValue(':byID', (int)$who['id'], PDO::PARAM_INT);
			$stmt->bindValue(':byName', mb_substr((string)$who['name'], 0, 100, 'UTF-8'));
			$stmt->bindValue(':created', $now, PDO::PARAM_INT);
			$stmt->bindValue(':expires', $expires === null ? $now + 6 * 3600 : $expires, PDO::PARAM_INT);
			$stmt->bindValue(':keep', $expires, $expires === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
		}
		map_targets_exec($stmt, 'add to fork_map_targets');
		if ($own) $mysql->commit();
		return $exists ? 'update' : 'add';
	} catch (Throwable $e) {
		if ($own && $mysql->inTransaction()) $mysql->rollBack();
		throw $e;
	}
}

/** Remove one target; returns whether there was one */
function map_targets_remove($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare('DELETE FROM fork_map_targets WHERE maskID = :mask AND systemID = :systemID');
	if ($stmt) { $stmt->bindValue(':mask', $mask); $stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT); }
	return map_targets_exec($stmt, 'remove from fork_map_targets')->rowCount() > 0;
}

/** Remove every target of the mask; returns how many */
function map_targets_clear($mysql, $mask) {
	$stmt = $mysql->prepare('DELETE FROM fork_map_targets WHERE maskID = :mask');
	if ($stmt) $stmt->bindValue(':mask', $mask);
	return map_targets_exec($stmt, 'clear fork_map_targets')->rowCount();
}

/** The system IDs of a reorder request ("30000001,30000002"), or false: plain integers, no repeats, at most 25 */
function map_targets_order($value) {
	if (!is_string($value) || strlen($value) > 400) return false;
	if ($value === '') return array();
	$out = array();
	foreach (explode(',', $value) as $part) {
		if (!preg_match('/^[0-9]{8}$/', $part)) return false;
		$id = (int)$part;
		if (in_array($id, $out, true)) return false;
		$out[] = $id;
	}
	return count($out) <= MAP_TARGETS_MAX_PER_MASK ? $out : false;
}

/** Put the listed targets first, in that order; the mask's other targets keep their order after them */
function map_targets_reorder($mysql, $mask, array $ids, $now) {
	$current = array_map(function ($t) { return $t['systemID']; }, map_targets_list($mysql, $mask, $now));
	$order = array_values(array_intersect($ids, $current));
	foreach ($current as $id) if (!in_array($id, $order, true)) $order[] = $id;
	$stmt = $mysql->prepare('UPDATE fork_map_targets SET ord = :ord WHERE maskID = :mask AND systemID = :systemID');
	if (!$stmt) throw new PDOException('Could not prepare reorder');
	foreach ($order as $i => $id) {
		$stmt->bindValue(':ord', $i, PDO::PARAM_INT);
		$stmt->bindValue(':mask', $mask);
		$stmt->bindValue(':systemID', $id, PDO::PARAM_INT);
		if (!$stmt->execute()) throw new PDOException('Could not reorder: ' . implode(' ', $stmt->errorInfo()));
	}
	return $order;
}
