<?php

// Verify access via Tripwire signon
if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}

$fetch_data = array(
	'invasions' => array('url' => 'https://kybernaut.space/invasions.json', 'cache_file' => 'invasions.json', 'cache_for' => 3600),
// old thera	'thera' => array('url' => 'https://www.eve-scout.com/api/wormholes', 'cache_file' => 'thera.json', 'cache_for' => 60),
	'eve-scout-signatures' => array('url' => 'https://api.eve-scout.com/v2/public/signatures', 'cache_file' => 'thera.json', 'cache_for' => 300),
	'eve-scout-observations' => array('url' => 'https://api.eve-scout.com/v2/public/observations', 'cache_file' => 'eve-scout-observations.json', 'cache_for' => 600, 'refresh' => 'environment_tags_refresh'),	// fork: storms (environment tags)
	'fw' => array('url' => 'https://esi.evetech.net/fw/systems/?datasource=tranquility', 'cache_file' => 'fw.json', 'cache_for' => 3600),
)[is_string($_REQUEST['key'] ?? null) ? $_REQUEST['key'] : ''] ?? null; // fork: no warning for a missing/unknown key

if(!isset($fetch_data)) { 
	http_response_code(400);
	die(json_encode(array('reason' => 'Unknown cache key')));
}

// Fetch into cache if not set
$cache_file = dirname(dirname(__FILE__)) . '/cache/' . $fetch_data['cache_file'];
if (isset($fetch_data['refresh'])) { require_once(dirname(__DIR__) . '/environment_tags.inc.php'); if (!$fetch_data['refresh']($fetch_data['url'], $cache_file, $fetch_data['cache_for'])) { http_response_code(503); die('[]'); } }	// fork: own fetch, strip, atomic write
else if (!file_exists($cache_file) || (time() - filemtime($cache_file) >= $fetch_data['cache_for'])){
	require_once(dirname(__DIR__) . '/esi/esi.inc.php');	// fork: ESI compatibility date + rate limits; other URLs: plain fopen
	$in_resource = esi_open_url($fetch_data['url'], $cache_file);
	if($in_resource) file_put_contents($cache_file, $in_resource);
	else { 
		http_response_code(500);
		error_log('cached_third_party ' . $_REQUEST['key'] . ': ' . print_r(error_get_last(), true)); die(json_encode(array('reason' => 'Fetch failed'))); // fork: details to the log, not the browser
	}
}

header('Content-Type: application/json');
readfile($cache_file);