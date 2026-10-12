<?php
//***********************************************************
//	File: 		jump_link.php
//	Author: 	Tripwire fork
//
//	Purpose:	"Which signature did you jump through?" (see docker/README.md#bookmark-names): links a scanned signature to the jump
//				a bare automapped hole stands for, and undoes such a link, each as one transaction (jumplink/jumplink.inc.php).
//				Any member of the session's mask may use it (like editing a signature); the mask is always the session's mask and the
//				mask's jump prompt mode is read from the server (a mask that turned the prompt off refuses links).
//
//				GET  ?mode=token                    -> {csrf, jumpPrompt}
//				POST JSON {mode:"link", bareID, candidateSigID} -> {result, linkId, wormholeID, moved, carried}
//				POST JSON {mode:"unlink", linkId}                -> {result, bareID, moved}
//				POSTs need the X-CSRF-Token header (token from mode=token, per session), X-Requested-With: XMLHttpRequest,
//				Content-Type: application/json and, if the browser sends Origin, this host. Refusals say why in {error}.
//***********************************************************

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask']) || !isset($_SESSION['characterID'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../lib.inc.php');
require_once('../jumplink/jumplink.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function jumplink_http_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

if (!isset($mysql) || !($mysql instanceof PDO)) jumplink_http_fail(500, 'Database error');

$mask = (string) $_SESSION['mask'];   // already checked for blocks when db.inc.php was loaded
$actor = array('id' => (int) $_SESSION['characterID'], 'name' => isset($_SESSION['characterName']) ? (string) $_SESSION['characterName'] : '');
if (empty($_SESSION['jumpLinkCsrf'])) $_SESSION['jumpLinkCsrf'] = bin2hex(random_bytes(32));
$csrf = (string) $_SESSION['jumpLinkCsrf'];
session_write_close();

try {
	bookmark_ensure_schema($mysql);
	list(, , , $jumpPrompt) = bookmark_load($mysql, $mask);
	$method = $_SERVER['REQUEST_METHOD'];

	if ($method === 'GET') {
		if ((isset($_GET['mode']) ? $_GET['mode'] : 'token') !== 'token') jumplink_http_fail(400, 'Unknown mode');
		echo json_encode(array('csrf' => $csrf, 'jumpPrompt' => $jumpPrompt));
		exit();
	}
	if ($method !== 'POST') {
		header('Allow: GET, POST');
		jumplink_http_fail(405, 'Method not allowed');
	}

	$token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
	if ($token === '' || !hash_equals($csrf, $token)) jumplink_http_fail(403, 'Invalid CSRF token: reload the page');
	if (strtolower(isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '') !== 'xmlhttprequest') jumplink_http_fail(400, 'Missing X-Requested-With header');
	if (stripos(isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '', 'application/json') !== 0) jumplink_http_fail(415, 'JSON only');
	if (!empty($_SERVER['HTTP_ORIGIN'])) {
		$originHost = strtolower((string) parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST) . (parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) ? ':' . parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) : ''));
		if ($originHost !== strtolower(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '')) jumplink_http_fail(403, 'Cross-origin request refused');
	}
	$input = json_decode(file_get_contents('php://input', false, null, 0, 65536), true);
	if (!is_array($input)) jumplink_http_fail(400, 'Invalid JSON');
	$mode = isset($input['mode']) && is_string($input['mode']) ? $input['mode'] : '';
	$int = function ($key) use ($input) {
		$v = isset($input[$key]) ? $input[$key] : null;
		if (is_string($v) && ctype_digit($v) && strlen($v) <= 10) $v = (int) $v;
		return is_int($v) && $v > 0 && $v <= 2147483647 ? $v : 0;
	};

	jumplink_ensure_schema($mysql);
	if ($mode === 'link') {
		$result = jumplink_link($mysql, $mask, $actor, $int('bareID'), $int('candidateSigID'), $jumpPrompt);
	} else if ($mode === 'unlink') {
		$result = jumplink_unlink($mysql, $mask, $actor, $int('linkId'));
	} else {
		jumplink_http_fail(400, 'Unknown mode');
	}
	if (!$result[0]) jumplink_http_fail($result[2], $result[1]);
	echo json_encode(array('result' => true) + $result[3]);
} catch (PDOException $e) {
	error_log('jump_link.php: ' . $e->getMessage());
	jumplink_http_fail(500, 'Database error');
}
