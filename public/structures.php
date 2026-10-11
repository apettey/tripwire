<?php
//***********************************************************
//	File: 		structures.php
//	Author: 	Tripwire fork
//
//	Purpose:	Structures (Upwell, POS, deployables) of a system, shared with the current mask (structures/structures.inc.php).
//				GET  action=list&systemID=<id>[&have=<hash>]  -> the system's live and recently gone structures; with a
//				                                                matching have=<hash> only {unchanged: true, serverTime}
//				POST action=scan&systemID=<id>&text=<d-scan>[&keep=[0,2]][&systemName=J123456]
//				                                              -> save the structures of a d-scan (keep = indexes of the
//				                                                 structure rows to save, default all)
//				POST action=add&systemID=<id>&typeName=<name>[&typeID=][&name=][&owner=][&state=][&timerKind=&timerAt=][&note=]
//				POST action=update&id=<id>[&owner= | &ownerID=&ownerType=][&state=][&timerKind=&timerAt=][&note=][&seenNow=1]
//				POST action=gone&id=<id>&state=destroyed|removed|restore
//				GET  action=markers&systemIDs=<id,id,...>[&have=<hash>]
//				                                              -> per system on the map {count, hostile, types, owners, lastSeen, nextTimer}
//				                                                 and the mask's next 20 timers (chain map markers, in-app alerts)
//				GET  action=timers                            -> every active timer of the mask (the Structures panel's Timers view)
//				Every write needs X-Requested-With: XMLHttpRequest (like intel_scans.php) and returns the system's list. Anyone with access to the mask may write. Every query filters on the session's mask.
//				Never calls ESI or zKillboard (owners come from the cache of the pilot lookups).
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../structures/structures.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$mask = $_SESSION['mask'];
$userID = (int) $_SESSION['userID'];
$by = isset($_SESSION['characterName']) ? $_SESSION['characterName'] : (isset($_SESSION['username']) ? $_SESSION['username'] : null);
$output = array();

function structures_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

function structures_system_param($value) {
	$systemID = filter_var($value, FILTER_VALIDATE_INT);
	if ($systemID === false || $systemID < 30000000 || $systemID >= 33000000) structures_fail(400, 'Invalid systemID');
	return $systemID;
}

function structures_id_param($value) {
	$id = filter_var($value, FILTER_VALIDATE_INT);
	if ($id === false || $id <= 0) structures_fail(400, 'Invalid id');
	return $id;
}

try {
	structures_schema($mysql);
	$friendly = intel_friendly_ids($_SESSION, $mask);
	$now = time();

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		if (strtolower(isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '') !== 'xmlhttprequest') {
			structures_fail(400, 'Missing X-Requested-With header');
		}
		$action = isset($_POST['action']) ? $_POST['action'] : '';
		if (!in_array($action, array('scan', 'add', 'update', 'gone'), true)) structures_fail(400, 'Unknown action');
		$systemID = null;

		if ($action === 'scan' || $action === 'add') {
			$systemID = structures_system_param(isset($_POST['systemID']) ? $_POST['systemID'] : '');
		} else {
			$existing = structures_get($mysql, $mask, structures_id_param(isset($_POST['id']) ? $_POST['id'] : ''), $friendly);
			if (!$existing) structures_fail(404, 'Not found');	// also for rows of other masks
			$systemID = $existing['systemID'];
		}
		if (!structures_rate_ok($mysql, $userID)) structures_fail(429, 'Too many changes in the last minute, try again shortly');
		// The owner cache (fork_pilot_entities) may not exist yet on a fresh database: only owner changes need it
		if (isset($_POST['owner']) || isset($_POST['ownerID'])) intel_pilots_schema($mysql);
		structures_prune($mysql);	// on writes only; list hides what a prune would delete

		if ($action === 'scan') {
			$text = isset($_POST['text']) ? $_POST['text'] : '';
			if (!is_string($text) || strlen($text) > INTEL_MAX_BYTES) structures_fail(400, 'Invalid scan');
			$parsed = structures_parse_scan($text, isset($_POST['systemName']) && is_string($_POST['systemName']) ? $_POST['systemName'] : null);
			$rows = $parsed['structures'];
			$keep = null;
			if (isset($_POST['keep'])) {
				$keep = is_string($_POST['keep']) ? json_decode($_POST['keep'], true) : $_POST['keep'];
				if (!is_array($keep)) structures_fail(400, 'Invalid keep');
				$keep = array_flip(array_map('intval', $keep));
			}
			$save = array();
			$wrong = 0;
			foreach ($rows as $i => $r) {
				if ($r[7]) { $wrong++; continue; }	// named for another system
				if ($keep !== null && !isset($keep[$i])) continue;
				$save[] = $r;
			}
			$output['result'] = structures_apply_scan($mysql, $mask, $systemID, $save, $parsed['modules'], $by);
			$output['result']['wrongSystem'] = $wrong;
			$output['result']['notRecognised'] = $parsed['notRecognised'];
		} else if ($action === 'add') {
			$typeName = intel_clean_field(isset($_POST['typeName']) ? $_POST['typeName'] : '');
			$typeID = null;
			$kind = 'upwell';
			if ($typeName === '') structures_fail(400, 'A type is required');
			if (strcasecmp($typeName, 'Unknown structure') !== 0) {
				$info = structures_type_info(isset($_POST['typeID']) && $_POST['typeID'] !== '' ? (int) $_POST['typeID'] : null, $typeName);
				if (!$info) structures_fail(400, 'Not a structure type');
				[$typeID, $typeName, $kind, $tower] = $info;
				if ($kind === 'starbase' && !$tower) structures_fail(400, 'POS modules are not stored: add the Control Tower');
			} else {
				$typeName = 'Unknown structure';
			}
			if (structures_live_count($mysql, $mask, $systemID) >= STRUCTURES_LIVE_MAX) structures_fail(400, 'Too many structures in this system');
			[$changes, $error, $choices] = structures_changes($mysql, $_POST, $now);
			if ($error !== null) structures_fail(400, $error);
			if ($choices !== null) {
				$output['ownerChoices'] = $choices;
			} else {
				$id = structures_insert($mysql, $mask, $systemID, $typeID, $typeName, $kind, $changes, $by);
				structures_update($mysql, $mask, $id, array_diff_key($changes, array('name' => 1, 'state' => 1, 'note' => 1)), $by);
				$output['added'] = $id;
			}
		} else if ($action === 'update') {
			[$changes, $error, $choices] = structures_changes($mysql, $_POST, $now, $existing);
			if ($error !== null) structures_fail(400, $error);
			if ($choices !== null) {
				$output['ownerChoices'] = $choices;
			} else {
				// An ended timer (more than 2 hours ago) is cleared by the next edit
				if ($existing['timerAt'] !== null && $existing['timerAt'] < $now - STRUCTURES_TIMER_PAST && !array_key_exists('timerAt', $changes)) {
					$changes += array('timerKind' => null, 'timerAt' => null);
				}
				$seen = isset($_POST['seenNow']) && $_POST['seenNow'] === '1';
				if (!structures_update($mysql, $mask, $existing['id'], $changes, $by, $seen)) structures_fail(404, 'Not found');
			}
		} else {
			$state = isset($_POST['state']) ? $_POST['state'] : '';
			if (!in_array($state, array('destroyed', 'removed', 'restore'), true)) structures_fail(400, 'Invalid state');
			if (!structures_set_gone($mysql, $mask, $existing['id'], $state, $by)) structures_fail(404, 'Not found');
		}
	} else if ($_SERVER['REQUEST_METHOD'] === 'GET') {
		$action = isset($_GET['action']) ? $_GET['action'] : '';
		if ($action === 'markers' || $action === 'timers') {
			$output['serverTime'] = $now;
			if ($action === 'timers') {
				$output['timers'] = structures_timers($mysql, $mask, $friendly, $now);
			} else {
				$raw = isset($_GET['systemIDs']) ? $_GET['systemIDs'] : '';
				$ids = is_array($raw) ? $raw : explode(',', is_string($raw) ? $raw : '');
				if (count($ids) > STRUCTURES_MARKERS_MAX) structures_fail(400, 'Too many systems');
				$systemIDs = array();
				foreach ($ids as $id) {
					if (trim((string) $id) !== '') $systemIDs[] = structures_system_param(trim((string) $id));
				}
				$output['systems'] = (object) structures_markers($mysql, $mask, $systemIDs, $friendly, $now);
				$output['next'] = structures_timers($mysql, $mask, $friendly, $now, STRUCTURES_NEXT);
			}
			$hash = md5(json_encode(array($output['systems'] ?? null, $output['next'] ?? null, $output['timers'] ?? null)));
			$have = isset($_GET['have']) ? $_GET['have'] : '';
			if ($have !== '' && is_string($have) && hash_equals($hash, $have)) {
				$output = array('unchanged' => true, 'serverTime' => $now);
			} else {
				$output['hash'] = $hash;
			}
			$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);
			echo json_encode($output);
			exit();
		}
		if ($action !== 'list') structures_fail(400, 'Unknown action');
		$systemID = structures_system_param(isset($_GET['systemID']) ? $_GET['systemID'] : '');
	} else {
		structures_fail(405, 'Method not allowed');
	}

	$list = structures_list($mysql, $mask, $systemID, $friendly);
	$output['systemID'] = $systemID;
	$output['serverTime'] = time();
	$have = $_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['have']) ? $_GET['have'] : '';
	if ($have !== '' && is_string($have) && hash_equals($list['hash'], $have)) {
		$output['unchanged'] = true;
	} else {
		$output += $list;
	}
} catch (PDOException $e) {
	error_log('structures.php: ' . $e->getMessage());
	structures_fail(500, 'Database error');
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);
echo json_encode($output);
