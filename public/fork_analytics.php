<?php
//***********************************************************
//	File: 		fork_analytics.php
//	Author: 	Tripwire fork
//
//	Purpose:	The analytics dashboard's data (docker/README.md#product-analytics, analytics/dashboard.inc.php,
//				app/js/fork/analytics-dashboard.js). JSON, GET only, read only.
//				GET ?mode=access                -> {admin: bool} for any logged-in user (the menu item shows only on true)
//				GET ?mode=features|launches|off|never|health|tips
//				GET ?mode=funnel&feature=<id>   -> the view; 403 unless the session's character is in ANALYTICS_ADMINS
//				                                   (checked on every request; empty list = nobody). 403 without a login.
//				Aggregates only: no uids, no per-user rows; small counts come back as "<5" (users) / "<3" (masks).
//***********************************************************

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (!isset($_SERVER['REQUEST_METHOD']) || $_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	http_response_code(405);
	exit();
}
// Only an existing session: an anonymous caller must not get one made for it
if (empty($_COOKIE[session_name()])) {
	http_response_code(403);
	exit();
}
if (!session_id()) session_start(['read_and_close' => true]);
if (!isset($_SESSION['userID']) || !isset($_SESSION['characterID'])) {
	http_response_code(403);
	exit();
}
$characterID = (string) $_SESSION['characterID'];

require_once('../config.php');
require_once('../analytics/dashboard.inc.php');

$mode = isset($_GET['mode']) && is_string($_GET['mode']) ? $_GET['mode'] : '';
$admin = dash_is_admin($characterID);
if ($mode === 'access') {
	echo json_encode(['admin' => $admin]);
	exit();
}
if (!$admin) {
	http_response_code(403);
	exit();
}
if (!in_array($mode, DASH_MODES, true)) {
	http_response_code(400);
	echo json_encode(['error' => 'Unknown view']);
	exit();
}

try {
	require_once('../db.inc.php');
	if (!isset($mysql) || !($mysql instanceof PDO)) throw new RuntimeException('no database');
	$today = gmdate('Y-m-d');
	$feature = isset($_GET['feature']) && is_string($_GET['feature']) ? $_GET['feature'] : null;
	// Keyed by view (and feature for the funnel) only: the 2-minute lifetime covers a new day
	$data = dash_cached($mode === 'funnel' ? 'funnel|' . $feature : $mode, function () use ($mysql, $mode, $today, $feature) {
		return dash_view($mysql, $mode, $today, $feature);
	});
	if ($data === null) {
		http_response_code(400);
		echo json_encode(['error' => 'Unknown feature']);
		exit();
	}
	$data['enabled'] = analytics_enabled();
	echo json_encode($data);
} catch (Throwable $e) {
	error_log('fork_analytics: ' . $e->getMessage());
	http_response_code(500);
	echo json_encode(['error' => 'Could not read the statistics']);
}
