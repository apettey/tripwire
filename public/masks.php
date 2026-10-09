<?PHP
//***********************************************************
//	File: 		masks.php
//	Author: 	Daimian
//	Created: 	8/19/2014
//	Modified: 	8/19/2014 - Daimian
//
//	Purpose:	Handles mask creation.
//
//	ToDo:
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

// Check for login - else kick
if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../lib.inc.php');

$mode = isset($_REQUEST['mode'])?$_REQUEST['mode']:null;
$mask = isset($_REQUEST['mask'])?$_REQUEST['mask']:null;
$type = isset($_REQUEST['type'])?$_REQUEST['type']:null;
$name = isset($_REQUEST['name'])?$_REQUEST['name']:null;
$adds = isset($_REQUEST['adds'])?$_REQUEST['adds']:array();
$deletes = isset($_REQUEST['deletes'])?$_REQUEST['deletes']:array();
$output = null;

header('Content-Type: application/json');

if ($mode == 'create') {
	if (!$name) {
		$output['error'] = 'Mask must have a name';
	} else if (count($adds) == 0) {
		$output['error'] = 'Mask must have atleast one entity with access';
	} else if ($type == 'corp' && !$_SESSION['admin']) {
		$output['error'] = 'You are not a corporate admin';
	} else {
		$ownerID = $type == 'corp' ? $_SESSION['corporationID'] : $_SESSION['characterID'];
		$ownerType = $type == 'corp' ? 2 : 1373;

		if (in_array($ownerID.'_'.$ownerType, $adds)) {
			$output['error'] = 'Mask creator should not be in access list';
		} else {
			$query = 'SELECT MAX(maskID) AS mask FROM masks';
			$stmt = $mysql->prepare($query);
			$stmt->execute();
			$mask = $stmt->fetchColumn(0) +1;

			$query = 'INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (:maskID, :name, :ownerID, :ownerType)';
			$stmt = $mysql->prepare($query);
			$stmt->bindValue(':maskID', $mask);
			$stmt->bindValue(':name', $name);
			$stmt->bindValue(':ownerID', $ownerID);
			$stmt->bindValue(':ownerType', $ownerType);

			if ($stmt->execute()) {
				foreach ($adds as $add) {
					list($id, $type) = explode('_', $add);

					$query = 'INSERT INTO `groups` (maskID, eveID, eveType) VALUES (:mask, :id, :type)';
					$stmt = $mysql->prepare($query);
					$stmt->bindValue(':mask', $mask);
					$stmt->bindValue(':id', $id);
					$stmt->bindValue(':type', $type);
					$stmt->execute();
				}

				$output['result'] = true;
			} else {
				$output['error'] = 'Unable to create mask, possible duplicate name';
			}
		}
	}
} else if ($mode == 'save' && $mask && (checkOwner($mask) || checkAdmin($mask))) {
	foreach ($adds as $add) {
		list($id, $type) = explode('_', $add);

		$query = 'INSERT INTO `groups` (maskID, eveID, eveType) VALUES (:mask, :id, :type)';
		$stmt = $mysql->prepare($query);
		$stmt->bindValue(':mask', $mask);
		$stmt->bindValue(':id', $id);
		$stmt->bindValue(':type', $type);
		$stmt->execute();
	}

	foreach ($deletes as $delete) {
		list($id, $type) = explode('_', $delete);

		$query = 'DELETE FROM `groups` WHERE maskID = :mask AND eveID = :id AND eveType = :type';
		$stmt = $mysql->prepare($query);
		$stmt->bindValue(':mask', $mask);
		$stmt->bindValue(':id', $id);
		$stmt->bindValue(':type', $type);
		$stmt->execute();
	}

	$output['result'] = true;
} else if ($mode == 'edit' && $mask && (checkOwner($mask) || checkAdmin($mask))) {
	$query = 'SELECT eveID FROM masks INNER JOIN `groups` ON `groups`.maskID = masks.maskID WHERE masks.maskID = :mask';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':mask', $mask);
	$stmt->execute();
	$output['results'] = $stmt->fetchAll(PDO::FETCH_COLUMN);
} else if ($mode == 'delete' && $mask && (checkOwner($mask) || checkAdmin($mask))) {
	$query = 'DELETE masks, `groups`, comments, signatures FROM masks LEFT JOIN `groups` ON `groups`.maskID = masks.maskID LEFT JOIN comments ON comments.maskID = masks.maskID LEFT JOIN signatures ON signatures.maskID = masks.maskID WHERE masks.maskID = :mask';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':mask', $mask);
	$output['result'] = $stmt->execute();
} else if ($mode == 'find') {
	$name = $name ? $name : '%';

	$query = "SELECT masks.maskID, name, ownerID, ownerType FROM masks INNER JOIN `groups` ON `groups`.maskID = masks.maskID WHERE ('personal' = :type AND joined = 0 AND eveID = :characterID AND eveType = 1373 AND name LIKE :name) OR ('corporate' = :type AND joined = 0 AND eveID = :corporationID AND eveType = 2 AND name LIKE :name)";
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':name', $name.'%');
	$stmt->bindValue(':characterID', $_SESSION['characterID']);
	$stmt->bindValue(':corporationID', $_SESSION['corporationID']);
	$stmt->bindValue(':type', $_REQUEST['find']);
	$stmt->execute();

	if ($stmt->rowCount()) {
		$ids = array();

		while ($row = $stmt->fetchObject()) {
			$ids[] = $row->ownerID;

			$output['results'][] = array(
				'mask' => $row->maskID,
				'label' => $row->name,
				'owner' => $row->ownerType == 1373 && $row->ownerID == $_SESSION['characterID']?true:false,
				'img' => $row->ownerType == 2?'https://image.eveonline.com/Corporation/'.$row->ownerID.'_64.png':'https://image.eveonline.com/Character/'.$row->ownerID.'_64.jpg'
			);
		}
		$output['eveIDs'] = $ids;
	} else {
		$output['error'] = "No masks found";
	}
} else if ($mode == 'join') {
	$query = 'UPDATE `groups` SET joined = 1 WHERE maskID = :mask AND ((eveID = :characterID AND eveType = 1373) OR (eveID = (SELECT corporationID FROM characters WHERE characterID = :characterID AND admin = 1) AND eveType = 2))';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':characterID', $_SESSION['characterID']);
	$stmt->bindValue(':mask', $mask);
	$stmt->execute();

	if ($output['result'] = $stmt->rowCount()) {
		$query = 'SELECT eveType FROM `groups` WHERE maskID = :mask AND joined = 1';
		$stmt = $mysql->prepare($query);
		$stmt->bindValue(':mask', $mask);
		$stmt->execute();

		$output['type'] = $stmt->fetchColumn(0) == 2 ? 'corporate' : 'personal';
	}
} else if ($mode == 'leave') {
	$query = 'UPDATE `groups` SET joined = 0 WHERE maskID = :mask AND ((eveID = :characterID AND eveType = 1373) OR (eveID = (SELECT corporationID FROM characters WHERE characterID = :characterID AND admin = 1) AND eveType = 2))';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':characterID', $_SESSION['characterID']);
	$stmt->bindValue(':mask', $mask);
	$stmt->execute();
	$output['result'] = $stmt->rowCount();
} else {
	require_once '../masks.inc.php';
	$output['masks'] = getMasks($_SESSION['characterID'], $_SESSION['corporationID'], $_SESSION['admin'], $_SESSION['mask']);

	foreach ($output['masks'] AS $i => $mask) {
		if ($_SESSION['mask'] == $mask['mask']) {
			$output['active'] = $i;
		}
	}
}

$output['processTime'] = sprintf('%.4f', microtime(true) - $startTime);

echo json_encode($output);
