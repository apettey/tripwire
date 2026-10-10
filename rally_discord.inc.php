<?php
//***********************************************************
//	File: 		rally_discord.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	Posts rally point changes (public/rally.php) to the mask's Discord webhook: the same
//				DISCORD_WEB_HOOK entry upstream's pings use (ping.inc.php), sent the same way as
//				public/ping.php (file_get_contents with an http stream context, JSON body).
//
//	Debounce: at most one new Discord message per mask per RALLY_DISCORD_WINDOW seconds. A change inside
//	the window edits that message instead (latest wins, no extra message); if the message can't be
//	edited (no message id) the change is skipped. State lives in fork_rally_discord (one row per mask).
//
//	The pure functions (rally_discord_clean, _system_label, _payload, _decision, _message_url) have no
//	side effects; tools/rally-discord-test.php exercises them.
//***********************************************************

if (!defined('RALLY_DISCORD_WINDOW')) define('RALLY_DISCORD_WINDOW', 30);

/** Neutralise user-controlled text for a Discord message: no mentions (@everyone, @here, <@id>), no
	markdown, no links, one line, at most $max characters. */
function rally_discord_clean($text, $max = 100) {
	$text = (string)$text;
	$text = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $text);		// control characters / newlines
	if ($text === null) return '';
	$text = str_replace(array('<', '>'), '', $text);				// <@id>, <#channel>, <https://...>
	$text = trim($text);
	if (function_exists('mb_substr')) { $text = mb_substr($text, 0, $max); } else { $text = substr($text, 0, $max); }
	$text = preg_replace('/([\\\\*_~`|\[\]])/', '\\\\$1', $text);	// markdown (incl. [masked](links))
	return str_replace('@', "@\u{200B}", $text);					// @everyone / @here can't resolve
}

/** "J152820 (C5, E-R00024)" / "Jita (High-Sec, The Forge)" from an appData system entry and its region */
function rally_discord_system_label($system, $region) {
	if (!is_array($system) || !isset($system['name'])) return null;
	$class = null;
	if (isset($system['class'])) {
		$c = (int)$system['class'];
		if ($c === 12) $class = 'Thera';
		else if ($c >= 14 && $c <= 18) $class = 'Drifter';
		else $class = 'C' . $c;
	} else if (isset($system['regionID']) && (int)$system['regionID'] === 10000070) {
		$class = 'Pochven';
	} else if (isset($system['security'])) {
		$sec = round((float)$system['security'], 1);
		$class = $sec >= 0.5 ? 'High-Sec' : ($sec > 0.0 ? 'Low-Sec' : 'Null-Sec');
	}
	$parts = array();
	if ($class) $parts[] = $class;
	if (is_array($region) && isset($region['name'])) $parts[] = $region['name'];
	return $system['name'] . ($parts ? ' (' . implode(', ', $parts) . ')' : '');
}

/** Webhook payload. $action 'set' or 'clear'. All text is cleaned here; allowed_mentions blocks pings
	even if something slipped through. Format follows upstream's ping message. */
function rally_discord_payload($action, $who, $systemLabel = null, $systemName = null, $urlBase = null) {
	$who = rally_discord_clean($who !== null && $who !== '' ? $who : 'someone');
	if ($action === 'clear') {
		$content = 'Tripwire rally point cleared by *' . $who . '*';
	} else {
		$content = 'Tripwire rally point from *' . $who . '*: **' . rally_discord_clean($systemLabel, 150) . '**';
		if ($urlBase && $systemName !== null && $systemName !== '') {
			$content .= "\n<" . $urlBase . '/?system=' . rawurlencode($systemName) . '>';
		}
	}
	return array('content' => $content, 'allowed_mentions' => array('parse' => array()));
}

/** Debounce: 'post' a new message, 'edit' the last one, or 'skip'.
	@param $last null (never posted) or array('messageID' => string|null, 'age' => seconds since the post) */
function rally_discord_decision($last, $window = RALLY_DISCORD_WINDOW) {
	if (!$last || !isset($last['age']) || $last['age'] === null || (int)$last['age'] >= $window || (int)$last['age'] < 0) return 'post';
	return !empty($last['messageID']) ? 'edit' : 'skip';
}

/** Webhook URL for a new message (?wait=true returns the message, so it can be edited) or for editing
	message $messageID (PATCH .../messages/<id>), keeping any query (e.g. thread_id) on the hook */
function rally_discord_message_url($hook, $messageID = null) {
	$query = '';
	$q = strpos($hook, '?');
	if ($q !== false) { $query = substr($hook, $q + 1); $hook = substr($hook, 0, $q); }
	$hook = rtrim($hook, '/');
	if ($messageID === null) {
		return $hook . '?' . ($query !== '' ? $query . '&' : '') . 'wait=true';
	}
	return $hook . '/messages/' . rawurlencode($messageID) . ($query !== '' ? '?' . $query : '');
}

/** Send like public/ping.php does. Returns the decoded Discord response (array) or false. */
function rally_discord_send($url, $payload, $method = 'POST') {
	$options = array(
		'http' => array(
			'header'  => "Content-type: application/json\r\n",
			'method'  => $method,
			'content' => json_encode($payload),
			'timeout' => 5
		)
	);
	$context = stream_context_create($options);
	$result = @file_get_contents($url, false, $context);
	if ($result === false) {
		$error = error_get_last();
		error_log('rally discord: ' . ($error ? $error['message'] : 'request failed'));
		return false;
	}
	$decoded = json_decode($result, true);
	return is_array($decoded) ? $decoded : array();
}

/** appData (systems, regions) from public/js/combine.js, only read when a message is sent */
function rally_discord_app_data() {
	static $data = null;
	if ($data !== null) return $data;
	$data = array();
	$raw = @file_get_contents(__DIR__ . '/public/js/combine.js');
	if ($raw !== false) {
		$start = strpos($raw, '{');
		$end = strrpos($raw, '}');
		if ($start !== false && $end !== false) {
			$decoded = json_decode(substr($raw, $start, $end - $start + 1), true);
			if (is_array($decoded)) $data = $decoded;
		}
	}
	return $data;
}

/** Base URL for links back to Tripwire, like ping.php's. Uses the Host header (it carries the port) when it
	names the same server as SERVER_NAME, or when SERVER_NAME is nginx's catch-all "_". */
function rally_discord_url_base() {
	$server = isset($_SERVER['SERVER_NAME']) ? $_SERVER['SERVER_NAME'] : '';
	$host = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '';
	$valid = '/^[A-Za-z0-9.\-]+(:\d+)?$/';
	if (!preg_match($valid, $host) || ($server !== '' && $server !== '_' && strcasecmp(preg_replace('/:\d+$/', '', $host), $server) !== 0)) {
		$host = $server;
	}
	if (!preg_match($valid, $host) || $host === '_') return null;
	$path = rtrim(str_replace('\\', '/', dirname($_SERVER['REQUEST_URI'] . '?')), '/');
	return (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http') . '://' . $host . $path;
}

/** Post (or edit, or skip, see the debounce above) a rally change for $mask.
	@param $hook the mask's webhook (discord_webhook_for_current_mask())
	@param $action 'set' or 'clear'
	@return 'post' | 'edit' | 'skip' | 'failed' */
function rally_discord_notify($mysql, $mask, $hook, $action, $who, $systemID = null) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_rally_discord (
		maskID decimal(12,1) NOT NULL,
		messageID varchar(32) DEFAULT NULL,
		postedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (maskID)
	)');
	if ($created === false) { error_log('rally discord: could not create fork_rally_discord'); return 'failed'; }

	$stmt = $mysql->prepare('SELECT messageID, TIMESTAMPDIFF(SECOND, postedAt, NOW()) AS age FROM fork_rally_discord WHERE maskID = :mask');
	$stmt->bindValue(':mask', $mask);
	$last = $stmt->execute() ? $stmt->fetch(PDO::FETCH_ASSOC) : null;
	$decision = rally_discord_decision($last ?: null);
	if ($decision === 'skip') return 'skip';

	$systemLabel = null; $systemName = null;
	if ($action === 'set') {
		$appData = rally_discord_app_data();
		$system = isset($appData['systems'][$systemID]) ? $appData['systems'][$systemID] : null;
		$region = $system && isset($system['regionID']) && isset($appData['regions'][$system['regionID']]) ? $appData['regions'][$system['regionID']] : null;
		$systemLabel = rally_discord_system_label($system, $region);
		$systemName = $system ? $system['name'] : null;
		if ($systemLabel === null) $systemLabel = (string)$systemID;
	}
	$payload = rally_discord_payload($action, $who, $systemLabel, $systemName, rally_discord_url_base());

	if ($decision === 'edit') {
		return rally_discord_send(rally_discord_message_url($hook, $last['messageID']), $payload, 'PATCH') === false ? 'failed' : 'edit';
	}

	// Claim the window first, so a concurrent change skips instead of posting a second message
	$claim = $mysql->prepare('INSERT INTO fork_rally_discord (maskID, messageID, postedAt) VALUES (:mask, NULL, NOW())
		ON DUPLICATE KEY UPDATE messageID = NULL, postedAt = NOW()');
	$claim->bindValue(':mask', $mask);
	$claim->execute();

	$response = rally_discord_send(rally_discord_message_url($hook), $payload, 'POST');
	if ($response === false) return 'failed';
	if (isset($response['id']) && preg_match('/^\d{1,32}$/', (string)$response['id'])) {
		$save = $mysql->prepare('UPDATE fork_rally_discord SET messageID = :messageID WHERE maskID = :mask');
		$save->bindValue(':messageID', (string)$response['id']);
		$save->bindValue(':mask', $mask);
		$save->execute();
	}
	return 'post';
}
