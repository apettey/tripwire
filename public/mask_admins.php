<?php
//***********************************************************
//	File: 		mask_admins.php
//	Author: 	Tripwire fork
//
//	Purpose:	Mask Admin > Admins & members (see docker/README.md#mask-admins): several admins per mask, removing and
//				blocking members, and mask-wide default settings. All logic is in maskadmin/maskadmin.inc.php.
//				The mask is always the session's mask: no request value names a mask, so there is nothing to point at
//				another mask's rows.
//
//				GET  ?mode=get[&q=name]   -> the tab's data for admins (+ csrf); {canAdmin:false} for everybody else
//				GET  ?mode=defaults       -> {defaults, updatedBy, updatedAt}: the session mask's default settings (every member)
//				POST JSON {mode, ...}     -> grant {characterID}, revoke {characterID}, block {characterID, reason},
//				                             unblock {characterID}, remove {characterID}, defaults-save {defaults}, defaults-clear
//				POSTs need the X-CSRF-Token header (token from mode=get, per session), X-Requested-With: XMLHttpRequest,
//				Content-Type: application/json and, if the browser sends Origin, this host.
//***********************************************************

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask']) || !isset($_SESSION['characterID'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../lib.inc.php');
require_once('../maskadmin/maskadmin.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function maskadmin_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

if (!isset($mysql) || !($mysql instanceof PDO)) maskadmin_fail(500, 'Database error');

$mask = (string) $_SESSION['mask'];   // already checked for blocks when db.inc.php was loaded
$actor = array('alliance' => isset($_SESSION['allianceID']) ? $_SESSION['allianceID'] : null, 'id' => (int) $_SESSION['characterID'], 'name' => isset($_SESSION['characterName']) ? (string) $_SESSION['characterName'] : '');
$method = $_SERVER['REQUEST_METHOD'];
$csrfSession = isset($_SESSION['maskAdminCsrf']) ? (string) $_SESSION['maskAdminCsrf'] : '';

try {
	maskadmin_run($mysql, function () use ($mysql) { $mysql->query('SELECT 1 FROM fork_mask_audit LIMIT 1'); });

	$canAdmin = maskadmin_is_admin($mysql, $mask, $actor['id'], $actor['alliance']);
	if ($canAdmin && $csrfSession === '') {
		$csrfSession = bin2hex(random_bytes(32));
		$_SESSION['maskAdminCsrf'] = $csrfSession;
	}
	session_write_close();

	if ($method === 'GET') {
		$mode = isset($_GET['mode']) ? (string) $_GET['mode'] : 'get';
		if ($mode === 'defaults') {
			$d = maskadmin_defaults_load($mysql, $mask);
			echo json_encode(array('mask' => $mask, 'defaults' => $d['defaults'], 'updatedBy' => $d['updatedBy'], 'updatedAt' => $d['updatedAt']));
			exit();
		}
		if ($mode !== 'get') maskadmin_fail(400, 'Unknown mode');
		$output = maskadmin_state($mysql, $mask, $actor['id'], isset($_GET['q']) ? maskadmin_clean_text($_GET['q'], 50) : '', $actor['alliance']);
		if ($canAdmin) $output['csrf'] = $csrfSession;
		echo json_encode($output);
		exit();
	}

	if ($method !== 'POST') {
		header('Allow: GET, POST');
		maskadmin_fail(405, 'Method not allowed');
	}
	if (!$canAdmin) maskadmin_fail(403, 'Only mask admins can change this');
	// CSRF: per-session token in a custom header, plus same-origin check when the browser says where it comes from
	$token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
	if ($token === '' || $csrfSession === '' || !hash_equals($csrfSession, $token)) maskadmin_fail(403, 'Invalid CSRF token: reload the page');
	if (strtolower(isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '') !== 'xmlhttprequest') maskadmin_fail(400, 'Missing X-Requested-With header');
	if (stripos(isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '', 'application/json') !== 0) maskadmin_fail(415, 'JSON only');
	if (!empty($_SERVER['HTTP_ORIGIN'])) {
		$originHost = strtolower((string) parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST) . (parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) ? ':' . parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) : ''));
		if ($originHost !== strtolower(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '')) maskadmin_fail(403, 'Cross-origin request refused');
	}
	$input = json_decode(file_get_contents('php://input', false, null, 0, 65536), true);
	if (!is_array($input)) maskadmin_fail(400, 'Invalid JSON');
	$mode = isset($input['mode']) && is_string($input['mode']) ? $input['mode'] : '';

	$targetID = 0;
	if (in_array($mode, array('grant', 'revoke', 'block', 'unblock', 'remove'), true)) {
		$raw = isset($input['characterID']) ? $input['characterID'] : null;
		if (is_string($raw) && ctype_digit($raw) && strlen($raw) <= 10) $raw = (int) $raw;
		if (!is_int($raw) || $raw <= 0 || $raw > 2147483647) maskadmin_fail(400, 'characterID required');
		$targetID = $raw;
	}

	switch ($mode) {
		case 'grant':   $result = maskadmin_grant($mysql, $mask, $actor, $targetID); break;
		case 'revoke':  $result = maskadmin_revoke($mysql, $mask, $actor, $targetID); break;
		case 'block':   $result = maskadmin_block($mysql, $mask, $actor, $targetID, isset($input['reason']) && is_string($input['reason']) ? $input['reason'] : ''); break;
		case 'unblock': $result = maskadmin_unblock($mysql, $mask, $actor, $targetID); break;
		case 'remove':  $result = maskadmin_remove($mysql, $mask, $actor, $targetID); break;
		case 'defaults-save':
			$result = maskadmin_defaults_save($mysql, $mask, $actor, isset($input['defaults']) ? $input['defaults'] : null);
			break;
		case 'defaults-clear': $result = maskadmin_defaults_save($mysql, $mask, $actor, array()); break;
		default: maskadmin_fail(400, 'Unknown mode');
	}
	if (!$result[0]) maskadmin_fail($result[2], $result[1]);

	$output = maskadmin_state($mysql, $mask, $actor['id'], '', $actor['alliance']);
	$output['result'] = true;
	$output['csrf'] = $csrfSession;
	echo json_encode($output);
} catch (PDOException $e) {
	error_log('mask_admins.php: ' . $e->getMessage());
	maskadmin_fail(500, 'Database error');
}
