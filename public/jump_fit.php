<?php
//***********************************************************
//	File: 		jump_fit.php
//	Author: 	Tripwire fork (auto-mass-logging)
//
//	Purpose:	Fitted mass and hot/cold of logged wormhole jumps (see ../jump_fit.inc.php).
//				POST mode=report  characterID, fromID, toID, shipTypeID, fitSource ('assets'|'hull'), hot (0/1)
//				                  and for 'assets': baseMass, propTypeID, propMass (kg), higgsMult, fitTime (unix)
//				                  -> {matched: bool, wormholeID, time}. Only for the user's own ESI characters;
//				                  matched is false until upstream has logged the jump (the client retries).
//				POST mode=hot     wormholeID, characterID, time (as in mass.php), hot (0/1) -> {result: true}
//				                  Any member of the mask may correct a logged jump, like editing signatures.
//				Requests must carry the X-Requested-With: XMLHttpRequest header.
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../jump_fit.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$maskID = $_SESSION['mask'];
$userID = $_SESSION['userID'];
session_write_close();

function jump_fit_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
	jump_fit_fail(405, 'Method not allowed');
}
$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
if (strtolower($requestedWith) !== 'xmlhttprequest') {
	jump_fit_fail(400, 'Missing X-Requested-With header');
}

$output = array();
try {
	$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
	if ($mode === 'report') {
		list($error, $report) = jump_fit_clean_report($_POST);
		if ($error) jump_fit_fail(400, $error);
		if (!jump_fit_owns_character($mysql, $userID, $report['characterID'])) jump_fit_fail(403, 'Not your character');
		$match = jump_fit_report($mysql, $maskID, $report);
		$output['matched'] = $match !== null;
		if ($match) {
			$output['wormholeID'] = $match['wormholeID'];
			$output['time'] = $match['time'];
		}
	} else if ($mode === 'hot') {
		list($error, $hot) = jump_fit_clean_hot($_POST);
		if ($error) jump_fit_fail(400, $error);
		if (!jump_fit_set_hot($mysql, $maskID, $hot)) jump_fit_fail(404, 'No such jump');
		$output['result'] = true;
	} else {
		jump_fit_fail(400, 'Unknown mode');
	}
} catch (Throwable $e) {
	error_log('jump_fit.php: ' . $e->getMessage());
	jump_fit_fail(500, 'Database error');
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);
echo json_encode($output);
