<?php
// Fork-owned: System Kill Feed endpoint (see changes/ and docker/README.md#zkillboard-integration).
//
// Never calls zKillboard or ESI: it reads zkill_killmails / zkill_names and, when a system's window is not covered
// yet, queues a back-fill (and unknown names) for zkill_feed.worker.php. Queueing is bounded (real systems only,
// global and per-user caps), so this GET's only side effect is a deduplicated queue row.
//
//   GET system_kills.php?systemID=<id>                     one system
//   GET system_kills.php?systems=<id,id,...>               up to 200 systems (may be combined with systemID)
//       &pastSeconds=<n>   window, 60..retention (default and upper bound: ZKILL_RETENTION_HOURS; longer is clamped)
//       &limit=<n>         kills returned over all systems, 1..50 (default 20)
//       &since=<cursor>    incremental: only kills stored after this cursor, in stored order (by id, not kill time:
//                          sort by killTime yourself); continue with `cursor` from the answer
//       &source=panel|chain  back-fill priority (chain outranks panel; default panel)
//       &queue=0|1         0 = read only, queue nothing (default 1)
//
// Response: see zk_system_kills() in zkill/query.php. Re-poll while `pending` or `namesPending` is true.

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

const SYSTEM_KILLS_MAX_SYSTEMS = 200;
const SYSTEM_KILLS_MAX_LIMIT   = 50;

function system_kills_fail($status, $message) {
	http_response_code($status);
	echo json_encode(array('error' => $message));
	exit();
}

/** Non-negative integer query parameter (digits only), or $default when absent */
function system_kills_int($name, $default, $maxDigits) {
	if (!isset($_GET[$name]) || $_GET[$name] === '') return $default;
	$value = $_GET[$name];
	if (!is_string($value) || !ctype_digit($value) || strlen($value) > $maxDigits) system_kills_fail(400, "$name must be a non-negative integer");
	return (int) $value;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	system_kills_fail(405, 'GET only');
}

$systems = array();
$single = system_kills_int('systemID', null, 10);
if ($single !== null) {
	if (!zk_is_system_id($single)) system_kills_fail(400, 'systemID is not a solar system ID');
	$systems[$single] = true;
}
if (isset($_GET['systems']) && $_GET['systems'] !== '') {
	if (!is_string($_GET['systems']) || strlen($_GET['systems']) > SYSTEM_KILLS_MAX_SYSTEMS * 9 + 100) system_kills_fail(400, 'systems must be a comma-separated list of system IDs');
	foreach (explode(',', $_GET['systems']) as $id) {
		$id = trim($id);
		if ($id === '') continue;
		if (!ctype_digit($id) || strlen($id) > 10 || !zk_is_system_id((int) $id)) system_kills_fail(400, 'systems must be a comma-separated list of solar system IDs');
		$systems[(int) $id] = true;
	}
}
if (!$systems) system_kills_fail(400, 'systemID or systems is required');
if (count($systems) > SYSTEM_KILLS_MAX_SYSTEMS) system_kills_fail(400, 'at most ' . SYSTEM_KILLS_MAX_SYSTEMS . ' systems');

$retention = zk_retention_seconds();
$pastSeconds = system_kills_int('pastSeconds', $retention, 9);
if ($pastSeconds < 60) system_kills_fail(400, 'pastSeconds must be at least 60');
$pastSeconds = min($pastSeconds, $retention);

$limit = system_kills_int('limit', 20, 3);
if ($limit < 1 || $limit > SYSTEM_KILLS_MAX_LIMIT) system_kills_fail(400, 'limit must be 1..' . SYSTEM_KILLS_MAX_LIMIT);

$since = system_kills_int('since', null, 18);

$source = isset($_GET['source']) && $_GET['source'] !== '' ? $_GET['source'] : 'panel';
if (!is_string($source) || !isset(ZK_BACKFILL_PRIORITY[$source])) system_kills_fail(400, 'source must be panel or chain');

$queue = system_kills_int('queue', 1, 1);
if ($queue > 1) system_kills_fail(400, 'queue must be 0 or 1');

if (!isset($mysql) || !($mysql instanceof PDO)) system_kills_fail(503, 'database unavailable');

try {
	$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
	echo json_encode(zk_system_kills($mysql, array_keys($systems), $pastSeconds, $limit, array(
		'queue' => $queue === 1,
		'source' => $source,
		'userID' => $sessionUserID,
		'since' => $since,
	)));
} catch (PDOException $error) {
	error_log('system_kills.php: ' . $error->getMessage());
	system_kills_fail(500, 'database error');
}
