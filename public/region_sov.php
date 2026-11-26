<?php
// Fork-owned: the region map's Sovereignty overlay (see changes/2026-11-26-region-map-sovereignty and
// sovereignty.inc.php). Browsers never call ESI for it: the server keeps one copy of the sovereignty map (1 h) and
// the incursions (10 min) for everyone, and names a region's alliances once a week.
//
//   GET region_sov.php?region=<regionID>
// Response: {region, systems: {systemID: {a: allianceID, c: corporationID} | {f: factionID}}, alliances: {id: {name,
// ticker}}, pending, incursions: [{constellationID, factionID, boss, systems, influence, staging, state, type}],
// sov: {fetched, stale, unavailable, error}, incursionsStatus: {...}, now}

if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}
session_write_close();

require_once('../sovereignty.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	http_response_code(405);
	echo json_encode(array('error' => 'GET only'));
	exit();
}

$region = isset($_GET['region']) && is_string($_GET['region']) && ctype_digit($_GET['region']) ? (int) $_GET['region'] : 0;
$result = $region ? sov_region($region) : null;
if ($result === null) {
	http_response_code(404);
	echo json_encode(array('error' => 'Unknown region'));
	exit();
}
$result['now'] = time();
echo json_encode($result);
