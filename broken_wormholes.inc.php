<?php
//***********************************************************
//	File: 		broken_wormholes.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	"Broken" wormholes of the paste preview (app/js/fork/paste-preview.js, broken-holes.js): a hole that was
//				missing from a probe scanner paste is marked broken instead of deleted. It stays on the chain map (red
//				and dashed), routes leave it out, and anyone on the mask can restore it. One row per broken hole in
//				fork_broken_wormholes (maskID, wormholeID, markedBy, markedAt), created on first use (no migration).
//
//	Why a table of our own: upstream's wormholes table stays as it is (no new column to conflict with upstream syncs),
//	and a hole's row there keeps its life / mass / type as they were, so a restore is just deleting our row.
//	A row has no foreign key to upstream's wormholes (that would block TRUNCATE / ALTER of upstream's table and pull
//	us into its cascades, as preserve_mass.inc.php explains). Rows of holes that are gone (expired, deleted, now in
//	another mask) are never returned (the list joins wormholes) and are deleted whenever the mask's marks change.
//	So a broken hole lasts exactly as long as the hole itself: when its life runs out it goes like any expired hole.
//
//	Transport: no endpoint of its own. public/refresh.php calls broken_wormholes_refresh() on every request: it applies
//	a "brokenHoles" {mark: [wormholeID], restore: [wormholeID]} part of the POST (only with this session's CSRF token,
//	so the paste's adds / deletes and its marks are one request) and always answers the mask's list, so everyone on the
//	mask sees a change with their next refresh. Marks and restores go to the audit log (fork); never to Discord.
//
//	tests/broken_wormholes_test.php exercises all of it against the dev database.
//***********************************************************

require_once(__DIR__ . '/audit/audit.inc.php');

if (!defined('BROKEN_WORMHOLES_MAX')) define('BROKEN_WORMHOLES_MAX', 200);	// ids per request and per list

/** Create fork_broken_wormholes if it doesn't exist. Throws PDOException on failure. */
function broken_wormholes_ensure_table($mysql) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_broken_wormholes (
		maskID decimal(12,1) NOT NULL,
		wormholeID int NOT NULL,
		markedBy varchar(100) DEFAULT NULL,
		markedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (maskID, wormholeID)
	) DEFAULT CHARSET=utf8mb4');
	if ($created === false) {
		throw new PDOException('Could not create fork_broken_wormholes: ' . implode(' ', $mysql->errorInfo()));
	}
}

/** Valid wormhole id from a request value (positive int), or false */
function broken_wormholes_id($value) {
	if (is_int($value)) return $value > 0 && $value <= 2147483647 ? $value : false;
	if (!is_string($value) || !preg_match('/^[1-9][0-9]{0,9}$/', $value)) return false;
	$id = filter_var($value, FILTER_VALIDATE_INT);
	return $id === false || $id > 2147483647 ? false : $id;
}

/** The ids of a request list (array of ids): valid, unique, at most BROKEN_WORMHOLES_MAX. Anything else: [] */
function broken_wormholes_ids($list) {
	if (!is_array($list)) return array();
	$out = array();
	foreach ($list as $value) {
		$id = broken_wormholes_id($value);
		if ($id !== false && !in_array($id, $out, true)) $out[] = $id;
		if (count($out) >= BROKEN_WORMHOLES_MAX) break;
	}
	return $out;
}

/** True when the table is missing (nothing was ever marked): reads then answer an empty list */
function broken_wormholes_missing_table($e) {
	return $e instanceof PDOException && ($e->getCode() === '42S02' || strpos($e->getMessage(), '42S02') !== false);
}

/** The mask's broken holes whose wormhole still exists in the mask: [{wormholeID, markedBy, markedAt (unix s)}] */
function broken_wormholes_list($mysql, $mask) {
	try {
		$stmt = $mysql->prepare('SELECT b.wormholeID, b.markedBy, UNIX_TIMESTAMP(b.markedAt) AS markedAt FROM fork_broken_wormholes b
			JOIN wormholes w ON w.id = b.wormholeID AND w.maskID = b.maskID WHERE b.maskID = :mask ORDER BY b.wormholeID LIMIT ' . (int) BROKEN_WORMHOLES_MAX);
		if (!$stmt) throw new PDOException('Could not read fork_broken_wormholes');
		$stmt->bindValue(':mask', $mask);
		if (!$stmt->execute()) {
			$info = $stmt->errorInfo();
			throw new PDOException('Could not read fork_broken_wormholes: ' . implode(' ', $info), 0);
		}
	} catch (PDOException $e) {
		if (broken_wormholes_missing_table($e)) return array();
		throw $e;
	}
	$out = array();
	foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
		$out[] = array('wormholeID' => (int) $row['wormholeID'], 'markedBy' => $row['markedBy'], 'markedAt' => (int) $row['markedAt']);
	}
	return $out;
}

/** The wormhole of the mask with its two ends (for the audit log), or null when it isn't in the mask */
function broken_wormholes_hole($mysql, $mask, $wormholeID) {
	$stmt = $mysql->prepare('SELECT w.id, w.type, a.systemID AS fromSystem, b.systemID AS toSystem, a.signatureID AS fromSig, b.signatureID AS toSig
		FROM wormholes w LEFT JOIN signatures a ON a.id = w.initialID LEFT JOIN signatures b ON b.id = w.secondaryID WHERE w.id = :id AND w.maskID = :mask');
	if (!$stmt) throw new PDOException('Could not read wormholes');
	$stmt->bindValue(':id', $wormholeID, PDO::PARAM_INT);
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) throw new PDOException('Could not read wormholes: ' . implode(' ', $stmt->errorInfo()));
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	return $row ?: null;
}

/** One audit log entry: a hole's broken flag changed ($on: marked or restored) */
function broken_wormholes_audit($mysql, $mask, $who, $hole, $on) {
	if (!function_exists('audit_record') || !$hole || !$who) return;
	audit_record($mysql, (string) $mask, $who, 'wormhole', 'update', (int) $hole['fromSystem'], (int) $hole['toSystem'], (string) $hole['type'], array(
		'from' => strtoupper((string) $hole['fromSig']), 'to' => strtoupper((string) $hole['toSig']),
		'changes' => array('broken' => $on ? array('', 'yes') : array('yes', ''))));
}

/** Mark the mask's holes broken. Ids of holes not in the mask are skipped. Returns the ids now marked by this call. */
function broken_wormholes_mark($mysql, $mask, array $ids, $markedBy, $who = null) {
	if (!$ids) return array();
	broken_wormholes_ensure_table($mysql);
	$insert = $mysql->prepare('INSERT IGNORE INTO fork_broken_wormholes (maskID, wormholeID, markedBy, markedAt) VALUES (:mask, :id, :by, CURRENT_TIMESTAMP)');
	if (!$insert) throw new PDOException('Could not prepare broken mark');
	$done = array();
	foreach ($ids as $id) {
		$hole = broken_wormholes_hole($mysql, $mask, $id);
		if (!$hole) continue;
		$insert->bindValue(':mask', $mask);
		$insert->bindValue(':id', $id, PDO::PARAM_INT);
		$insert->bindValue(':by', $markedBy === null ? null : mb_substr((string) $markedBy, 0, 100, 'UTF-8'));
		if (!$insert->execute()) throw new PDOException('Could not mark broken: ' . implode(' ', $insert->errorInfo()));
		if ($insert->rowCount() > 0) {
			$done[] = $id;
			broken_wormholes_audit($mysql, $mask, $who, $hole, true);
		}
	}
	return $done;
}

/** Restore the mask's broken holes. Returns the ids restored by this call. */
function broken_wormholes_restore($mysql, $mask, array $ids, $who = null) {
	if (!$ids) return array();
	$delete = $mysql->prepare('DELETE FROM fork_broken_wormholes WHERE maskID = :mask AND wormholeID = :id');
	$done = array();
	try {
		if (!$delete) throw new PDOException('Could not prepare broken restore');
		foreach ($ids as $id) {
			$hole = broken_wormholes_hole($mysql, $mask, $id);
			$delete->bindValue(':mask', $mask);
			$delete->bindValue(':id', $id, PDO::PARAM_INT);
			if (!$delete->execute()) throw new PDOException('Could not restore: ' . implode(' ', $delete->errorInfo()));
			if ($delete->rowCount() > 0) {
				$done[] = $id;
				broken_wormholes_audit($mysql, $mask, $who, $hole, false);
			}
		}
	} catch (PDOException $e) {
		if (broken_wormholes_missing_table($e)) return array();
		throw $e;
	}
	return $done;
}

/** Delete the mask's rows whose wormhole is gone (or now in another mask) */
function broken_wormholes_clean($mysql, $mask) {
	try {
		$stmt = $mysql->prepare('DELETE b FROM fork_broken_wormholes b LEFT JOIN wormholes w ON w.id = b.wormholeID AND w.maskID = b.maskID
			WHERE b.maskID = :mask AND w.id IS NULL');
		if (!$stmt) throw new PDOException('Could not prepare broken clean');
		$stmt->bindValue(':mask', $mask);
		if (!$stmt->execute()) throw new PDOException('Could not clean: ' . implode(' ', $stmt->errorInfo()));
		return $stmt->rowCount();
	} catch (PDOException $e) {
		if (broken_wormholes_missing_table($e)) return 0;
		throw $e;
	}
}

/**
 * The refresh.php part. $request: the POST's "brokenHoles" value ({mark: [ids], restore: [ids]}) or null; $csrfOk:
 * fork_csrf_valid() (changes need it); $who: the session's character ['id', 'name'] for the audit log.
 * Adds to $output: brokenHoles (the mask's list, always) and, when the request asked for changes, brokenHolesResult
 * {result: bool, marked: [ids], restored: [ids], error?}. Never throws: a database error answers result false.
 */
function broken_wormholes_refresh($mysql, $mask, $request, $csrfOk, $who, &$output) {
	if (!is_array($output)) $output = array();
	try {
		if (is_array($request) && (isset($request['mark']) || isset($request['restore']))) {
			if (!$csrfOk) {
				$output['brokenHolesResult'] = array('result' => false, 'marked' => array(), 'restored' => array(), 'error' => 'Invalid CSRF token: reload the page');
			} else {
				$mark = broken_wormholes_ids(isset($request['mark']) ? $request['mark'] : null);
				$restore = broken_wormholes_ids(isset($request['restore']) ? $request['restore'] : null);
				$restored = broken_wormholes_restore($mysql, $mask, $restore, $who);
				$marked = broken_wormholes_mark($mysql, $mask, $mark, $who ? $who['name'] : null, $who);
				broken_wormholes_clean($mysql, $mask);
				$output['brokenHolesResult'] = array('result' => true, 'marked' => $marked, 'restored' => $restored);
			}
		}
		$output['brokenHoles'] = broken_wormholes_list($mysql, $mask);
	} catch (Throwable $e) {
		error_log('broken_wormholes: ' . $e->getMessage());
		if (isset($output['brokenHolesResult']) || (is_array($request) && (isset($request['mark']) || isset($request['restore'])))) {
			$output['brokenHolesResult'] = array('result' => false, 'marked' => array(), 'restored' => array(), 'error' => 'Database error');
		}
	}
}
