<?php
// Fork-owned: raidable skyhooks (see changes/2026-10-11-raidable-skyhooks and skyhooks.inc.php).
//
// Never lets browsers reach ESI (its skyhook route allows 30 requests per 15 minutes per IP): serves the list the
// server keeps, refreshed from ESI at most every 5 minutes for everyone.
//
//   GET skyhooks.php
// Response: {skyhooks: [{planetID, systemID, start, end}], fetched, now, stale, unavailable, error}   (times: unix seconds)

if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}
session_write_close();

require_once('../skyhooks.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	http_response_code(405);
	echo json_encode(array('error' => 'GET only'));
	exit();
}

$result = skyhooks_get();
$result['now'] = time();
echo json_encode($result);
