<?php
// Fork-owned: prices of the items in wormhole gas and ore sites (see changes/2026-11-15-site-value-estimate and
// market_prices.inc.php). Browsers never call ESI for these: the server keeps one copy, refreshed at most hourly.
//
//   GET market_prices.php
// Response: {prices: {typeID: ISK}, fetched (unix seconds, 0 = no copy yet), now}

if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}
session_write_close();

require_once('../market_prices.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
	header('Allow: GET');
	http_response_code(405);
	echo json_encode(array('error' => 'GET only'));
	exit();
}

$result = market_prices_get();
$result['now'] = time();
echo json_encode($result);
