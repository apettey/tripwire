<?php
// Fork-owned: System Threat endpoint (see changes/2026-10-10-system-threat and docker/README.md#zkillboard-integration).
//
// Never calls zKillboard or ESI: it reads the cached per-system zKillboard stats (zkill_system_stats) and the kills
// the stream keeps (zkill_killmails), and queues missing / stale stats (plus, for the viewed system, a back-fill and
// unknown names) for zkill_feed.worker.php. Queueing is bounded (real systems only, global and per-user caps).
//
//   GET system_threat.php?systems=<id,id,...>   chain badges: up to 200 systems
//       &systemID=<id>                          the viewed system: also returns `detail` (residents, structure losses)
//       &queue=0|1                              0 = read only, queue nothing (default 1)
//
// Response: see zk_system_threat() in zkill/threat.php. Re-poll while `pending` is true.

if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}
$sessionUserID = (int) $_SESSION['userID'];
session_write_close();

require_once('../config.php');
require_once('../db.inc.php');
require_once('../zkill/zkill.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

const SYSTEM_THREAT_MAX_SYSTEMS = 200;

function system_threat_fail($status, $message) {
	http_response_code($status);
	echo json_encode(array('error' => $message));
	exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	system_threat_fail(405, 'GET only');
}

$systems = array();
$detail = null;
if (isset($_GET['systemID']) && $_GET['systemID'] !== '') {
	$id = $_GET['systemID'];
	if (!is_string($id) || !ctype_digit($id) || strlen($id) > 10 || !zk_is_system_id((int) $id)) system_threat_fail(400, 'systemID is not a solar system ID');
	$detail = (int) $id;
}
if (isset($_GET['systems']) && $_GET['systems'] !== '') {
	if (!is_string($_GET['systems']) || strlen($_GET['systems']) > SYSTEM_THREAT_MAX_SYSTEMS * 9 + 100) system_threat_fail(400, 'systems must be a comma-separated list of system IDs');
	foreach (explode(',', $_GET['systems']) as $id) {
		$id = trim($id);
		if ($id === '') continue;
		if (!ctype_digit($id) || strlen($id) > 10 || !zk_is_system_id((int) $id)) system_threat_fail(400, 'systems must be a comma-separated list of solar system IDs');
		$systems[(int) $id] = true;
	}
}
if (!$systems && $detail === null) system_threat_fail(400, 'systemID or systems is required');
if (count($systems) > SYSTEM_THREAT_MAX_SYSTEMS) system_threat_fail(400, 'at most ' . SYSTEM_THREAT_MAX_SYSTEMS . ' systems');
if ($detail !== null) unset($systems[$detail]);

$queue = isset($_GET['queue']) && $_GET['queue'] !== '' ? $_GET['queue'] : '1';
if ($queue !== '0' && $queue !== '1') system_threat_fail(400, 'queue must be 0 or 1');

if (!isset($mysql) || !($mysql instanceof PDO)) system_threat_fail(503, 'database unavailable');

try {
	$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
	echo json_encode(zk_system_threat($mysql, array_keys($systems), array(
		'queue' => $queue === '1',
		'userID' => $sessionUserID,
		'detail' => $detail,
	)));
} catch (PDOException $error) {
	error_log('system_threat.php: ' . $error->getMessage());
	system_threat_fail(500, 'database error');
}
