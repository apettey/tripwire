<?php
//***********************************************************
//	File: 		fork_events.php
//	Author: 	Tripwire fork
//
//	Purpose:	First-party usage statistics (docker/README.md#product-analytics, analytics/analytics.inc.php).
//				GET  ?mode=get -> {enabled, token, key}: whether statistics are collected on this server and, for a
//				                  logged-in user, the per-session token the POSTs carry and an opaque per-account key
//				                  for the browser's once-a-day marks. 403 without a session cookie (no session is made).
//				POST {"t": token, "e": [{"f": feature, "a": action, "n": count}, ...]} (text/plain or application/json,
//				     at most 8 KB / 50 counters) -> always 204, whatever happened. Sent by app/js/fork/feature-usage.js
//				     with fetch(keepalive) or navigator.sendBeacon (which can't set headers: the token is in the body).
//				     Recorded only for a logged-in session with the right token from this site (Origin /
//				     Sec-Fetch-Site), and only feature ids and actions the catalog lists; dropped when the user turned
//				     statistics off (stored options) or sent more than ANALYTICS_RATE_MAX requests a minute.
//***********************************************************

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : '';
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if ($method === 'GET') {
	// Only an existing session: an anonymous caller must not get one made for it
	if (empty($_COOKIE[session_name()])) {
		http_response_code(403);
		exit();
	}
	header('Content-Type: application/json');
	require_once('../config.php');
	require_once('../analytics/analytics.inc.php');
	if (!session_id()) session_start();
	if (!isset($_SESSION['userID'])) {
		session_write_close();
		http_response_code(403);
		exit();
	}
	$userID = (int) $_SESSION['userID'];
	$enabled = analytics_enabled();
	$token = '';
	if ($enabled) {
		if (empty($_SESSION['analyticsCsrf']) || !is_string($_SESSION['analyticsCsrf'])) $_SESSION['analyticsCsrf'] = bin2hex(random_bytes(32));
		$token = $_SESSION['analyticsCsrf'];
	}
	session_write_close();
	$key = '';
	if ($enabled) {
		try {
			require_once('../db.inc.php');
			if (isset($mysql) && $mysql instanceof PDO) $key = analytics_client_key($mysql, $userID);
		} catch (Throwable $e) {
			error_log('fork_events: ' . $e->getMessage());
		}
	}
	echo json_encode(['enabled' => $enabled, 'token' => $token, 'key' => $key]);
	exit();
}

if ($method !== 'POST') {
	header('Allow: GET, POST');
	http_response_code(405);
	exit();
}

// From here on: always 204, nothing in the response tells a caller what was recorded
http_response_code(204);
try {
	// Read the session without keeping its lock (refresh.php holds it for a while; a beacon must not wait on it)
	if (!session_id()) session_start(['read_and_close' => true]);
	$userID = isset($_SESSION['userID']) ? (int) $_SESSION['userID'] : 0;
	$sessionToken = isset($_SESSION['analyticsCsrf']) ? $_SESSION['analyticsCsrf'] : '';
	$mask = isset($_SESSION['mask']) ? (string) $_SESSION['mask'] : '';
	if ($userID <= 0 || $sessionToken === '') exit();

	require_once('../config.php');
	require_once('../analytics/analytics.inc.php');
	if (!analytics_enabled()) exit();

	$body = (string) file_get_contents('php://input', false, null, 0, ANALYTICS_MAX_BODY + 1);
	$catalog = analytics_catalog();
	$parsed = analytics_parse($body, $catalog);
	if (!$parsed || !$parsed['entries'] || !analytics_request_ok($sessionToken, $parsed['token'], $_SERVER)) exit();

	require_once('../db.inc.php');
	if (!isset($mysql) || !($mysql instanceof PDO)) exit();
	if (analytics_opted_out($mysql, $userID)) exit();
	analytics_record($mysql, $userID, $mask, $parsed['entries'], null, $catalog);
} catch (Throwable $e) {
	error_log('fork_events: ' . $e->getMessage());
}
exit();
