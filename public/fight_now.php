<?php
// Fork-owned: Fight now markers on the chain map (app/js/fork/fight-now.js; see changes/2026-11-15-kill-type-tags).
//
// Read only: counts the player kills (NPC kills left out) the pooled zKillboard stream stored in zkill_killmails in
// the last hour, per system. Never calls zKillboard or ESI and queues nothing (the live stream has every kill).
//
//   GET fight_now.php?systems=<id,id,...>     up to 200 solar system IDs
//
// Response: { windowSeconds, feed: {enabled, live, ...} (zk_feed_status), systems: { "<systemID>": {kills, lastKill} } }
// with only the systems that had a kill.

if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}
session_write_close();

require_once('../config.php');
require_once('../db.inc.php');
require_once('../zkill/zkill.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

const FIGHT_NOW_MAX_SYSTEMS = 200;
const FIGHT_NOW_WINDOW = 3600;

function fight_now_fail($status, $message) {
	http_response_code($status);
	echo json_encode(array('error' => $message));
	exit();
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	fight_now_fail(405, 'GET only');
}

$systems = array();
$raw = isset($_GET['systems']) ? $_GET['systems'] : '';
if (!is_string($raw) || strlen($raw) > FIGHT_NOW_MAX_SYSTEMS * 9 + 100) fight_now_fail(400, 'systems must be a comma-separated list of system IDs');
foreach (explode(',', $raw) as $id) {
	$id = trim($id);
	if ($id === '') continue;
	if (!ctype_digit($id) || strlen($id) > 10 || !zk_is_system_id((int) $id)) fight_now_fail(400, 'systems must be a comma-separated list of solar system IDs');
	$systems[(int) $id] = true;
}
if (count($systems) > FIGHT_NOW_MAX_SYSTEMS) fight_now_fail(400, 'at most ' . FIGHT_NOW_MAX_SYSTEMS . ' systems');

if (!isset($mysql) || !($mysql instanceof PDO)) fight_now_fail(503, 'database unavailable');

try {
	$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
	$now = time();
	$counts = zk_fight_now($mysql, array_keys($systems), FIGHT_NOW_WINDOW, $now);
	$feed = zk_with_schema($mysql, function ($db) use ($now) { return zk_feed_status($db, $now); });
	echo json_encode(array('windowSeconds' => FIGHT_NOW_WINDOW, 'feed' => $feed, 'systems' => (object) $counts));
} catch (PDOException $error) {
	error_log('fight_now.php: ' . $error->getMessage());
	fight_now_fail(500, 'database error');
}
