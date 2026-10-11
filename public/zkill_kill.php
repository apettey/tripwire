<?php
// Fork-owned: Smart notes endpoint (see changes/2026-10-11-smart-notes and docker/README.md#zkillboard-integration).
//
// Card data for zKillboard kill links and names for entity chips in system notes. Never calls zKillboard or ESI: it
// reads zkill_killmails / zkill_names and queues kills that are not stored (zkill/lookup.php) and unknown names for
// zkill_feed.worker.php. Queueing is bounded (per-user and overall caps), so this GET's only side effect is a
// deduplicated queue row. Logged-in users with a mask only, so it can't serve as a public proxy.
//
//   GET zkill_kill.php?ids=<killID,...>          up to 20 kill IDs
//                     &names=<id,...>            up to 20 character / corporation / alliance IDs (entity chips)
//
// Response: {kills: {killID: {status: 'ok', ...card data} | {status: 'queued'|'failed'|'full'|'unavailable'}},
//            names: {id: name}, namesPending: bool}. Ask again (with backoff) while a kill is 'queued' or names are pending.

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}
$sessionUserID = (int) $_SESSION['userID'];
$sessionCorporationID = isset($_SESSION['corporationID']) ? (int) $_SESSION['corporationID'] : 0;
$sessionAllianceID = isset($_SESSION['allianceID']) ? (int) $_SESSION['allianceID'] : 0;
$sessionMask = (string) $_SESSION['mask'];
session_write_close();

require_once('../config.php');
require_once('../db.inc.php');
require_once('../zkill/zkill.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

const ZKILL_KILL_MAX_NAMES = 20;
const ZKILL_KILL_MAX_ENTITY_ID = 2147483647;   // character / corporation / alliance IDs are 32-bit
const ZKILL_KILL_NAMES_BACKLOG = 200;          // asked-for names are only queued while fewer names than this are pending

function zkill_kill_fail($status, $message) {
	http_response_code($status);
	echo json_encode(array('error' => $message));
	exit();
}

/** Comma-separated list of positive IDs (at most 12 digits each, at most $max distinct); [] when absent */
function zkill_kill_ids($name, $max) {
	if (!isset($_GET[$name]) || $_GET[$name] === '') return array();
	$value = $_GET[$name];
	if (!is_string($value) || strlen($value) > $max * 14 + 20) zkill_kill_fail(400, "$name must be a comma-separated list of IDs");
	$ids = array();
	foreach (explode(',', $value) as $id) {
		$id = trim($id);
		if ($id === '') continue;
		if (!zk_lookup_valid_id($id)) zkill_kill_fail(400, "$name must be a comma-separated list of IDs");
		$ids[(int) $id] = true;
	}
	if (count($ids) > $max) zkill_kill_fail(400, "at most $max $name");
	return array_keys($ids);
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	zkill_kill_fail(405, 'GET only');
}

$killIDs = zkill_kill_ids('ids', ZK_LOOKUP_MAX_IDS);
$nameIDs = zkill_kill_ids('names', ZKILL_KILL_MAX_NAMES);
if (!$killIDs && !$nameIDs) zkill_kill_fail(400, 'ids or names is required');
// Character / corporation / alliance IDs are 32-bit: larger ones are skipped (not an error, so the kills still load)
$nameIDs = array_values(array_filter($nameIDs, function ($id) { return $id <= ZKILL_KILL_MAX_ENTITY_ID; }));

// "Our" side for the card colour: the character's corporation and alliance, the server's friendly corporations
// (as Kill Reporting) and the owner of the active corporation / alliance mask
$friendlyCorporations = array();
$friendlyAlliances = array();
if ($sessionCorporationID > 0) $friendlyCorporations[$sessionCorporationID] = true;
if ($sessionAllianceID > 0) $friendlyAlliances[$sessionAllianceID] = true;
$configured = defined('KILL_REPORT_FRIENDLY_CORPORATIONS') ? KILL_REPORT_FRIENDLY_CORPORATIONS : (getenv('KILL_REPORT_FRIENDLY_CORPORATIONS') ?: '');
foreach (preg_split('/[\s,]+/', (string) $configured, -1, PREG_SPLIT_NO_EMPTY) as $id) {
	if (ctype_digit($id) && (int) $id > 0) $friendlyCorporations[(int) $id] = true;
}
if (preg_match('/^(\d+)\.([23])$/', $sessionMask, $match) && (int) $match[1] > 0) {
	if ($match[2] === '2') $friendlyCorporations[(int) $match[1]] = true; else $friendlyAlliances[(int) $match[1]] = true;
}

if (!isset($mysql) || !($mysql instanceof PDO)) zkill_kill_fail(503, 'database unavailable');

try {
	$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
	$int = function ($value) { return $value === null ? null : (int) $value; };
	$kills = array();
	$wanted = array();   // IDs from stored killmails: always queued when unknown
	$lookup = $killIDs ? zk_with_schema($mysql, function ($db) use ($killIDs, $sessionUserID) {
		return zk_lookup_request($db, $killIDs, $sessionUserID);
	}) : array();
	foreach ($lookup as $killID => $entry) {
		if ($entry['status'] !== 'ok') {
			$kills[$killID] = array('status' => $entry['status']);
			continue;
		}
		$row = $entry['row'];
		$victimCorporation = $int($row['victimCorporationID']);
		$victimAlliance = $int($row['victimAllianceID']);
		$finalCorporation = $int($row['finalBlowCorporationID']);
		$finalAlliance = $int($row['finalBlowAllianceID']);
		$side = null;
		if (isset($friendlyCorporations[$victimCorporation]) || isset($friendlyAlliances[$victimAlliance])) $side = 'loss';
		elseif (isset($friendlyCorporations[$finalCorporation]) || isset($friendlyAlliances[$finalAlliance])) $side = 'kill';
		$kills[$killID] = array(
			'status' => 'ok',
			'killID' => $killID,
			'killTime' => zk_iso($row['killTime']),
			'systemID' => (int) $row['systemID'],
			'victim' => array(
				'characterID' => $int($row['victimCharacterID']),
				'corporationID' => $victimCorporation,
				'allianceID' => $victimAlliance,
				'shipTypeID' => $int($row['victimShipTypeID']),
			),
			'finalBlow' => array(
				'characterID' => $int($row['finalBlowCharacterID']),
				'corporationID' => $finalCorporation,
				'allianceID' => $finalAlliance,
				'shipTypeID' => $int($row['finalBlowShipTypeID']),
			),
			'attackers' => (int) $row['attackerTotal'],
			'pilots' => (int) $row['attackerCount'],
			'value' => (float) $row['totalValue'],
			'npc' => (bool) $row['npc'],
			'solo' => (bool) $row['solo'],
			'side' => $side,
		);
		foreach (array($row['victimCharacterID'], $victimCorporation, $victimAlliance, $row['victimShipTypeID'], $row['finalBlowShipTypeID']) as $id) {
			if ($id !== null) $wanted[] = (int) $id;
		}
	}
	[$names, $namesPending] = zk_with_schema($mysql, function ($db) use ($wanted, $nameIDs) {
		[$names, $pending] = zk_names_lookup($db, $wanted);
		// IDs from the browser (entity links in notes) can be anything: queue them only while the name queue is short,
		// so invalid IDs can't keep the worker's ESI name passes busy
		$asked = array_values(array_diff($nameIDs, array_keys($names)));
		if ($asked) {
			$backlog = (int) $db->query('SELECT COUNT(*) FROM zkill_names WHERE name IS NULL')->fetchColumn();
			[$more, $morePending] = zk_names_lookup($db, $asked, $backlog < ZKILL_KILL_NAMES_BACKLOG);
			$names += $more;
			$pending += $backlog < ZKILL_KILL_NAMES_BACKLOG ? $morePending : 0;
		}
		return [$names, $pending];
	});
	echo json_encode(array(
		'kills' => (object) $kills,
		'names' => (object) $names,
		// The worker resolves names only while the feed runs: with it off, pending names never arrive
		'namesPending' => $namesPending > 0 && zk_feed_enabled(),
	));
} catch (PDOException $error) {
	error_log('zkill_kill.php: ' . $error->getMessage());
	zkill_kill_fail(500, 'database error');
}
