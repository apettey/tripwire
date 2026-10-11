<?php
//***********************************************************
//	File: 		comments.php
//	Author: 	Daimian
//	Created: 	12/08/2014
//	Modified: 	12/12/2014 - Daimian
//
//	Purpose:	Handles saving/editing/deleting comments.
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
require_once('../note-html.inc.php');

header('Content-Type: application/json');

$maskID = 		$_SESSION['mask'];
$characterID = 	$_SESSION['characterID'];
$characterName = $_SESSION['characterName'];
// fork: state-changing, so POST only (a note's <img src> must not be able to fire it with a GET); the app already POSTs
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
	http_response_code(405);
	header('Allow: POST');
	exit();
}
$systemID = 	isset($_POST['systemID']) ? $_POST['systemID'] : null;
$commentID = 	isset($_POST['commentID']) ? $_POST['commentID'] : null;
$comment = 		isset($_POST['comment']) ? $_POST['comment'] : null;
$mode = 		isset($_POST['mode']) ? $_POST['mode'] : null;
$output = 		null;

if ($mode == 'save') {
	// Notes are shared stored content: clean them on the way in as well as on the way out (refresh.php).
	if (!noteHtmlSanitizerAvailable()) {
		http_response_code(503);
		echo json_encode(array('result' => false, 'error' => 'PHP DOM extension is required to save notes.'));
		exit();
	}
	$comment = sanitizeNoteHtml($comment);
	$query = 'INSERT INTO comments (id, systemID, comment, created, createdByID, createdByName, modifiedByID, modifiedByName, maskID)
				VALUES (:commentID, :systemID, :comment, NOW(), :createdByID, :createdByName, :modifiedByID, :modifiedByName, :maskID)
				ON DUPLICATE KEY UPDATE
				systemID = :systemID, comment = :comment, modifiedByID = :modifiedByID, modifiedByName = :modifiedByName, modified = NOW()';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':commentID', $commentID);
	$stmt->bindValue(':systemID', $systemID);
	$stmt->bindValue(':comment', $comment);
	$stmt->bindValue(':createdByID', $characterID);
	$stmt->bindValue(':createdByName', $characterName);
	$stmt->bindValue(':modifiedByID', $characterID);
	$stmt->bindValue(':modifiedByName', $characterName);
	$stmt->bindValue(':maskID', $maskID);
	$success = $stmt->execute();

	if ($success) {
		$query = 'SELECT id, created AS createdDate, createdByName, modified AS modifiedDate, modifiedByName FROM comments WHERE id = :commentID AND maskID = :maskID';
		$stmt = $mysql->prepare($query);
		$stmt->bindValue(':commentID', ($commentID ? $commentID : $mysql->lastInsertId()));
		$stmt->bindValue(':maskID', $maskID);
		$stmt->execute();
		$output['comment'] = $stmt->fetchObject();
		$output['result'] = $success;

		// Log the user stats
		if ($commentID) {
			$query = 'INSERT INTO statistics (userID, characterID, maskID, comments_updated) VALUES (:userID, :characterID, :maskID, 1)
			ON DUPLICATE KEY UPDATE comments_updated = comments_updated + 1';
			$stmt = $mysql->prepare($query);
			$stmt->bindValue(':userID', $_SESSION['userID']);
			$stmt->bindValue(':characterID', $_SESSION['characterID']);
			$stmt->bindValue(':maskID', $maskID);
			$success = $stmt->execute();
		} else {
			$query = 'INSERT INTO statistics (userID, characterID, maskID, comments_added) VALUES (:userID, :characterID, :maskID, 1)
			ON DUPLICATE KEY UPDATE comments_added = comments_added + 1';
			$stmt = $mysql->prepare($query);
			$stmt->bindValue(':userID', $_SESSION['userID']);
			$stmt->bindValue(':characterID', $_SESSION['characterID']);
			$stmt->bindValue(':maskID', $maskID);
			$success = $stmt->execute();
		}
	} else {
		$output['error'] = $stmt->errorInfo();
	}
} else if ($mode == 'delete' && $commentID) {
	$query = 'DELETE FROM comments WHERE id = :commentID AND maskID = :maskID';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':commentID', $commentID);
	$stmt->bindValue(':maskID', $maskID);
	$success = $stmt->execute();

	if ($success) {
		// Log the user stats
        $query = 'INSERT INTO statistics (userID, characterID, maskID, comments_deleted) VALUES (:userID, :characterID, :maskID, 1)
            ON DUPLICATE KEY UPDATE comments_deleted = comments_deleted + 1';
        $stmt = $mysql->prepare($query);
        $stmt->bindValue(':userID', $_SESSION['userID']);
        $stmt->bindValue(':characterID', $_SESSION['characterID']);
        $stmt->bindValue(':maskID', $maskID);
        $success = $stmt->execute();

		$output['result'] = $success;
	} else {
		$output['error'] = $stmt->errorInfo();
	}
} else if ($mode == 'sticky' && $commentID) {
	$query = 'UPDATE comments SET systemID = :systemID WHERE id = :commentID AND maskID = :maskID';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':commentID', $commentID);
	$stmt->bindValue(':systemID', $systemID);
	$stmt->bindValue(':maskID', $maskID);
	$output['result'] = $stmt->execute();
}


$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);

echo json_encode($output);
?>
