<?php
//***********************************************************
//	File: 		api_tokens.php
//	Author: 	Tripwire fork
//
//	Purpose:	Management of the REST API's personal access tokens (docker/README.md#rest-api): Settings > General > API tokens
//				(your tokens) and Mask Admin > API tokens (the tokens of the mask). The API itself is public/api.php.
//
//				GET  -> {enabled, max, csrf, mask:{id,label}, canCreate, reason, tokens:[yours], admin, maskTokens:[the mask's, admins only]}
//				POST JSON {mode:"create", name, expiresDays (1-365 or null)} -> the same + {token: "twp_..."} (shown once)
//				     JSON {mode:"revoke", id}  -> the same. Your own token, or any token of a mask you are admin of.
//				POSTs need the X-CSRF-Token header (token from GET, per session), X-Requested-With: XMLHttpRequest, Content-Type:
//				application/json and, if the browser sends Origin, this host (the pattern of public/fight.php).
//				A new token is always for the session's mask (never a request value) and the session's character.
//				Create and revoke are recorded in the mask's audit log (Mask Admin > Audit).
//***********************************************************

if (!session_id()) session_start();

if (!isset($_SESSION['userID']) || !isset($_SESSION['mask']) || !isset($_SESSION['characterID'])) {
	http_response_code(403);
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');
require_once('../lib.inc.php');
require_once('../api/tokens.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function api_tokens_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

if (!isset($mysql) || !($mysql instanceof PDO)) api_tokens_fail(500, 'Database error');

$userID = (int) $_SESSION['userID'];
$characterID = (int) $_SESSION['characterID'];
$characterName = isset($_SESSION['characterName']) ? (string) $_SESSION['characterName'] : '';
$allianceID = isset($_SESSION['allianceID']) ? $_SESSION['allianceID'] : null;
$mask = (string) $_SESSION['mask'];
if (empty($_SESSION['apiTokenCsrf'])) $_SESSION['apiTokenCsrf'] = bin2hex(random_bytes(32));
$csrf = $_SESSION['apiTokenCsrf'];
session_write_close();

/** Names for the masks of the listed tokens: custom masks by name, the default masks by kind */
function api_tokens_labels(PDO $db, array $rows) {
	$labels = array();
	foreach ($rows as $r) {
		$m = (string) $r['maskID'];
		if (isset($labels[$m])) continue;
		if ($m === '0.0') { $labels[$m] = 'Public mask'; continue; }
		$type = substr($m, -1);
		if ($type === '0') {
			$row = maskadmin_mask_row($db, $m);
			$labels[$m] = $row ? $row['name'] : 'Mask ' . $m;
		} else if ($type === '1') {
			$labels[$m] = 'Personal mask';
		} else if ($type === '2') {
			$stmt = $db->prepare('SELECT corporationName FROM characters WHERE corporationID = ? LIMIT 1');
			$stmt->execute(array((int) $m));
			$name = $stmt->fetchColumn();
			$labels[$m] = $name ? $name . ' (corporation mask)' : 'Corporation mask';
		} else {
			$labels[$m] = 'Alliance mask';
		}
	}
	return $labels;
}

function api_tokens_public_list(PDO $db, array $rows, $now, $withIP) {
	$labels = api_tokens_labels($db, $rows);
	$out = array();
	foreach ($rows as $r) {
		$p = api_token_public($r, $now, $withIP);
		$p['maskLabel'] = $labels[(string) $r['maskID']];
		$out[] = $p;
	}
	return $out;
}

/** Audit entry in the token's mask (Mask Admin > Audit). Never breaks the request. */
function api_tokens_audit(PDO $db, $mask, $action, $actorID, $actorName, $ownerID, $ownerName, $tokenName) {
	try {
		maskadmin_run($db, function () use ($db, $mask, $action, $actorID, $actorName, $ownerID, $ownerName, $tokenName) {
			maskadmin_audit($db, $mask, array('id' => $actorID, 'name' => $actorName), $action, $ownerID, $ownerName, '"' . $tokenName . '"');
		});
	} catch (Throwable $e) {
		error_log('api_tokens.php audit: ' . $e->getMessage());
	}
}

try {
	$now = time();
	$method = $_SERVER['REQUEST_METHOD'];
	$enabled = defined('TRIPWIRE_API') ? (bool) TRIPWIRE_API : true;
	$output = array();

	if ($method === 'POST') {
		if (!$enabled) api_tokens_fail(403, 'The API is turned off on this server');
		$token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
		if ($token === '' || !hash_equals($csrf, $token)) api_tokens_fail(403, 'Invalid CSRF token: reload the page');
		if (strtolower(isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '') !== 'xmlhttprequest') api_tokens_fail(400, 'Missing X-Requested-With header');
		if (stripos(isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '', 'application/json') !== 0) api_tokens_fail(415, 'JSON only');
		if (!empty($_SERVER['HTTP_ORIGIN'])) {
			$originHost = strtolower((string) parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST) . (parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) ? ':' . parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) : ''));
			if ($originHost !== strtolower(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '')) api_tokens_fail(403, 'Cross-origin request refused');
		}
		$input = json_decode(file_get_contents('php://input', false, null, 0, 8192), true);
		if (!is_array($input)) api_tokens_fail(400, 'Invalid JSON');
		$mode = isset($input['mode']) ? $input['mode'] : '';

		if ($mode === 'create') {
			$days = array_key_exists('expiresDays', $input) ? $input['expiresDays'] : null;
			if ($days !== null && !is_int($days)) api_tokens_fail(400, 'expiresDays must be a whole number of days, or null');
			list($ok, $result, $status, $row) = api_token_create($mysql, $userID, $characterID, $mask, isset($input['name']) ? $input['name'] : '', $days, $now);
			if (!$ok) api_tokens_fail($status, $result);
			$output['token'] = $result;   // the only time the token is shown
			$output['created'] = (int) $row['id'];
			api_tokens_audit($mysql, $mask, 'token-create', $characterID, $characterName, $characterID, $characterName, $row['name']);
		} else if ($mode === 'revoke') {
			$id = isset($input['id']) && (is_int($input['id']) || (is_string($input['id']) && ctype_digit($input['id']))) ? (int) $input['id'] : 0;
			if ($id < 1) api_tokens_fail(400, 'Invalid id');
			list($ok, $message, $status, $row) = api_token_revoke($mysql, $id, $userID, $characterID, $now, $allianceID);
			if (!$ok) api_tokens_fail($status, $message);
			if ($row['revokedAt'] === null) {   // first revocation only
				$owner = maskadmin_character($mysql, $row['characterID']);
				api_tokens_audit($mysql, (string) $row['maskID'], 'token-revoke', $characterID, $characterName, (int) $row['characterID'], $owner ? $owner['characterName'] : '', $row['name']);
			}
			$output['revoked'] = $id;
		} else if ($method === 'POST') {
			api_tokens_fail(400, 'Unknown mode');
		}
	} else if ($method !== 'GET') {
		header('Allow: GET, POST');
		api_tokens_fail(405, 'Method not allowed');
	}

	$isAdmin = (bool) maskadmin_run($mysql, function () use ($mysql, $mask, $characterID, $allianceID) { return maskadmin_is_admin($mysql, $mask, $characterID, $allianceID); });
	list($canCreate, $why) = api_token_access($mysql, array('userID' => $userID, 'characterID' => $characterID, 'maskID' => $mask));
	$mine = api_token_list_user($mysql, $userID);
	$output += array(
		'enabled' => $enabled,
		'max' => API_TOKEN_MAX_ACTIVE,
		'maxDays' => API_TOKEN_MAX_DAYS,
		'csrf' => $csrf,
		'mask' => array('id' => $mask, 'label' => (api_tokens_labels($mysql, array(array('maskID' => $mask))))[$mask]),
		'canCreate' => $enabled && $canCreate,
		'reason' => $canCreate ? '' : 'API tokens are not available for this mask (masks reached only through an alliance are not supported)',
		'tokens' => api_tokens_public_list($mysql, $mine, $now, true),
		'admin' => $isAdmin,
		'maskTokens' => $isAdmin ? api_tokens_public_list($mysql, api_token_list_mask($mysql, $mask), $now, false) : null,
	);
	echo json_encode($output);
} catch (PDOException $e) {
	error_log('api_tokens.php: ' . $e->getMessage());
	api_tokens_fail(500, 'Database error');
}
