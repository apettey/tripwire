<?php
//***********************************************************
//	File: 		rally.php
//	Author: 	Tripwire fork
//
//	Purpose:	Stores the chain map rally point for the current mask.
//				GET                          -> current rally for the session mask
//				POST mode=set&systemID=<id>  -> set the rally point
//				POST mode=clear              -> clear the rally point
//				Changes must be POSTed with the X-Requested-With: XMLHttpRequest header.
//				Add discord=1 to a change to also post it to Discord: the channel a corp admin chose for the
//				rally type in Mask Admin > Discord (queued in the Discord outbox, discord/rally.php), or else
//				upstream's server-wide DISCORD_WEB_HOOK of the mask (posted directly, rally_discord.inc.php).
//				"discord" in every answer says whether either is there.
//
//	The fork_rally table is created on first use, so existing databases need no migration.
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../discord/discord.inc.php');
require_once('../rally_discord.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$mask = $_SESSION['mask'];
$output = array();
$discordAction = null;	// 'set' / 'clear' when the rally actually changed

function rally_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

function rally_current($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT systemID, setBy, setAt FROM fork_rally WHERE maskID = :mask');
	if (!$stmt) throw new PDOException('Could not read fork_rally');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) {
		throw new PDOException('Could not read fork_rally');
	}
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	if (!$row) return null;
	return array('systemID' => (int)$row['systemID'], 'setBy' => $row['setBy'], 'setAt' => $row['setAt']);
}

try {
	// Don't change the connection's error mode (it may be persistent and shared); check results instead.
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_rally (
		maskID decimal(12,1) NOT NULL,
		systemID int NOT NULL,
		setBy varchar(100) DEFAULT NULL,
		setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (maskID)
	)');
	if ($created === false) {
		throw new PDOException('Could not create fork_rally: ' . implode(' ', $mysql->errorInfo()));
	}

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') {
			rally_fail(400, 'Missing X-Requested-With header');
		}

		$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
		$previous = rally_current($mysql, $mask);

		if ($mode === 'set') {
			$systemID = isset($_POST['systemID']) ? filter_var($_POST['systemID'], FILTER_VALIDATE_INT) : false;
			if ($systemID === false || $systemID < 30000000 || $systemID >= 32000000) {
				rally_fail(400, 'Invalid systemID');
			}
			$setBy = isset($_SESSION['characterName']) ? substr($_SESSION['characterName'], 0, 100) : null;

			$stmt = $mysql->prepare('INSERT INTO fork_rally (maskID, systemID, setBy, setAt) VALUES (:mask, :systemID, :setBy, CURRENT_TIMESTAMP)
				ON DUPLICATE KEY UPDATE systemID = VALUES(systemID), setBy = VALUES(setBy), setAt = CURRENT_TIMESTAMP');
			$stmt->bindValue(':mask', $mask);
			$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
			$stmt->bindValue(':setBy', $setBy);
			if (!$stmt->execute()) throw new PDOException('Could not set rally: ' . implode(' ', $stmt->errorInfo()));
			$output['result'] = true;
			if (!$previous || $previous['systemID'] !== $systemID) $discordAction = 'set';
		} else if ($mode === 'clear') {
			$stmt = $mysql->prepare('DELETE FROM fork_rally WHERE maskID = :mask');
			$stmt->bindValue(':mask', $mask);
			if (!$stmt->execute()) throw new PDOException('Could not clear rally: ' . implode(' ', $stmt->errorInfo()));
			$output['result'] = true;
			if ($previous) $discordAction = 'clear';
		} else {
			rally_fail(400, 'Unknown mode');
		}
	} else if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
		rally_fail(405, 'Method not allowed');
	}

	$output['rally'] = rally_current($mysql, $mask);
} catch (PDOException $e) {
	error_log('rally.php: ' . $e->getMessage());
	rally_fail(500, 'Database error');
}

$route = rally_discord_route($mysql, $mask);
$output['discord'] = !!$route;
$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);

echo json_encode($output);

// Discord: after the response is sent, so neither the outbox nor a slow legacy webhook holds up the map
if ($discordAction && $route && isset($_POST['discord']) && $_POST['discord'] === '1') {
	$who = isset($_SESSION['characterName']) ? $_SESSION['characterName'] : (isset($_SESSION['username']) ? $_SESSION['username'] : null);
	$previousSystemID = $discordAction === 'clear' && $previous ? $previous['systemID'] : 0;	// the cleared message names it
	session_write_close();
	if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
	try {
		if ($route['via'] === 'settings') {
			// Mask Admin > Discord: the sender (discord_notify.worker.php) posts or edits the message
			discord_rally_enqueue($mysql, $mask, $route['type'], $discordAction, $who, $previousSystemID);
		} else {
			rally_discord_notify($mysql, $mask, $route['hook'], $discordAction, $who, $previousSystemID);
		}
	} catch (Throwable $e) {
		error_log('rally discord: ' . rally_discord_redact($e->getMessage()));
	}
}
