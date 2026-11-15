<?php
//***********************************************************
//	File: 		occupants.php
//	Author: 	Daimian
//	Created: 	6/1/2013
//	Modified: 	1/22/2014 - Daimian
//
//	Purpose:	Handles pulling system occupants.
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

header('Content-Type: application/json');

$systemID = $_REQUEST['systemID'];
$maskID = $_SESSION['mask'];

$query = 'SELECT characterName, shipTypeName, online, (case when stationID is null then 0 else 1 end) as docked FROM tracking WHERE systemID = :systemID AND maskID = :maskID AND characterName NOT LIKE \'%|x%\' order by online desc, docked asc, characterName asc';
$stmt = $mysql->prepare($query);
$stmt->bindValue(':systemID', $systemID);
$stmt->bindValue(':maskID', $maskID);
$stmt->execute();

$raw = $stmt->fetchAll(PDO::FETCH_CLASS);
$output['occupants'] = array();
foreach($raw as $row) {
	$splitName = explode('|', $row->characterName);
	$mapped = array('characterName' => $splitName[0], 'shipTypeName' => $row->shipTypeName, 'online' => $row->online, 'docked' => $row->docked);
	
	switch($splitName[1]) {
		case 'p':  $mapped['shipTypeName'] = '-'; break;
	}
	
	$output['occupants'][] = $mapped;
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);

echo json_encode($output);

?>
