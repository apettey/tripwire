<?php
//***********************************************************
//	File: 		rally.php
//	Author: 	Tripwire fork
//
//	Purpose:	Stores the chain map's fight point ("Fight here", first called the rally point) for the current
//				mask, with the fleet comp it is for (fight/fight.inc.php).
//				GET                                        -> current fight point of the session mask (with its
//				                                              chain label) and the mask's fleet comps (no mentions)
//				POST mode=set&systemID=<id>[&compID=<id>]  -> set / move the fight point (no compID: no comp)
//				POST mode=clear                            -> clear the fight point
//				Changes must be POSTed with the X-Requested-With: XMLHttpRequest header.
//				Add discord=1 to a change to also post it to Discord: the channel a corp admin chose for the
//				"Fight here" type in Mask Admin > Discord (queued in the Discord outbox, discord/rally.php), or else
//				upstream's server-wide DISCORD_WEB_HOOK of the mask (posted directly, rally_discord.inc.php).
//				"discord" in every answer says whether either is there; "discordChannels" whether the mask has any
//				Discord channel at all (Mask Admin > Discord, for any type) or that server-wide hook.
//
//	The fork_rally table (and its comp columns) is created on first use, so existing databases need no migration.
//	Internal names stay "rally" (table, endpoint, Discord type key): only what users read says "Fight here".
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
$discordAction = null;	// 'set' / 'clear' when the fight point actually changed

function rally_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

try {
	// Don't change the connection's error mode (it may be persistent and shared)
	fight_rally_ensure_table($mysql);

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') {
			rally_fail(400, 'Missing X-Requested-With header');
		}

		$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
		$previous = fight_rally_read($mysql, $mask);

		if ($mode === 'set') {
			$systemID = isset($_POST['systemID']) ? filter_var($_POST['systemID'], FILTER_VALIDATE_INT) : false;
			if ($systemID === false || $systemID < 30000000 || $systemID >= 32000000) {
				rally_fail(400, 'Invalid systemID');
			}
			// The comp is looked up here, never taken from the browser (its name, colour and mention are the admins')
			$compID = isset($_POST['compID']) && is_string($_POST['compID']) ? $_POST['compID'] : '';
			$comp = null;
			if ($compID !== '') {
				$comp = fight_find_comp(fight_comps_load($mysql, $mask), $compID);
				if (!$comp) rally_fail(400, 'That fleet comp no longer exists');
			}
			$setBy = isset($_SESSION['characterName']) ? substr($_SESSION['characterName'], 0, 100) : null;

			fight_rally_store($mysql, $mask, $systemID, $setBy, $comp);
			$output['result'] = true;
			if (fight_rally_changes($previous, $systemID, $comp)) $discordAction = 'set';
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

	$current = fight_rally_read($mysql, $mask);
	$output['rally'] = fight_rally_public($current);
	// The system's chain label, as the Discord message shows it ("AB · J163701")
	if ($current) $output['rally']['label'] = rally_discord_chain_label($mysql, $mask, $current['systemID']);
	$output['comps'] = fight_public_comps(fight_comps_load($mysql, $mask));
} catch (PDOException $e) {
	error_log('rally.php: ' . $e->getMessage());
	rally_fail(500, 'Database error');
}

$route = rally_discord_route($mysql, $mask);
$output['discord'] = !!$route;
$output['discordChannels'] = rally_discord_has_channels($route, $mysql, $mask);	// any channel at all (the Mask Admin tip)
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
