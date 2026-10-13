<?php
//***********************************************************
//	File: 		map_targets.php
//	Author: 	Tripwire fork
//
//	Purpose:	Region map targets of the current mask (map_targets.inc.php): systems any member marked, in order, for
//				the whole mask to see and to send as in-game waypoints.
//				GET                                                    -> {targets: [{systemID, note, ord, createdBy: {id, name},
//				                                                          created, expires}], now, max} (expired ones purged)
//				POST mode=add&systemID=<id>[&note=<text>][&hours=1|3|6|24 | &until=<unix s>]
//				                                                       -> add (at the end) or change note / expiry
//				POST mode=remove&systemID=<id>                         -> remove one
//				POST mode=clear                                        -> remove all
//				POST mode=reorder&order=<id,id,...>                    -> these first, in this order
//				Same access rules as rally.php / jump_jammed.php: a logged-in session with a mask (canonical, checked by
//				the mask guard in db.inc.php), and changes must be POSTed with the X-Requested-With: XMLHttpRequest header
//				(a cross-site form can't set it). At most MAP_TARGETS_MAX_PER_MASK (25) targets per mask; add, remove and
//				clear go to the audit log (Mask Admin > Audit).
//
//	The fork_map_targets table is created on first use, so existing databases need no migration.
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');	// also runs the mask guard: $_SESSION['mask'] is a mask this character may use
require_once('../map_targets.inc.php');
require_once('../audit/audit.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

function map_targets_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

$mask = is_string($_SESSION['mask']) && function_exists('tripwire_mask_canonical') ? tripwire_mask_canonical($_SESSION['mask']) : null;
if ($mask === null && is_string($_SESSION['mask']) && preg_match('/^[0-9]{1,10}\.[0-3]$/D', $_SESSION['mask'])) $mask = $_SESSION['mask'];
if ($mask === null) map_targets_fail(403, 'No mask');

$now = time();
$output = array();
$who = array(
	'id' => isset($_SESSION['characterID']) ? (int)$_SESSION['characterID'] : 0,
	'name' => isset($_SESSION['characterName']) ? (string)$_SESSION['characterName'] : (isset($_SESSION['username']) ? (string)$_SESSION['username'] : '')
);

try {
	map_targets_ensure_table($mysql);
	map_targets_purge($mysql, $mask, $now);

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') {
			map_targets_fail(400, 'Missing X-Requested-With header');
		}
		$mode = isset($_POST['mode']) && is_string($_POST['mode']) ? $_POST['mode'] : '';
		$audit = function ($action, $systemID, $subject, $detail) use ($mysql, $mask, $who) {
			if (function_exists('audit_record')) audit_record($mysql, $mask, $who, 'target', $action, $systemID, 0, $subject, $detail);
		};

		if ($mode === 'add') {
			$systemID = map_targets_system_id(isset($_POST['systemID']) ? $_POST['systemID'] : '');
			if ($systemID === false) map_targets_fail(400, 'Invalid systemID (k-space systems only)');
			$note = map_targets_note(isset($_POST['note']) ? $_POST['note'] : '');
			if ($note === false) map_targets_fail(400, 'Invalid note');
			$hours = isset($_POST['hours']) ? $_POST['hours'] : null;
			$until = isset($_POST['until']) ? $_POST['until'] : null;
			// Neither given: an existing target keeps its expiry (the card's "keep" choice), a new one gets the default
			$keep = ($hours === null || $hours === '') && ($until === null || $until === '');
			$expires = $keep ? null : map_targets_expiry($hours, $until, $now);
			if ($expires === false) map_targets_fail(400, 'Invalid expiry');
			$action = map_targets_add($mysql, $mask, $systemID, $note, $expires, $who, $now);
			if ($action === 'full') map_targets_fail(409, 'At most ' . MAP_TARGETS_MAX_PER_MASK . ' targets per mask');
			$row = map_targets_get($mysql, $mask, $systemID);
			$at = $row ? (int)$row['expires'] : 0;
			// "HH:MM" EVE time when it is within a day, with the date ("10-15 18:20") when further away
			$audit($action, $systemID, $note, $at ? array('expires' => gmdate($at - $now > 86400 ? 'm-d H:i' : 'H:i', $at)) : array());
		} else if ($mode === 'remove') {
			$systemID = map_targets_system_id(isset($_POST['systemID']) ? $_POST['systemID'] : '');
			if ($systemID === false) map_targets_fail(400, 'Invalid systemID');
			if (map_targets_remove($mysql, $mask, $systemID)) $audit('delete', $systemID, '', array());
		} else if ($mode === 'clear') {
			$n = map_targets_clear($mysql, $mask);
			if ($n > 0) $audit('clear', 0, '', array('count' => $n));
		} else if ($mode === 'reorder') {
			$order = map_targets_order(isset($_POST['order']) ? $_POST['order'] : null);
			if ($order === false) map_targets_fail(400, 'Invalid order');
			map_targets_reorder($mysql, $mask, $order, $now);
		} else {
			map_targets_fail(400, 'Unknown mode');
		}
		$output['result'] = true;
	} else if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
		map_targets_fail(405, 'Method not allowed');
	}

	$output['targets'] = map_targets_list($mysql, $mask, $now);
} catch (PDOException $e) {
	error_log('map_targets.php: ' . $e->getMessage());
	map_targets_fail(500, 'Database error');
}

$output['now'] = $now;
$output['max'] = MAP_TARGETS_MAX_PER_MASK;
$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);
echo json_encode($output);
