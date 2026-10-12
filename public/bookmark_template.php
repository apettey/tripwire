<?php
//***********************************************************
//	File: 		bookmark_template.php
//	Author: 	Tripwire fork
//
//	Purpose:	The bookmark naming templates of the current mask (see docker/README.md#bookmark-names). Every member of
//				the session's mask reads them; only the mask's owner and the owning corporation's Tripwire admins
//				change them (Mask Admin > Bookmark names). The mask is always the session's: no request value names a mask.
//
//				GET  ?mode=get   -> {templates:{hole,back}, jumpPrompt, defaults, canEdit, updatedBy, updatedAt, mask, csrf (editors only)}
//				POST JSON {mode, ...} -> save {hole, back, jumpPrompt? (off | nomatch | always)}, reset
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
require_once('../bookmark/bookmark.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function bookmark_fail($code, $message, $errors = null) {
	http_response_code($code);
	echo json_encode($errors ? array('error' => $message, 'errors' => $errors) : array('error' => $message));
	exit();
}

if (!isset($mysql) || !($mysql instanceof PDO)) bookmark_fail(500, 'Database error');

$mask = (string) $_SESSION['mask'];   // already checked for blocks when db.inc.php was loaded
$actor = array('alliance' => isset($_SESSION['allianceID']) ? $_SESSION['allianceID'] : null, 'id' => (int) $_SESSION['characterID'], 'name' => isset($_SESSION['characterName']) ? (string) $_SESSION['characterName'] : '');
$method = $_SERVER['REQUEST_METHOD'];

try {
	$canEdit = bookmark_can_edit($mysql, $mask, $actor['id']);
	if ($canEdit && empty($_SESSION['bookmarkCsrf'])) $_SESSION['bookmarkCsrf'] = bin2hex(random_bytes(32));
	$csrf = $canEdit ? (string) $_SESSION['bookmarkCsrf'] : '';
	session_write_close();

	if ($method === 'GET') {
		$mode = isset($_GET['mode']) ? (string) $_GET['mode'] : 'get';
		if ($mode !== 'get') bookmark_fail(400, 'Unknown mode');
	} else if ($method === 'POST') {
		if (!$canEdit) bookmark_fail(403, 'Only the mask\'s owner and the owning corporation\'s Tripwire admins can change the bookmark names');
		$token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
		if ($token === '' || !hash_equals($csrf, $token)) bookmark_fail(403, 'Invalid CSRF token: reload the page');
		if (strtolower(isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '') !== 'xmlhttprequest') bookmark_fail(400, 'Missing X-Requested-With header');
		if (stripos(isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '', 'application/json') !== 0) bookmark_fail(415, 'JSON only');
		if (!empty($_SERVER['HTTP_ORIGIN'])) {
			$originHost = strtolower((string) parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST) . (parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) ? ':' . parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) : ''));
			if ($originHost !== strtolower(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '')) bookmark_fail(403, 'Cross-origin request refused');
		}
		$input = json_decode(file_get_contents('php://input', false, null, 0, 65536), true);
		if (!is_array($input)) bookmark_fail(400, 'Invalid JSON');
		$mode = isset($input['mode']) && is_string($input['mode']) ? $input['mode'] : '';
		if (!in_array($mode, array('save', 'reset'), true)) bookmark_fail(400, 'Unknown mode');

		bookmark_ensure_schema($mysql);
		if ($mode === 'save') {
			list($clean, $errors) = bookmark_validate_input($input);
			if ($errors) bookmark_fail(400, implode('; ', $errors), $errors);
			bookmark_save($mysql, $mask, $clean, $actor['name']);
			$detail = 'hole ' . $clean['hole'] . ' / return ' . $clean['back'] . (isset($clean['jumpPrompt']) ? ' / jump prompt ' . $clean['jumpPrompt'] : '');
		} else {
			bookmark_reset($mysql, $mask, $actor['name']);   // the jump prompt mode is kept
			$detail = 'built-in names';
		}
		try {   // shows in Mask Admin > Admins & members > Recent changes; the change itself already succeeded
			maskadmin_run($mysql, function () use ($mysql, $mask, $actor, $detail) { maskadmin_audit($mysql, $mask, $actor, 'bookmarks', 0, '', $detail); });
		} catch (PDOException $e) {
			error_log('bookmark_template.php audit: ' . $e->getMessage());
		}
	} else {
		header('Allow: GET, POST');
		bookmark_fail(405, 'Method not allowed');
	}

	try {
		list($templates, $by, $at, $jumpPrompt) = bookmark_load($mysql, $mask);
	} catch (PDOException $e) {
		if ($e->getCode() !== '42S02') throw $e;
		bookmark_ensure_schema($mysql);   // tables are created on first use
		list($templates, $by, $at, $jumpPrompt) = bookmark_load($mysql, $mask);
	}
	$output = array(
		'templates' => $templates, 'jumpPrompt' => $jumpPrompt, 'defaults' => bookmark_defaults(), 'canEdit' => $canEdit,
		'updatedBy' => $by, 'updatedAt' => $at, 'mask' => $mask,
	);
	if ($method === 'POST') $output['result'] = true;
	if ($canEdit) $output['csrf'] = $csrf;
	echo json_encode($output);
} catch (PDOException $e) {
	error_log('bookmark_template.php: ' . $e->getMessage());
	bookmark_fail(500, 'Database error');
}
