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
require_once('../db.php');
require_once('../csrf.inc.php'); fork_csrf_require(); // fork: flares change only by the app's own POST

header('Content-Type: application/json');

$mask = $_SESSION['mask'];

if (isset($_REQUEST['flare']) && !empty($_REQUEST['flare'])) {
	$systemID = $_REQUEST['systemID'];
	$flare = $_REQUEST['flare'];
	if(!in_array($flare, [ 'red', 'yellow', 'green' ])) {
		http_response_code(400);
		die('Invalid flare type');
	}
	$lifeLength = isset($_REQUEST['lifeLength']) ? intval($_REQUEST['lifeLength']) : null;

	$query = 'INSERT INTO flares (maskID, systemID, flare, lifeLength, reason) VALUES (:mask, :systemID, :flare, :lifeLength, :reason) ON DUPLICATE KEY UPDATE flare = :flare, lifeLength = :lifeLength, reason = :reason';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID);
	$stmt->bindValue(':flare', $flare);
	$stmt->bindValue(':lifeLength', $lifeLength);
	$stmt->bindValue(':reason', $_REQUEST['reason'] ?? null);

	$output['result'] = $stmt->execute()?true:$stmt->errorInfo();
} else {
	$systemID = $_REQUEST['systemID'];

	$query = "DELETE FROM flares WHERE maskID = :mask AND systemID = :systemID";
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID);

	$output['result'] = $stmt->execute()?true:$stmt->errorInfo();
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);

echo json_encode($output);
?>
