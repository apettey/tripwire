<?php
//***********************************************************
//	File: 		discord.php
//	Author: 	Tripwire fork
//
//	Purpose:	Discord notification settings of the current mask (see docker/README.md#discord-notifications).
//				Only Tripwire admins of the corporation that owns the session's mask (its corp mask or a
//				corporation-owned custom mask, checkAdmin) get anything; everyone
//				else gets 403, on every request.
//
//				GET  ?mode=get                      -> settings, webhooks (never their URLs), outbox status, CSRF token
//				GET  ?mode=status&id=<outboxID>     -> one queued message (test message progress)
//				POST JSON {mode, ...}               -> webhook-add, webhook-update, webhook-delete, webhook-test,
//				                                       settings-save, preview
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
require_once('../zkill/zkill.inc.php');
require_once('../discord/discord.inc.php');

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function discord_fail($code, $message) {
	http_response_code($code);
	echo json_encode(array('error' => $message));
	exit();
}

$mask = (string) $_SESSION['mask'];
if (!isset($mysql) || !($mysql instanceof PDO)) discord_fail(500, 'Database error');
// Corporation admins only: the corporation mask or a custom mask owned by the user's corporation, and the user must
// be a Tripwire admin of that corporation (checkAdmin). Mask owners without the admin flag (anyone can create a
// personal custom mask) and Public / Private / alliance masks get nothing.
$maskCorporation = discord_mask_corporation_db($mysql, $mask);
$sessionCorporation = isset($_SESSION['corporationID']) ? (int) $_SESSION['corporationID'] : 0;
if ($maskCorporation === null || $maskCorporation !== $sessionCorporation) discord_fail(403, 'Discord notifications are for your corporation\'s masks');
if (!checkAdmin($mask)) discord_fail(403, 'Only your corporation\'s Tripwire admins can change Discord notifications');

if (empty($_SESSION['discordCsrf'])) $_SESSION['discordCsrf'] = bin2hex(random_bytes(32));
$csrf = $_SESSION['discordCsrf'];
$characterName = isset($_SESSION['characterName']) ? (string) $_SESSION['characterName'] : '';
[$defaultCorporation, $defaultAlliance] = discord_mask_entities($maskCorporation);
session_write_close();

const DISCORD_MAX_WEBHOOKS     = 10;
const DISCORD_TESTS_PER_MIN    = 5;    // test messages per mask per minute
const DISCORD_URLS_PER_HOUR    = 10;   // webhook URLs added or replaced per mask per hour

function discord_action_allowed(PDO $db, $mask, $kind, $max, $seconds) {
	return discord_rate_take($db, $mask, $kind, $max, $seconds);
}

/** Another webhook of the mask with the same URL (decrypted for comparison; at most DISCORD_MAX_WEBHOOKS rows) */
function discord_duplicate_url(PDO $db, $mask, $url, $exceptID = 0) {
	$stmt = $db->prepare('SELECT id, url FROM discord_webhooks WHERE maskID = ? AND id <> ?');
	$stmt->execute(array($mask, (int) $exceptID));
	$wanted = discord_webhook_parse($url);
	foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
		$other = discord_webhook_parse((string) discord_unseal($row['url']));
		if ($other && $wanted && $other['id'] === $wanted['id'] && $other['threadID'] === $wanted['threadID']) return true;
	}
	return false;
}

function discord_webhook_rows(PDO $db, $mask) {
	$stmt = $db->prepare('SELECT id, name, urlHint, status, statusMessage, lastSentAt, lastErrorAt FROM discord_webhooks WHERE maskID = ? ORDER BY id');
	$stmt->execute(array($mask));
	return array_map(function ($w) {
		return array('id' => (int) $w['id'], 'name' => $w['name'], 'hint' => $w['urlHint'], 'status' => $w['status'],
			'statusMessage' => $w['statusMessage'], 'lastSentAt' => zk_iso($w['lastSentAt']), 'lastErrorAt' => zk_iso($w['lastErrorAt']));
	}, $stmt->fetchAll(PDO::FETCH_ASSOC));
}

function discord_webhook_of_mask(PDO $db, $mask, $id) {
	$stmt = $db->prepare('SELECT id, name, url, status FROM discord_webhooks WHERE id = ? AND maskID = ?');
	$stmt->execute(array((int) $id, $mask));
	return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

function discord_name($value) {
	$name = trim(preg_replace('/\s+/', ' ', (string) $value));
	return ($name === '' || mb_strlen($name) > 60) ? null : $name;
}

/** Sample chain label for the preview */
function discord_sample_label($systemID) {
	return 'AABCA';
}

/** Sample chain label of the system a sample rally moves to */
function discord_sample_label_moved($systemID) {
	return 'AB';
}

/** Sample message contexts for the preview */
function discord_sample_context($kind, $template, $ping, $maskName) {
	$base = array('kind' => $kind, 'template' => $template, 'ping' => $ping, 'mask' => $maskName, 'time' => time());
	if ($kind === 'rally') {
		return discord_rally_context(array('action' => 'set', 'who' => 'Example Pilot') + $base, array('systemID' => 31001880, 'setBy' => 'Example Pilot'), 'discord_sample_label');
	}
	if ($kind === 'watchlist') {
		return $base + array('filter' => 'C5 with a Wolf-Rayet', 'systemID' => 31001882, 'system' => 'J122515', 'security' => null, 'class' => 'C5',
			'effect' => 'Wolf-Rayet', 'region' => 'E-R00028', 'map' => discord_map_url(31001882), 'dotlan' => discord_dotlan_url(31001882),
			'sig' => 'ABC-123', 'hole' => 'H296', 'from' => 'J115405');
	}
	if ($kind === 'kspace') {
		return $base + array('systemID' => 30002659, 'system' => 'Dodixie', 'security' => 0.87, 'class' => 'HS', 'region' => 'Sinq Laison',
			'map' => discord_map_url(30002659), 'dotlan' => discord_dotlan_url(30002659), 'hubs' => array(array('Jita', 6), array('Amarr', 9)),
			'sig' => 'ABC-123', 'hole' => 'K162', 'from' => 'J123456', 'mapper' => 'Example Pilot', 'label' => 'AABC');
	}
	return $base + array('systemID' => 31000005, 'system' => 'J123456', 'security' => null, 'class' => 'C3', 'region' => 'C-R00023',
		'map' => discord_map_url(31000005), 'dotlan' => discord_dotlan_url(31000005), 'killID' => 123456789,
		'victimID' => 2112625428, 'victim' => 'Example Victim', 'shipTypeID' => 11377, 'ship' => 'Nemesis',
		'corp' => 'Example Corp', 'alliance' => 'Example Alliance', 'finalblow' => 'Example Hunter', 'attackercorp' => 'Hunter Corp',
		'attackers' => 4, 'value' => 254300000, 'zkill' => 'https://zkillboard.com/kill/123456789/', 'label' => discord_sample_label(31000005));
}

try {
	discord_ensure_schema($mysql);
	$maskName = discord_mask_name($mysql, $mask);
	$defaults = discord_settings_defaults($defaultCorporation, $defaultAlliance);
	$method = $_SERVER['REQUEST_METHOD'];
	$output = array();

	if ($method === 'GET') {
		$mode = isset($_GET['mode']) ? $_GET['mode'] : 'get';
		if ($mode === 'status') {
			$id = isset($_GET['id']) ? filter_var($_GET['id'], FILTER_VALIDATE_INT) : false;
			if (!$id) discord_fail(400, 'Invalid id');
			$stmt = $mysql->prepare('SELECT id, status, attempts, lastError, sentAt FROM discord_outbox WHERE id = ? AND maskID = ?');
			$stmt->execute(array($id, $mask));
			$row = $stmt->fetch(PDO::FETCH_ASSOC);
			if (!$row) discord_fail(404, 'Not found');
			echo json_encode(array('message' => array('id' => (int) $row['id'], 'status' => $row['status'], 'attempts' => (int) $row['attempts'],
				'error' => $row['lastError'], 'sentAt' => zk_iso($row['sentAt']))));
			exit();
		}
		if ($mode !== 'get') discord_fail(400, 'Unknown mode');
	} else if ($method === 'POST') {
		// CSRF: per-session token in a custom header (cross-site forms can't set headers; cross-site fetch can't
		// read the token), plus same-origin check when the browser says where the request comes from
		$token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
		if ($token === '' || !hash_equals($csrf, $token)) discord_fail(403, 'Invalid CSRF token: reload the page');
		if (strtolower(isset($_SERVER['HTTP_X_REQUESTED_WITH']) ? $_SERVER['HTTP_X_REQUESTED_WITH'] : '') !== 'xmlhttprequest') discord_fail(400, 'Missing X-Requested-With header');
		if (stripos(isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '', 'application/json') !== 0) discord_fail(415, 'JSON only');
		if (!empty($_SERVER['HTTP_ORIGIN'])) {
			$originHost = strtolower((string) parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST) . (parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) ? ':' . parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_PORT) : ''));
			if ($originHost !== strtolower(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '')) discord_fail(403, 'Cross-origin request refused');
		}
		$raw = file_get_contents('php://input', false, null, 0, 65536);
		$input = json_decode($raw, true);
		if (!is_array($input)) discord_fail(400, 'Invalid JSON');
		$mode = isset($input['mode']) ? $input['mode'] : '';

		if ($mode === 'webhook-add' || $mode === 'webhook-update') {
			$name = discord_name(isset($input['name']) ? $input['name'] : '');
			if ($name === null) discord_fail(400, 'Give the webhook a name (the channel), up to 60 characters');
			$url = isset($input['url']) ? trim((string) $input['url']) : '';
			$parsed = $url === '' ? null : discord_webhook_parse($url);
			if ($url !== '' && !$parsed) discord_fail(400, 'That is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)');
			if ($mode === 'webhook-add' && !$parsed) discord_fail(400, 'Paste the webhook URL from Discord (channel settings > Integrations > Webhooks > Copy Webhook URL)');
			$webhook = $mode === 'webhook-update' ? discord_webhook_of_mask($mysql, $mask, isset($input['id']) ? $input['id'] : 0) : null;
			if ($mode === 'webhook-update' && !$webhook) discord_fail(404, 'No such webhook');
			if ($parsed) {
				if (discord_duplicate_url($mysql, $mask, $parsed['url'], $webhook ? $webhook['id'] : 0)) discord_fail(409, 'This mask already has that webhook');
				if (!discord_action_allowed($mysql, $mask, 'rl:url', DISCORD_URLS_PER_HOUR, 3600)) discord_fail(429, 'Too many webhook URLs added or replaced in the last hour; try again later');
			}
			// A new or replaced URL is 'pending' until Discord accepts a message for it (then 'ok', or 'broken')
			if ($mode === 'webhook-add') {
				$stmt = $mysql->prepare('SELECT COUNT(*) FROM discord_webhooks WHERE maskID = ?');
				$stmt->execute(array($mask));
				if ((int) $stmt->fetchColumn() >= DISCORD_MAX_WEBHOOKS) discord_fail(400, 'At most ' . DISCORD_MAX_WEBHOOKS . ' webhooks per mask');
				$stmt = $mysql->prepare("INSERT INTO discord_webhooks (maskID, name, url, urlHint, status, createdBy, createdAt, updatedAt)
					VALUES (?, ?, ?, ?, 'pending', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())");
				$stmt->execute(array($mask, $name, discord_seal($parsed['url']), discord_webhook_hint($parsed['url']), substr($characterName, 0, 100)));
				$output['id'] = (int) $mysql->lastInsertId();
			} else {
				if ($parsed) {
					$stmt = $mysql->prepare("UPDATE discord_webhooks SET name = ?, url = ?, urlHint = ?, status = 'pending', statusMessage = '', updatedAt = UTC_TIMESTAMP() WHERE id = ?");
					$stmt->execute(array($name, discord_seal($parsed['url']), discord_webhook_hint($parsed['url']), $webhook['id']));
					// A new URL may be another channel: the next rally change posts instead of editing the old message
					discord_rally_forget_webhook($mysql, $webhook['id']);
				} else {
					$stmt = $mysql->prepare('UPDATE discord_webhooks SET name = ?, updatedAt = UTC_TIMESTAMP() WHERE id = ?');
					$stmt->execute(array($name, $webhook['id']));
				}
				$output['id'] = (int) $webhook['id'];
			}
		} else if ($mode === 'webhook-delete') {
			$webhook = discord_webhook_of_mask($mysql, $mask, isset($input['id']) ? $input['id'] : 0);
			if (!$webhook) discord_fail(404, 'No such webhook');
			discord_outbox_fail_webhook($mysql, $webhook['id'], 'webhook was deleted');
			$mysql->prepare('DELETE FROM discord_webhooks WHERE id = ?')->execute(array($webhook['id']));
			// Types that posted there are switched off
			$settings = discord_settings_load($mysql, $mask, $defaults);
			foreach (DISCORD_KINDS as $kind) {
				if ($settings['types'][$kind]['webhookID'] === (int) $webhook['id']) {
					$settings['types'][$kind]['webhookID'] = 0;
					$settings['types'][$kind]['enabled'] = false;
				}
			}
			discord_settings_save($mysql, $mask, $settings, $characterName);
		} else if ($mode === 'webhook-test') {
			$webhook = discord_webhook_of_mask($mysql, $mask, isset($input['id']) ? $input['id'] : 0);
			if (!$webhook) discord_fail(404, 'No such webhook');
			if ($webhook['status'] === 'broken') discord_fail(409, 'This webhook is broken: replace its URL first');
			if (!discord_action_allowed($mysql, $mask, 'rl:test', DISCORD_TESTS_PER_MIN, 60)) discord_fail(429, 'Too many test messages; wait a minute');
			$id = discord_enqueue($mysql, $mask, $webhook['id'], 'test',
				array('kind' => 'test', 'webhook' => $webhook['name'], 'mask' => $maskName, 'ping' => '', 'time' => time()), DISCORD_PRIORITY_TEST);
			if ($id === null) discord_fail(429, 'Too many messages are waiting for this mask');
			$output['messageID'] = $id;
		} else if ($mode === 'settings-save') {
			$ids = array_map(function ($w) { return $w['id']; }, discord_webhook_rows($mysql, $mask));
			list($settings, $errors) = discord_settings_normalise(isset($input['settings']) ? $input['settings'] : null, $defaults, $ids);
			if ($errors) {
				http_response_code(400);
				echo json_encode(array('error' => implode('; ', $errors), 'errors' => $errors));
				exit();
			}
			// enabledAt comes from the server's clock, never from the browser
			$settings = discord_settings_stamp($settings, discord_settings_load($mysql, $mask, $defaults));
			discord_settings_save($mysql, $mask, $settings, $characterName);
		} else if ($mode === 'preview') {
			$kind = isset($input['kind']) ? $input['kind'] : '';
			if (!in_array($kind, DISCORD_KINDS, true)) discord_fail(400, 'Unknown type');
			$template = trim(str_replace("\r", '', (string) (isset($input['template']) ? $input['template'] : '')));
			if ($template === '') $template = $defaults['types'][$kind]['template'];
			$ping = discord_ping_normalise(isset($input['ping']) ? $input['ping'] : '');
			if ($ping === null) discord_fail(400, 'Ping may only contain <@&roleID>, <@userID>, @here or @everyone');
			$context = discord_sample_context($kind, mb_substr($template, 0, DISCORD_TEMPLATE_MAX), $ping, $maskName);
			$preview = array('preview' => discord_payload($context));
			if ($kind === 'rally') {
				// The rally type has a second message, for when the rally is cleared
				$templateClear = trim(str_replace("\r", '', (string) (isset($input['templateClear']) ? $input['templateClear'] : '')));
				if ($templateClear === '') $templateClear = $defaults['types']['rally']['templateClear'];
				// Built like a real clear of the sample rally: the edit of its message (the system it was on is known, so
				// {was} is filled)
				$preview['previewClear'] = discord_payload(array('previous' => $preview['preview']['content'])
					+ discord_rally_context(array('action' => 'clear', 'who' => 'Other Pilot',
					'templateClear' => mb_substr($templateClear, 0, DISCORD_TEMPLATE_MAX)) + $context, null, 'discord_sample_label'));
				// And moved after 30 s: the old message is edited like this (fixed text), a new one is posted
				$preview['previewMoved'] = discord_payload(array('moved' => true, 'previous' => $preview['preview']['content'])
					+ discord_rally_context(array('action' => 'set') + $context, array('systemID' => 31002012, 'setBy' => 'Other Pilot'), 'discord_sample_label_moved'));
			}
			echo json_encode($preview);
			exit();
		} else {
			discord_fail(400, 'Unknown mode');
		}
		$output['result'] = true;
	} else {
		header('Allow: GET, POST');
		discord_fail(405, 'Method not allowed');
	}

	// Current state (also the answer to every change)
	$settings = discord_settings_load($mysql, $mask, $defaults);
	$entityIDs = array_merge($settings['corporations'], $settings['alliances']);
	list($names) = zk_names_lookup($mysql, $entityIDs);

	$output += array(
		'csrf' => $csrf,
		'mask' => array('id' => $mask, 'name' => $maskName),
		'encrypted' => discord_encryption_enabled(),
		'webhooks' => discord_webhook_rows($mysql, $mask),
		'settings' => $settings,
		'defaults' => array('templates' => discord_default_templates(), 'pingSystems' => DISCORD_DEFAULT_PING_SYSTEMS,
			'corporations' => $defaults['corporations'], 'alliances' => $defaults['alliances']),
		'placeholders' => discord_placeholders(),
		'names' => (object) $names,
		'outbox' => discord_outbox_status($mysql, $mask),
		// Upstream's server-wide DISCORD_WEB_HOOK has a webhook for this mask: rally changes go there while the rally
		// type is off (only whether there is one, never the URL)
		'legacyRally' => discord_rally_legacy_hook($mask) !== null,
	);
	echo json_encode($output);
} catch (PDOException $e) {
	error_log('discord.php: ' . $e->getMessage());
	discord_fail(500, 'Database error');
}
