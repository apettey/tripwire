<?php
// Fork-owned: Kill Reporting endpoint (see changes/ and docker/README.md#kill-reporting).
//
// Read-only. Returns kills that zkill_feed.worker.php stored in `zkill_kills`, for the systems the
// browser has on its chain map. Browsers poll this instead of zKillboard.
//
//   GET kills.php                          -> { cursor, friendlyCorporationIDs, kills: [] }  (latest cursor)
//   GET kills.php?since=<cursor>&systems=<id,id,...>
//                                          -> kills with id > since in those systems, killed in the last
//                                             15 minutes, oldest first, at most 50; cursor = where to continue

if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}

// Nothing below writes to the session; release its lock so polling doesn't block other requests
$sessionCorporationID = isset($_SESSION['corporationID']) ? (int) $_SESSION['corporationID'] : 0;
session_write_close();

require_once('../config.php');
require_once('../db.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

const KILLS_MAX_SYSTEMS = 1000;
const KILLS_LIMIT       = 50;
const KILLS_MAX_AGE_MIN = 15;

function kills_fail($status, $message) {
	http_response_code($status);
	echo json_encode(array('error' => $message));
	exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	kills_fail(405, 'GET only');
}

// Friendly corporations: the character's corporation plus the instance-wide list
$friendly = array();
if ($sessionCorporationID > 0) $friendly[$sessionCorporationID] = true;
$configured = defined('KILL_REPORT_FRIENDLY_CORPORATIONS') ? KILL_REPORT_FRIENDLY_CORPORATIONS : (getenv('KILL_REPORT_FRIENDLY_CORPORATIONS') ?: '');
foreach (preg_split('/[\s,]+/', (string) $configured, -1, PREG_SPLIT_NO_EMPTY) as $id) {
	if (ctype_digit($id) && (int) $id > 0) $friendly[(int) $id] = true;
}

// Parameters
$since = null;
if (isset($_GET['since']) && $_GET['since'] !== '') {
	if (!is_string($_GET['since']) || !ctype_digit($_GET['since']) || strlen($_GET['since']) > 18) kills_fail(400, 'since must be a non-negative integer');
	$since = (int) $_GET['since'];
}
$systems = array();
if (isset($_GET['systems']) && $_GET['systems'] !== '') {
	if (!is_string($_GET['systems'])) kills_fail(400, 'systems must be a comma-separated list of system IDs');
	foreach (explode(',', $_GET['systems']) as $id) {
		$id = trim($id);
		if ($id === '') continue;
		if (!ctype_digit($id) || strlen($id) > 10 || (int) $id <= 0) kills_fail(400, 'systems must be a comma-separated list of system IDs');
		$systems[(int) $id] = true;
	}
	if (count($systems) > KILLS_MAX_SYSTEMS) kills_fail(400, 'at most ' . KILLS_MAX_SYSTEMS . ' systems');
}
$systems = array_keys($systems);

$output = array(
	'cursor' => 0,
	'friendlyCorporationIDs' => array_keys($friendly),
	'kills' => array()
);

if (!isset($mysql) || !($mysql instanceof PDO)) kills_fail(500, 'database error');

try {
	$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
	$latest = (int) $mysql->query('SELECT COALESCE(MAX(id), 0) FROM zkill_kills')->fetchColumn();
	$output['cursor'] = $latest;

	// Without since (page load) only the latest cursor is returned, so the page doesn't replay history.
	// A since beyond the latest id (table emptied/recreated) also just resets the client to the latest cursor.
	if ($since !== null && $since < $latest && count($systems) > 0) {
		$placeholders = implode(',', array_fill(0, count($systems), '?'));
		$query = 'SELECT id, killID, systemID, killTime, victimCharacterID, victimCorporationID, victimShipTypeID,
				attackerCharacterCount, attackerCorporationIDs, finalBlowCharacterID, finalBlowShipTypeID, totalValue, solo
			FROM zkill_kills
			WHERE id > ? AND id <= ? AND systemID IN (' . $placeholders . ')
				AND killTime >= UTC_TIMESTAMP() - INTERVAL ' . KILLS_MAX_AGE_MIN . ' MINUTE
			ORDER BY id ASC
			LIMIT ' . KILLS_LIMIT;
		$stmt = $mysql->prepare($query);
		$stmt->execute(array_merge(array($since, $latest), $systems));
		$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

		foreach ($rows as $row) {
			$attackerCorporations = array_values(array_filter(array_map('intval', explode(',', $row['attackerCorporationIDs']))));
			$friendlyAttacker = false;
			foreach ($attackerCorporations as $corporationID) {
				if (isset($friendly[$corporationID])) { $friendlyAttacker = true; break; }
			}
			$victimCorporationID = $row['victimCorporationID'] === null ? null : (int) $row['victimCorporationID'];
			$output['kills'][] = array(
				'killID' => (int) $row['killID'],
				'systemID' => (int) $row['systemID'],
				'killTime' => str_replace(' ', 'T', $row['killTime']) . 'Z',
				'victimCharacterID' => $row['victimCharacterID'] === null ? null : (int) $row['victimCharacterID'],
				'victimCorporationID' => $victimCorporationID,
				'victimShipTypeID' => $row['victimShipTypeID'] === null ? null : (int) $row['victimShipTypeID'],
				'attackerCharacterCount' => (int) $row['attackerCharacterCount'],
				'attackerCorporationIDs' => $attackerCorporations,
				'finalBlowCharacterID' => $row['finalBlowCharacterID'] === null ? null : (int) $row['finalBlowCharacterID'],
				'finalBlowShipTypeID' => $row['finalBlowShipTypeID'] === null ? null : (int) $row['finalBlowShipTypeID'],
				'totalValue' => (float) $row['totalValue'],
				'solo' => (bool) $row['solo'],
				'friendlyVictim' => $victimCorporationID !== null && isset($friendly[$victimCorporationID]),
				'friendlyAttacker' => $friendlyAttacker
			);
		}
		// A full page means there may be more: continue after the last one returned
		if (count($rows) === KILLS_LIMIT) $output['cursor'] = (int) $rows[count($rows) - 1]['id'];
	}
} catch (PDOException $error) {
	// 42S02: the worker hasn't created the table yet. Anything else is a real error.
	if ($error->getCode() !== '42S02') {
		error_log('kills.php: ' . $error->getMessage());
		kills_fail(500, 'database error');
	}
}

echo json_encode($output);
