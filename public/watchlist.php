<?php
//***********************************************************
//	File: 		watchlist.php
//	Author: 	Tripwire fork
//
//	Purpose:	The watchlist filters of the current mask (see docker/README.md#watchlist). Filters belong to the
//				corp mask and corporation-owned custom masks, like the Discord notifications: every member of the
//				session's mask reads them; only the corporation's Tripwire admins (checkAdmin) change them.
//
//				GET  ?mode=get                 -> {available, canEdit, filters, csrf (admins only), mask}
//				POST JSON {mode, ...}          -> filter-save {filter}, filter-delete {id}, filter-enable {id, enabled}
//				POSTs need the X-CSRF-Token header (token from mode=get, per session), X-Requested-With:
//				XMLHttpRequest, Content-Type: application/json and, if the browser sends Origin, this host.
//***********************************************************

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../lib.inc.php');
require_once('../discord/discord.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function watchlist_fail($code, $message, $errors = null) {
	http_response_code($code);
	echo json_encode($errors ? array('error' => $message, 'errors' => $errors) : array('error' => $message));
	exit();
}

$mask = (string) $_SESSION['mask'];
if (!isset($mysql) || !($mysql instanceof PDO)) watchlist_fail(500, 'Database error');
// The masks Discord notifications are for: the corporation mask or a custom mask owned by a corporation
$maskCorporation = discord_mask_corporation_db($mysql, $mask);
$sessionCorporation = isset($_SESSION['corporationID']) ? (int) $_SESSION['corporationID'] : 0;
$available = $maskCorporation !== null;
$canEdit = $available && $maskCorporation === $sessionCorporation && maskadmin_corp_admin($mask);
if ($canEdit && empty($_SESSION['watchlistCsrf'])) $_SESSION['watchlistCsrf'] = bin2hex(random_bytes(32));
$csrf = $canEdit ? $_SESSION['watchlistCsrf'] : '';
$characterName = isset($_SESSION['characterName']) ? (string) $_SESSION['characterName'] : '';
session_write_close();

try {
	$output = array();
	$method = $_SERVER['REQUEST_METHOD'];
	if ($available) watchlist_ensure_schema($mysql);

	if ($method === 'GET') {
		$mode = isset($_GET['mode']) ? $_GET['mode'] : 'get';
		if ($mode !== 'get') watchlist_fail(400, 'Unknown mode');
	} else if ($method === 'POST') {
		if (!$available) watchlist_fail(403, 'Watchlist filters are for your corporation\'s masks');
		if (!$canEdit) watchlist_fail(403, 'Only your corporation\'s Tripwire admins can change the watchlist');
		// CSRF: per-session token in a custom header, plus same-origin check when the browser says where it comes from
		$token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
		if ($token === '' || !hash_equals($csrf, $token)) watchlist_fail(403, 'Invalid CSRF token: reload the page');
		if (strtolower(isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '') !== 'xmlhttprequest') watchlist_fail(400, 'Missing X-Requested-With header');
		if (stripos(isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '', 'application/json') !== 0) watchlist_fail(415, 'JSON only');
		if (!empty($_SERVER['HTTP_ORIGIN'])) {
			$originHost = strtolower((string) parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST) . (parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) ? ':' . parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) : ''));
			if ($originHost !== strtolower(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '')) watchlist_fail(403, 'Cross-origin request refused');
		}
		$input = json_decode(file_get_contents('php://input', false, null, 0, 65536), true);
		if (!is_array($input)) watchlist_fail(400, 'Invalid JSON');
		$mode = isset($input['mode']) ? $input['mode'] : '';
		if (!in_array($mode, array('filter-save', 'filter-delete', 'filter-enable'), true)) watchlist_fail(400, 'Unknown mode');

		$mysql->beginTransaction();
		try {
			$filters = watchlist_load($mysql, $mask, true);
			$id = isset($input['id']) && is_string($input['id']) ? $input['id'] : '';
			$index = -1;
			foreach ($filters as $i => $f) if ($f['id'] === $id) $index = $i;
			if ($mode === 'filter-save') {
				$filter = isset($input['filter']) && is_array($input['filter']) ? $input['filter'] : array();
				$editing = isset($filter['id']) && is_string($filter['id']) ? $filter['id'] : '';
				$at = -1;
				foreach ($filters as $i => $f) if ($f['id'] === $editing) $at = $i;
				if ($at < 0 && count($filters) >= WATCHLIST_MAX_FILTERS) { $mysql->rollBack(); watchlist_fail(400, 'At most ' . WATCHLIST_MAX_FILTERS . ' filters per mask'); }
				list($saved, $errors) = watchlist_validate_filter($filter, $filters, watchlist_data(), $characterName);
				if ($errors) { $mysql->rollBack(); watchlist_fail(400, implode('; ', $errors), $errors); }
				if ($at >= 0) $filters[$at] = $saved; else $filters[] = $saved;
				$output['id'] = $saved['id'];
			} else {
				if ($index < 0) { $mysql->rollBack(); watchlist_fail(404, 'No such filter'); }
				if ($mode === 'filter-delete') {
					array_splice($filters, $index, 1);
				} else {
					$on = isset($input['enabled']) && $input['enabled'] === true;
					// Turning a filter on is like saving it: what is already on the chain isn't announced in Discord
					if ($on && !$filters[$index]['enabled']) $filters[$index]['updatedAt'] = time();
					$filters[$index]['enabled'] = $on;
					$filters[$index]['updatedBy'] = mb_substr($characterName, 0, 100);
				}
			}
			watchlist_save($mysql, $mask, $filters, $characterName);
			$mysql->commit();
		} catch (Throwable $error) {
			if ($mysql->inTransaction()) $mysql->rollBack();
			throw $error;
		}
		$output['result'] = true;
	} else {
		header('Allow: GET, POST');
		watchlist_fail(405, 'Method not allowed');
	}

	$output += array(
		'available' => $available,
		'canEdit' => $canEdit,
		'mask' => array('id' => $mask, 'name' => $available ? discord_mask_name($mysql, $mask) : ''),
		'filters' => $available ? watchlist_public_filters(watchlist_load($mysql, $mask)) : array(),
	);
	if ($canEdit) $output['csrf'] = $csrf;
	echo json_encode($output);
} catch (PDOException $e) {
	error_log('watchlist.php: ' . $e->getMessage());
	watchlist_fail(500, 'Database error');
}
