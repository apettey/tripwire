<?php
//***********************************************************
//	File: 		audit_log.php
//	Author: 	Tripwire fork
//
//	Purpose:	Mask Admin > Audit (see docker/README.md#audit-log): who changed what on the mask, newest first.
//				Mask admins only (maskadmin_is_admin: owner, corp admin, granted admin). The mask is always the
//				session's mask: no request value names a mask.
//
//				GET ?system=<id>&character=<text>&kind=<entity[.action]>&from=YYYY-MM-DD&to=YYYY-MM-DD&page=<n>
//				  -> {rows, hasMore, page, days}; 403 for everybody else
//***********************************************************

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask']) || !isset($_SESSION['characterID'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../lib.inc.php');
require_once('../maskadmin/maskadmin.inc.php');
require_once('../audit/audit.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	http_response_code(405);
	echo json_encode(array('error' => 'Method not allowed'));
	exit();
}
if (!isset($mysql) || !($mysql instanceof PDO)) {
	http_response_code(500);
	echo json_encode(array('error' => 'Database error'));
	exit();
}

$mask = (string) $_SESSION['mask'];
$characterID = (int) $_SESSION['characterID'];
$allianceID = isset($_SESSION['allianceID']) ? $_SESSION['allianceID'] : null;
session_write_close();

try {
	if (!maskadmin_run($mysql, function () use ($mysql, $mask, $characterID, $allianceID) { return maskadmin_is_admin($mysql, $mask, $characterID, $allianceID); })) {
		http_response_code(403);
		echo json_encode(array('error' => 'Only mask admins can see the audit log'));
		exit();
	}
	if (!isset($_GET['page']) || $_GET['page'] <= 1) audit_prune($mysql);
	echo json_encode(audit_query($mysql, $mask, audit_filters($_GET)));
} catch (PDOException $e) {
	error_log('audit_log.php: ' . $e->getMessage());
	http_response_code(500);
	echo json_encode(array('error' => 'Database error'));
}
