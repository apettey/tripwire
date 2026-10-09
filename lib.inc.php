<?php
require_once('db.inc.php');

function checkOwner($mask) {
	global $mysql;

	if ($mask == $_SESSION['characterID'].'.1') {
		return true;
	}

	$query = 'SELECT maskID FROM masks WHERE ownerID = :ownerID AND ownerType = 1373 AND maskID = :mask';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':ownerID', $_SESSION['characterID']);
	$stmt->bindValue(':mask', $mask);
	$stmt->execute();

	return $stmt->rowCount() == 0 ? false : true;
}

function checkAdmin($mask) {
	global $mysql;

	if ($mask == $_SESSION['corporationID'].'.2' && $_SESSION['admin'] == 1) {
		return true;
	}

	$query = 'SELECT corporationID FROM characters INNER JOIN masks ON ownerID = corporationID AND ownerType = 2 WHERE characterID = :characterID AND admin = 1 AND maskID = :mask';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':characterID', $_SESSION['characterID']);
	$stmt->bindValue(':mask', $mask);
	$stmt->execute();

	return $stmt->rowCount() == 0 ? false : true;
}

function verifyMask($mask) {
	global $mysql;
	
	$checkMask = explode('.', $mask);
	if ($checkMask[1] == 0 && $checkMask[0] != 0) {
		// Check custom mask
		$query = 'SELECT masks.maskID FROM masks INNER JOIN `groups` ON masks.maskID = `groups`.maskID WHERE masks.maskID = :maskID AND ((ownerID = :characterID AND ownerType = 1373) OR (ownerID = :corporationID AND ownerType = 2) OR (ownerID = :allianceID AND ownerType = 3) OR (eveID = :characterID AND eveType = 1373) OR (eveID = :corporationID AND eveType = 2) OR (eveID = :allianceID AND eveType = 3))';
		$stmt = $mysql->prepare($query);
		$stmt->bindValue(':characterID', $_SESSION['characterID']);
		$stmt->bindValue(':corporationID', $_SESSION['corporationID']);
		$stmt->bindValue(':allianceID', $_SESSION['allianceID']);
		$stmt->bindValue(':maskID', $mask);

		if ($stmt->execute() && $stmt->fetchColumn(0) != $mask) {
			return $_SESSION['corporationID'] . '.2';
		}
	} else if ($checkMask[1] == 1 && $checkMask[0] != $_SESSION['characterID']) {
		// Force current character mask
		return $_SESSION['characterID'] . '.1';
	} else if ($checkMask[1] == 2 && $checkMask[0] != $_SESSION['corporationID']) {
		// Force current corporation mask
		return $_SESSION['corporationID'] . '.2';
	} else if ($checkMask[1] == 3 && $checkMask[0] != ($_SESSION['allianceID'] ?? false)) {
		// Force current alliance mask (or corp if none)
		return $_SESSION['allianceID'] ? $_SESSION['allianceID'] . '.3' : $_SESSION['corporationID'] . '.2';
	}
	
	return $mask;
}