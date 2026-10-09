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
	'fw' => array('url' => 'https://esi.evetech.net/latest/fw/systems/?datasource=tranquility', 'cache_file' => 'fw.json', 'cache_for' => 3600),
)[$_REQUEST['key']];

if(!isset($fetch_data)) { 
	http_response_code(400);
	die(json_encode(array(reason => 'Unknown cache key')));
}

// Fetch into cache if not set
$cache_file = dirname(dirname(__FILE__)) . '/cache/' . $fetch_data['cache_file'];
if (!file_exists($cache_file) || (time() - filemtime($cache_file) >= $fetch_data['cache_for'])){
	$in_resource = fopen( $fetch_data['url'], 'r');
	if($in_resource) file_put_contents($cache_file, $in_resource);
	else { 
		http_response_code(500);
		die(print_r(error_get_last(), true));
	}
}

header('Content-Type: application/json');
readfile($cache_file);