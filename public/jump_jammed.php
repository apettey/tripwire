<?php
//***********************************************************
//	File: 		jump_jammed.php
//	Author: 	Tripwire fork
//
//	Purpose:	Cyno-jammed systems marked by hand for the current mask (Jump planner, jumprange/jammed.inc.php).
//				GET                            -> {jammed: [{systemID, setBy, age}]}
//				POST mode=set&systemID=<id>    -> mark a k-space system as cyno-jammed
//				POST mode=clear&systemID=<id>  -> remove the mark
//				Same access rules as rally.php: a logged-in session with a mask, and changes must be POSTed with
//				the X-Requested-With: XMLHttpRequest header (a cross-site form can't set it).
//
//	The fork_jump_jammed table is created on first use, so existing databases need no migration.
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../jumprange/jammed.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$mask = $_SESSION['mask'];
$output = array();

function jump_jammed_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

try {
	jump_jammed_ensure_table($mysql);

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') {
			jump_jammed_fail(400, 'Missing X-Requested-With header');
		}
		$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
		if ($mode !== 'set' && $mode !== 'clear') {
			jump_jammed_fail(400, 'Unknown mode');
		}
		$systemID = jump_jammed_system_id(isset($_POST['systemID']) ? $_POST['systemID'] : '');
		if ($systemID === false) {
			jump_jammed_fail(400, 'Invalid systemID');
		}
		if ($mode === 'set') {
			$marked = array_map(function ($j) { return $j['systemID']; }, jump_jammed_list($mysql, $mask));
			if (!in_array($systemID, $marked, true) && count($marked) >= JUMP_JAMMED_MAX_PER_MASK) {
				jump_jammed_fail(409, 'Too many systems marked as jammed');
			}
			$setBy = isset($_SESSION['characterName']) ? $_SESSION['characterName'] : (isset($_SESSION['username']) ? $_SESSION['username'] : null);
			jump_jammed_set($mysql, $mask, $systemID, $setBy);
		} else {
			jump_jammed_clear($mysql, $mask, $systemID);
		}
		$output['result'] = true;
	} else if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
		jump_jammed_fail(405, 'Method not allowed');
	}

	$output['jammed'] = jump_jammed_list($mysql, $mask);
} catch (PDOException $e) {
	error_log('jump_jammed.php: ' . $e->getMessage());
	jump_jammed_fail(500, 'Database error');
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);
echo json_encode($output);
