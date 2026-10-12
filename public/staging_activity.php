<?php
// Fork-owned: Staging scan endpoint (see changes/2026-10-12-staging-scan and docker/README.md#staging-scan).
//
// GET staging_activity.php -> the last 24 hours of upstream's hourly system_activity table (written by
// system_activity.cron.php from ESI), summed per system:
//   {"hours": 24, "generated": <unix time>, "systems": {"<systemID>": [shipJumps, shipKills, podKills, npcKills, activeHours], ...}}
// activeHours = hours with any ship jumps. Only systems with some activity are listed.
// No ESI or third-party calls. One GROUP BY per hour and cron run (file cache in cache/), and browsers may reuse the answer until
// the next full hour (the client adds ?h=<UTC hour> so a new hour asks again).

if (!session_id()) session_start();

if (!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}
session_write_close();

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	http_response_code(405);
	echo json_encode(array('error' => 'GET only'));
	exit();
}

const STAGING_ACTIVITY_HOURS = 24;

$now = time();
$hourKey = gmdate('YmdH', $now);
// Until a few minutes into the next hour: the cron writes at :00
$maxAge = max(60, 3600 - ($now % 3600) + 120);
header('Cache-Control: private, max-age=' . $maxAge);
header('Expires: ' . gmdate('D, d M Y H:i:s', $now + $maxAge) . ' GMT');

require_once('../config.php');
require_once('../db.inc.php');

// The cache is for this hour and the newest cron row (the cron writes at :00, maybe after the first request of the hour)
try {
	$latest = (string) $mysql->query('SELECT MAX(time) FROM system_activity')->fetchColumn();
} catch (PDOException $e) {
	$latest = '';
}
$cacheKey = $hourKey . '|' . $latest;
$cacheDir = dirname(dirname(__FILE__)) . '/cache';
$cacheFile = $cacheDir . '/staging-activity.json';

if (is_readable($cacheFile)) {
	$cached = @file_get_contents($cacheFile);
	$decoded = $cached !== false ? json_decode($cached, true) : null;
	if (is_array($decoded) && isset($decoded['key']) && $decoded['key'] === $cacheKey && isset($decoded['body'])) {
		echo $decoded['body'];
		exit();
	}
}

$query = 'SELECT systemID, SUM(shipJumps) AS j, SUM(shipKills) AS sk, SUM(podKills) AS pk, SUM(npcKills) AS nk,
		SUM(shipJumps > 0) AS ah
	FROM system_activity
	WHERE time > NOW() - INTERVAL ' . STAGING_ACTIVITY_HOURS . ' HOUR
	GROUP BY systemID';
$systems = array();
try {
	$stmt = $mysql->prepare($query);
	$stmt->execute();
	while ($row = $stmt->fetch(PDO::FETCH_NUM)) {
		$counts = array((int) $row[1], (int) $row[2], (int) $row[3], (int) $row[4], (int) $row[5]);
		if (array_sum($counts) === 0) continue;
		$systems[(string) (int) $row[0]] = $counts;
	}
} catch (PDOException $e) {
	error_log('[tripwire] staging_activity: ' . $e->getMessage());
	header('Cache-Control: no-store');
	http_response_code(500);
	echo json_encode(array('error' => 'Activity data is not available'));
	exit();
}

$body = json_encode(array(
	'hours' => STAGING_ACTIVITY_HOURS,
	'generated' => $now,
	'systems' => $systems ? $systems : new stdClass()
));

// Only cache an answer with data: right after start-up the cron may not have run yet
if ($systems && is_dir($cacheDir) && is_writable($cacheDir)) {
	$tmp = $cacheFile . '.' . getmypid() . '.tmp';
	if (@file_put_contents($tmp, json_encode(array('key' => $cacheKey, 'body' => $body))) !== false) {
		@rename($tmp, $cacheFile);
	} else {
		@unlink($tmp);
	}
}

echo $body;
