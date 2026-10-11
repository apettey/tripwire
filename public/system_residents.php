<?php
//***********************************************************
//	File: 		system_residents.php
//	Author: 	Tripwire fork
//
//	Purpose:	Who lives in a system, set by hand and shared with the current mask (Intel panel > Threat & residents >
//				Set residents).
//				GET  ?systemID=<id>                                              -> the mask's residents of the system
//				POST mode=set&systemID=<id>&entities=<JSON [{kind, id}]>&names=<JSON [name]>&note=<text>
//				POST mode=clear&systemID=<id>
//				Changes must be POSTed with the X-Requested-With: XMLHttpRequest header (as public/preserve_mass.php).
//				Every answer: { residents: null | { systemID, entities: [{kind, id, name, ticker}], note, setBy,
//				setAt (unix seconds) } }. A name ESI doesn't know: 400 { error, unknown: [names] }.
//
//	Storage, validation and the ESI lookups (names and tickers come from ESI, never from the browser) in
//	system_residents.inc.php (fork_system_residents, created on first use).
//***********************************************************

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../system_residents.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$mask = $_SESSION['mask'];
$setBy = isset($_SESSION['characterName']) ? $_SESSION['characterName'] : (isset($_SESSION['username']) ? $_SESSION['username'] : null);
session_write_close();

function system_residents_fail($code, $message, $extra = array()) {
	http_response_code($code);
	echo json_encode(array_merge(array('error' => $message), $extra));
	exit();
}

if (!isset($mysql) || !$mysql) system_residents_fail(500, 'Database error');

$method = $_SERVER['REQUEST_METHOD'];
if ($method !== 'GET' && $method !== 'POST') {
	header('Allow: GET, POST');
	system_residents_fail(405, 'Method not allowed');
}
$params = $method === 'POST' ? $_POST : $_GET;
$systemID = isset($params['systemID']) ? system_residents_system_id($params['systemID']) : false;
if ($systemID === false) system_residents_fail(400, 'Invalid systemID');

try {
	system_residents_ensure_table($mysql);

	if ($method === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') system_residents_fail(400, 'Missing X-Requested-With header');
		$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
		if ($mode === 'set') {
			$picks = system_residents_parse_picks(isset($_POST['entities']) ? $_POST['entities'] : '');
			if (is_string($picks)) system_residents_fail(400, $picks);
			$names = system_residents_parse_names(isset($_POST['names']) ? $_POST['names'] : '');
			if (is_string($names)) system_residents_fail(400, $names);
			if (!$picks && !$names) system_residents_fail(400, 'Pick or enter at least one corporation or alliance');
			if (count($picks) + count($names) > SYSTEM_RESIDENTS_MAX) system_residents_fail(400, 'At most ' . SYSTEM_RESIDENTS_MAX . ' corporations and alliances');
			$known = array();
			$current = system_residents_get($mysql, $mask, $systemID);
			foreach ($current ? $current['entities'] : array() as $e) {
				if ($e['name'] !== '') $known[$e['kind'] . ':' . $e['id']] = $e;
			}
			$resolved = system_residents_resolve($picks, $names, $known, function($entities) use ($mysql, $systemID) {
				return system_residents_local_info($mysql, $systemID, $entities);
			});
			if ($resolved['unknown']) {
				system_residents_fail(400, 'Not a corporation or alliance: ' . implode(', ', $resolved['unknown']), array('unknown' => $resolved['unknown']));
			}
			if ($resolved['error']) system_residents_fail($resolved['invalid'] ? 400 : 502, $resolved['error']);	// 502: ESI failed
			system_residents_set($mysql, $mask, $systemID, $resolved['entities'], isset($_POST['note']) ? $_POST['note'] : '', $setBy);
		} else if ($mode === 'clear') {
			system_residents_clear($mysql, $mask, $systemID);
		} else {
			system_residents_fail(400, 'Unknown mode');
		}
	}

	echo json_encode(array('residents' => system_residents_get($mysql, $mask, $systemID)));
} catch (Throwable $e) {	// PDO may throw (ERRMODE_EXCEPTION) or return false (checked, thrown as PDOException)
	error_log('system_residents.php: ' . $e->getMessage());
	system_residents_fail(500, 'Database error');
}
