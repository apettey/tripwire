<?php
//***********************************************************
//	File: 		fight.php
//	Author: 	Tripwire fork
//
//	Purpose:	The fleet comps of the current mask for "Fight here" (see docker/README.md#fight-here). Comps belong
//				to the corp mask and corporation-owned custom masks, like the Discord notifications: every member of
//				the session's mask reads them (also in public/rally.php's answer, without the mentions); only the
//				corporation's Tripwire admins (checkAdmin) change them, in Mask Admin > Fight here.
//
//				GET  ?mode=get                 -> {available, canEdit, comps, palette, limits, csrf (admins only), mask}
//				POST JSON {mode, ...}          -> comp-save {comp}, comp-delete {id}, comp-order {ids}
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

function fight_fail($code, $message, $errors = null) {
	http_response_code($code);
	echo json_encode($errors ? array('error' => $message, 'errors' => $errors) : array('error' => $message));
	exit();
}

$mask = (string) $_SESSION['mask'];
if (!isset($mysql) || !($mysql instanceof PDO)) fight_fail(500, 'Database error');
// The masks Discord notifications are for: the corporation mask or a custom mask owned by a corporation
$maskCorporation = discord_mask_corporation_db($mysql, $mask);
$sessionCorporation = isset($_SESSION['corporationID']) ? (int) $_SESSION['corporationID'] : 0;
$available = $maskCorporation !== null;
$canEdit = $available && $maskCorporation === $sessionCorporation && maskadmin_corp_admin($mask);
if ($canEdit && empty($_SESSION['fightCsrf'])) $_SESSION['fightCsrf'] = bin2hex(random_bytes(32));
$csrf = $canEdit ? $_SESSION['fightCsrf'] : '';
$characterName = isset($_SESSION['characterName']) ? (string) $_SESSION['characterName'] : '';
session_write_close();

try {
	$output = array();
	$method = $_SERVER['REQUEST_METHOD'];

	if ($method === 'GET') {
		$mode = isset($_GET['mode']) ? $_GET['mode'] : 'get';
		if ($mode !== 'get') fight_fail(400, 'Unknown mode');
	} else if ($method === 'POST') {
		if (!$available) fight_fail(403, 'Fleet comps are for your corporation\'s masks');
		if (!$canEdit) fight_fail(403, 'Only your corporation\'s Tripwire admins can change the fleet comps');
		// CSRF: per-session token in a custom header, plus same-origin check when the browser says where it comes from
		$token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
		if ($token === '' || !hash_equals($csrf, $token)) fight_fail(403, 'Invalid CSRF token: reload the page');
		if (strtolower(isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '') !== 'xmlhttprequest') fight_fail(400, 'Missing X-Requested-With header');
		if (stripos(isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '', 'application/json') !== 0) fight_fail(415, 'JSON only');
		if (!empty($_SERVER['HTTP_ORIGIN'])) {
			$originHost = strtolower((string) parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST) . (parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) ? ':' . parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) : ''));
			if ($originHost !== strtolower(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '')) fight_fail(403, 'Cross-origin request refused');
		}
		$input = json_decode(file_get_contents('php://input', false, null, 0, 65536), true);
		if (!is_array($input)) fight_fail(400, 'Invalid JSON');
		$mode = isset($input['mode']) ? $input['mode'] : '';
		if (!in_array($mode, array('comp-save', 'comp-delete', 'comp-order'), true)) fight_fail(400, 'Unknown mode');

		fight_ensure_schema($mysql);
		$mysql->beginTransaction();
		try {
			$comps = fight_comps_load($mysql, $mask, true);
			if ($mode === 'comp-save') {
				$comp = isset($input['comp']) && is_array($input['comp']) ? $input['comp'] : array();
				$editing = isset($comp['id']) && is_string($comp['id']) ? $comp['id'] : '';
				$at = -1;
				foreach ($comps as $i => $c) if ($c['id'] === $editing) $at = $i;
				if ($editing !== '' && $at < 0) { $mysql->rollBack(); fight_fail(404, 'That comp was removed meanwhile: reload the page'); }
				if ($at < 0 && count($comps) >= FIGHT_MAX_COMPS) { $mysql->rollBack(); fight_fail(400, 'At most ' . FIGHT_MAX_COMPS . ' fleet comps per mask'); }
				$others = $comps;
				if ($at >= 0) array_splice($others, $at, 1);
				list($saved, $errors) = fight_validate_comp($comp, $others);
				if ($errors) { $mysql->rollBack(); fight_fail(400, implode('; ', $errors), $errors); }
				if ($at >= 0) $comps[$at] = $saved; else $comps[] = $saved;
				$output['id'] = $saved['id'];
			} else if ($mode === 'comp-delete') {
				$id = isset($input['id']) && is_string($input['id']) ? $input['id'] : '';
				$before = count($comps);
				$comps = array_values(array_filter($comps, function ($c) use ($id) { return $c['id'] !== $id; }));
				if (count($comps) === $before) { $mysql->rollBack(); fight_fail(404, 'No such comp'); }
			} else {
				$ordered = fight_reorder($comps, isset($input['ids']) ? $input['ids'] : null);
				if ($ordered === null) { $mysql->rollBack(); fight_fail(409, 'The comps changed meanwhile: reload the page'); }
				$comps = $ordered;
			}
			fight_comps_save($mysql, $mask, $comps, $characterName);
			$mysql->commit();
		} catch (Throwable $error) {
			if ($mysql->inTransaction()) $mysql->rollBack();
			throw $error;
		}
		$output['result'] = true;
	} else {
		header('Allow: GET, POST');
		fight_fail(405, 'Method not allowed');
	}

	$output += array(
		'available' => $available,
		'canEdit' => $canEdit,
		'mask' => array('id' => $mask, 'name' => $available ? discord_mask_name($mysql, $mask) : ''),
		'comps' => $available ? fight_public_comps(fight_comps_load($mysql, $mask), $canEdit) : array(),
		'palette' => fight_palette(),
		'limits' => array('comps' => FIGHT_MAX_COMPS, 'name' => FIGHT_NAME_MAX, 'note' => FIGHT_NOTE_MAX),
	);
	if ($canEdit) $output['csrf'] = $csrf;
	echo json_encode($output);
} catch (PDOException $e) {
	error_log('fight.php: ' . $e->getMessage());
	fight_fail(500, 'Database error');
}
