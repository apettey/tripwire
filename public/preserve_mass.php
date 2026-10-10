<?php
//***********************************************************
//	File: 		preserve_mass.php
//	Author: 	Tripwire fork
//
//	Purpose:	"Preserve mass" flags on the chain map's connections (wormholes) of the current mask.
//				GET                                               -> the mask's flags
//				POST mode=set&wormholeID=<id>[&reason=<text>]     -> flag a wormhole of the mask
//				POST mode=clear&wormholeID=<id>                   -> remove the flag
//				Changes must be POSTed with the X-Requested-With: XMLHttpRequest header (as public/rally.php).
//				Every answer: { flags: [ { wormholeID, setBy, setAt (unix seconds), reason } ] }.
//
//	Storage in preserve_mass.inc.php (fork_preserve_mass, created on first use, so no migration is needed).
//***********************************************************
$startTime = microtime(true);

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../preserve_mass.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$mask = $_SESSION['mask'];
$setBy = isset($_SESSION['characterName']) ? $_SESSION['characterName'] : (isset($_SESSION['username']) ? $_SESSION['username'] : null);
session_write_close();
$output = array();

function preserve_mass_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

if (!isset($mysql) || !$mysql) preserve_mass_fail(500, 'Database error');

try {
	preserve_mass_ensure_table($mysql);

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') {
			preserve_mass_fail(400, 'Missing X-Requested-With header');
		}

		$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
		$wormholeID = isset($_POST['wormholeID']) ? preserve_mass_wormhole_id($_POST['wormholeID']) : false;
		if ($wormholeID === false) preserve_mass_fail(400, 'Invalid wormholeID');

		if ($mode === 'set') {
			if (!preserve_mass_wormhole_in_mask($mysql, $mask, $wormholeID)) {
				preserve_mass_fail(404, 'Unknown wormhole');
			}
			preserve_mass_set($mysql, $mask, $wormholeID, $setBy, isset($_POST['reason']) ? $_POST['reason'] : '');
		} else if ($mode === 'clear') {
			preserve_mass_clear($mysql, $mask, $wormholeID);
		} else {
			preserve_mass_fail(400, 'Unknown mode');
		}
		$output['result'] = true;
	} else if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
		preserve_mass_fail(405, 'Method not allowed');
	}

	preserve_mass_clean($mysql, $mask);
	$output['flags'] = preserve_mass_list($mysql, $mask);
} catch (PDOException $e) {
	error_log('preserve_mass.php: ' . $e->getMessage());
	preserve_mass_fail(500, 'Database error');
}

$output['proccessTime'] = sprintf('%.4f', microtime(true) - $startTime);

echo json_encode($output);
