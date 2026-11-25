<?php
//***********************************************************
//	File: 		hole_stats.php
//	Author: 	Tripwire fork
//
//	Purpose:	Hole statistics (see docker/README.md#hole-statistics): the holes recorded in the home system of the
//				session's mask (holestats/holestats.inc.php). Read-only, for everyone on the mask; the mask is always the
//				session's mask (checked on every request by mask-guard.inc.php), no request value names one.
//
//				GET ?mode=home -> {home: systemID or 0}
//				GET ?mode=rows -> {home, rows: [...] (newest first), capped, max, backfill: {doneAt, rows} or null}
//				The first rows request for a mask and home backfills its holes once from the audit log.
//***********************************************************

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../holestats/holestats.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function hole_stats_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	hole_stats_fail(405, 'Method not allowed');
}
if (!isset($mysql) || !($mysql instanceof PDO)) hole_stats_fail(500, 'Database error');

$mask = (string) $_SESSION['mask'];
session_write_close();
if (!holestats_mask_ok($mask)) hole_stats_fail(403, 'No mask');

$mode = isset($_GET['mode']) && is_string($_GET['mode']) ? $_GET['mode'] : 'home';
try {
	$home = holestats_home($mysql, $mask);
	if ($mode === 'home') {
		echo json_encode(array('home' => $home));
	} else if ($mode === 'rows') {
		if ($home <= 0) {
			echo json_encode(array('home' => 0, 'rows' => array(), 'capped' => false, 'max' => HOLESTATS_READ_MAX, 'backfill' => null));
			exit();
		}
		$backfill = holestats_backfill($mysql, $mask, $home);
		$result = holestats_rows($mysql, $mask, $home);
		echo json_encode(array('home' => $home, 'rows' => $result['rows'], 'capped' => $result['capped'], 'max' => HOLESTATS_READ_MAX, 'backfill' => $backfill));
	} else {
		hole_stats_fail(400, 'Unknown mode');
	}
} catch (Throwable $e) {
	error_log('hole_stats.php: ' . $e->getMessage());
	hole_stats_fail(500, 'Database error');
}
