<?php
//***********************************************************
//	File: 		flares.php
//	Author: 	Daimian
//	Created: 	6/1/2013
//	Modified: 	1/22/2014 - Daimian
//
//	Purpose:	Handles creating and removing system flares.
//
//	ToDo:
//
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../csrf.inc.php'); fork_csrf_require(); // fork: flares change only by the app's own POST
require_once('../flares/flares.inc.php'); // fork: reason and lifetime (ported from upstream 2.0)

header('Content-Type: application/json');

$mask = $_SESSION['mask'];

// Fork: an older flares table gets its reason / lifetime columns (and the flaresClean event its per-flare lifetime) here
try {
	flares_ensure_schema($mysql);
} catch (PDOException $error) {
	error_log('[flares] could not add the reason / lifetime columns (see docker/README.md#flares): ' . $error->getMessage());
	http_response_code(500);
	echo json_encode(array('result' => false, 'error' => 'Flares need a database update: ask your Tripwire admin'));
	exit();
}

if (isset($_POST['flare']) && !empty($_POST['flare'])) {
	// systemID, flare (red | yellow | green), lifeLength (86400 | forever; missing = 86400), reason (optional, at most 200 characters)
	[$flare, $error] = flares_parse_set($_POST);
	if ($error !== null) {
		http_response_code(400);
		echo json_encode(array('result' => false, 'error' => $error));
		exit();
	}

	$output['result'] = flares_set($mysql, $mask, $flare);
} else {
	$systemID = flares_system_id($_POST['systemID'] ?? null);
	if ($systemID === false) {
		http_response_code(400);
		echo json_encode(array('result' => false, 'error' => 'Invalid system'));
		exit();
	}

	$output['result'] = flares_remove($mysql, $mask, $systemID);
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);

echo json_encode($output);
?>
