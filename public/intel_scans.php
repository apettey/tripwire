<?php
//***********************************************************
//	File: 		intel_scans.php
//	Author: 	Tripwire fork
//
//	Purpose:	D-scan and local scans shared with the current mask, pinned to a system (intel/intel.inc.php).
//				GET  [systemID=<id>]                        -> latest: age of the newest scan of each kind per system
//				                                               (for the chain map markers); scans: the system's scans
//				POST mode=add&systemID=<id>&text=<paste>     -> validate, normalise and store a scan
//				POST mode=delete&id=<id>                     -> delete one of your own scans
//				Changes must be POSTed with the X-Requested-With: XMLHttpRequest header (like rally.php).
//
//	The fork_intel_scans table is created on first use, so existing databases need no migration. Scans are kept
//	for INTEL_RETENTION_H hours; the browser decides how long a scan counts as fresh.
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../intel/intel.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$mask = $_SESSION['mask'];
$userID = (int) $_SESSION['userID'];
$output = array();

function intel_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

function intel_system_param($value) {
	$systemID = filter_var($value, FILTER_VALIDATE_INT);
	if ($systemID === false || $systemID < 30000000 || $systemID >= 33000000) {
		intel_fail(400, 'Invalid systemID');
	}
	return $systemID;
}

$systemID = null;
try {
	intel_schema($mysql);

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') {
			intel_fail(400, 'Missing X-Requested-With header');
		}
		$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
		if ($mode === 'add') {
			$systemID = intel_system_param(isset($_POST['systemID']) ? $_POST['systemID'] : '');
			[$kind, $data] = intel_parse(isset($_POST['text']) ? $_POST['text'] : '');
			if ($kind === null) intel_fail(400, $data);
			if (intel_recent_count($mysql, $userID) >= INTEL_RATE_PER_MIN) {
				intel_fail(429, 'Too many scans shared in the last minute, try again shortly');
			}
			$createdBy = isset($_SESSION['characterName']) ? $_SESSION['characterName'] : (isset($_SESSION['username']) ? $_SESSION['username'] : null);
			$output['added'] = intel_insert($mysql, $mask, $systemID, $kind, $data, $createdBy, $userID);
			intel_prune($mysql, $mask, $systemID);
		} else if ($mode === 'delete') {
			$id = isset($_POST['id']) ? filter_var($_POST['id'], FILTER_VALIDATE_INT) : false;
			if ($id === false || $id <= 0) intel_fail(400, 'Invalid id');
			$output['deleted'] = intel_delete($mysql, $mask, $id, $userID);
			if (isset($_POST['systemID'])) $systemID = intel_system_param($_POST['systemID']);
		} else {
			intel_fail(400, 'Unknown mode');
		}
	} else if ($_SERVER['REQUEST_METHOD'] === 'GET') {
		if (isset($_GET['systemID']) && $_GET['systemID'] !== '') $systemID = intel_system_param($_GET['systemID']);
	} else {
		intel_fail(405, 'Method not allowed');
	}

	$output['latest'] = (object) intel_latest($mysql, $mask);
	if ($systemID !== null) {
		$output['systemID'] = $systemID;
		$output['scans'] = intel_list($mysql, $mask, $systemID, $userID);
	}
	$output['retentionSeconds'] = INTEL_RETENTION_H * 3600;
} catch (PDOException $e) {
	error_log('intel_scans.php: ' . $e->getMessage());
	intel_fail(500, 'Database error');
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);
echo json_encode($output);
