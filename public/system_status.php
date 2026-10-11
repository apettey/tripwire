<?php
//***********************************************************
//	File: 		system_status.php
//	Author: 	Tripwire fork
//
//	Purpose:	System status colour, occupier and alias of the current mask (chain map right-click menu).
//				GET                                                         -> the mask's systems
//				POST mode=set&systemID=<id>[&status=<value|''>][&alias=<text>][&occupier=<text>]
//				                                                            -> change the given fields (others keep their value)
//				POST mode=clear&systemID=<id>                               -> remove status, alias and occupier
//				Changes must be POSTed with the X-Requested-With: XMLHttpRequest header (as public/preserve_mass.php).
//				Every answer: { systems: [ { systemID, status, alias, occupier, setBy, setAt (unix seconds) } ] }.
//				The mask always comes from the session, never from the request.
//
//	Storage and validation in system_status.inc.php (fork_system_status, created on first use).
//***********************************************************

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../system_status.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

$mask = $_SESSION['mask'];
$setBy = isset($_SESSION['characterName']) ? $_SESSION['characterName'] : (isset($_SESSION['username']) ? $_SESSION['username'] : null);
session_write_close();

function system_status_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

if (!isset($mysql) || !$mysql) system_status_fail(500, 'Database error');

try {
	system_status_ensure_table($mysql);

	if ($_SERVER['REQUEST_METHOD'] === 'POST') {
		$requestedWith = isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '';
		if (strtolower($requestedWith) !== 'xmlhttprequest') {
			system_status_fail(400, 'Missing X-Requested-With header');
		}
		$systemID = isset($_POST['systemID']) ? system_status_system_id($_POST['systemID']) : false;
		if ($systemID === false) system_status_fail(400, 'Invalid systemID');

		$mode = isset($_POST['mode']) ? $_POST['mode'] : '';
		if ($mode === 'set') {
			$changes = array();
			if (isset($_POST['status'])) {
				$status = system_status_clean_status($_POST['status']);
				if ($status === false) system_status_fail(400, 'Invalid status');
				$changes['status'] = $status;
			}
			foreach (array('alias', 'occupier') as $field) {
				if (isset($_POST[$field])) {
					if (!is_string($_POST[$field])) system_status_fail(400, 'Invalid ' . $field);
					$changes[$field] = $_POST[$field];
				}
			}
			if (!$changes) system_status_fail(400, 'Nothing to set');
			if (system_status_update($mysql, $mask, $systemID, $changes, $setBy) === false) {
				system_status_fail(400, 'Too many systems are marked (at most ' . SYSTEM_STATUS_MAX_ROWS . ')');
			}
		} else if ($mode === 'clear') {
			system_status_clear($mysql, $mask, $systemID);
		} else {
			system_status_fail(400, 'Unknown mode');
		}
	} else if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
		system_status_fail(405, 'Method not allowed');
	}

	echo json_encode(array('systems' => system_status_list($mysql, $mask)));
} catch (Throwable $e) {	// PDO may throw (ERRMODE_EXCEPTION) or return false (checked, thrown as PDOException)
	error_log('system_status.php: ' . $e->getMessage());
	system_status_fail(500, 'Database error');
}
