<?php
//***********************************************************
//	File: 		rolling.php
//	Author: 	Tripwire fork
//
//	Purpose:	"Rolling" flags on the chain map's connections (wormholes) of the current mask: "we are rolling this hole".
//				GET                                             -> the mask's flags
//				POST mode=set&wormholeID=<id>[&note=<text>]     -> flag a wormhole of the mask
//				POST mode=clear&wormholeID=<id>                 -> remove the flag
//				Changes must be POSTed with the X-Requested-With: XMLHttpRequest header (as public/preserve_mass.php).
//				Every answer: { flags: [ { wormholeID, setByID, setBy, setAt (unix seconds), note } ] }.
//
//	Storage in rolling.inc.php (fork_rolling, created on first use, so no migration is needed). Flags of deleted
//	wormholes are never returned; they are deleted from the table when the mask's flags change.
//	A change is also queued for Discord when a corp admin turned on the "Rolling" type (discord/rolling.php).
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../rolling.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$mask = $_SESSION['mask'];
$setByID = isset($_SESSION['characterID']) ? $_SESSION['characterID'] : null;
$setBy = isset($_SESSION['characterName']) ? $_SESSION['characterName'] : (isset($_SESSION['username']) ? $_SESSION['username'] : null);
session_write_close();
$output = array();

function rolling_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

if (!isset($mysql) || !$mysql) rolling_fail(500, 'Database error');

try {
	rolling_ensure_table($mysql);

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') {
			rolling_fail(400, 'Missing X-Requested-With header');
		}

		$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
		$wormholeID = isset($_POST['wormholeID']) ? preserve_mass_wormhole_id($_POST['wormholeID']) : false;
		if ($wormholeID === false) rolling_fail(400, 'Invalid wormholeID');
		$before = rolling_get($mysql, $mask, $wormholeID);	// Discord: what changed is decided here, not by the browser

		if ($mode === 'set') {
			if (!preserve_mass_wormhole_in_mask($mysql, $mask, $wormholeID)) {
				rolling_fail(404, 'Unknown wormhole');
			}
			rolling_set($mysql, $mask, $wormholeID, $setByID, $setBy, isset($_POST['note']) ? $_POST['note'] : '');
		} else if ($mode === 'clear') {
			rolling_clear($mysql, $mask, $wormholeID);
		} else {
			rolling_fail(400, 'Unknown mode');
		}
		$output['result'] = true;
		$discordChange = array('wormholeID' => $wormholeID, 'before' => $before, 'after' => rolling_get($mysql, $mask, $wormholeID));
		rolling_clean($mysql, $mask);	// on changes only: GET polls never write
	} else if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
		rolling_fail(405, 'Method not allowed');
	}

	$output['flags'] = rolling_list($mysql, $mask);
} catch (Throwable $e) {	// PDO may throw (ERRMODE_EXCEPTION) or return false (checked, thrown as PDOException)
	error_log('rolling.php: ' . $e->getMessage());
	rolling_fail(500, 'Database error');
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);

echo json_encode($output);

// Discord (Mask Admin > Discord > Rolling): after the response is sent, queued for discord_notify.worker.php.
// Only when the flag really changed (marked, cleared, or another pilot / note); the module is loaded only then.
if (isset($discordChange)) {
	if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
	try {
		require_once('../discord/discord.inc.php');
		$action = discord_rolling_change($discordChange['before'], $discordChange['after']);
		if ($action) discord_rolling_enqueue($mysql, $mask, $discordChange['wormholeID'], $action, $setBy === null ? '' : $setBy);
	} catch (Throwable $e) {
		error_log('rolling.php discord: ' . $e->getMessage());
	}
}
