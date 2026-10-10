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
//	the window edits that message instead (no extra message). Every send runs under a per-mask MySQL
//	lock (GET_LOCK) and posts the rally as it is in fork_rally *at that moment*, not the change that
//	triggered it, so concurrent changes are serialised and the last send always shows the final rally.
//	A failed post releases the window; a failed edit (e.g. message deleted) falls back to a new post.
//	State lives in fork_rally_discord (one row per mask).
//
//	The pure functions (rally_discord_clean, _system_label, _payload, _decision, _message_url, _url_base,
//	_redact) have no side effects; tests/rally_discord_test.php exercises them.
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
		$urlBase = preg_replace('/[<>\s]+/', '', (string)$urlBase);	// can't break out of the <autolink>
		if ($urlBase !== '' && $systemName !== null && $systemName !== '') {
			$content .= "\n<" . $urlBase . '/?system=' . rawurlencode($systemName) . '>';
		}
	}
	return array('content' => $content, 'allowed_mentions' => array('parse' => array()));
}


/** Debounce: 'post' a new message or 'edit' the last one.
	@param $last null (never posted) or array('messageID' => string|null, 'age' => seconds since the post).
	A row without a message id (Discord returned none) can't be edited, so it posts. */
function rally_discord_decision($last, $window = RALLY_DISCORD_WINDOW) {
	if (!$last || !isset($last['age']) || $last['age'] === null || (int)$last['age'] >= $window || (int)$last['age'] < 0) return 'post';
	return !empty($last['messageID']) ? 'edit' : 'post';
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

/** Hide URLs (the webhook URL carries its secret token) in text that goes to the log */
function rally_discord_redact($text) {
	return preg_replace('#https?://\S+#i', '<webhook>', (string)$text);
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
		error_log('rally discord: ' . $method . ' failed: ' . rally_discord_redact($error ? $error['message'] : 'request failed'));
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

/** Base URL for links back to Tripwire, from configuration only (never the request's Host or URI):
	scheme, host and port from $redirect (EVE_SSO_REDIRECT, built from TRIPWIRE_DOMAIN / TRIPWIRE_HTTPS in
	Docker) and the directory of $scriptName (SCRIPT_NAME, e.g. /rally.php). null if it can't be built. */
function rally_discord_url_base($redirect, $scriptName) {
	$url = parse_url((string)$redirect);
	if (!$url || !isset($url['scheme'], $url['host'])) return null;
	$scheme = strtolower($url['scheme']);
	if ($scheme !== 'http' && $scheme !== 'https') return null;
	if (!preg_match('/^[A-Za-z0-9.\-]+$/', $url['host'])) return null;
	$port = isset($url['port']) ? ':' . (int)$url['port'] : '';
	$path = str_replace('\\', '/', dirname((string)$scriptName));
	if (!preg_match('#^[A-Za-z0-9/._\-]*$#', $path)) $path = '';
	return $scheme . '://' . $url['host'] . $port . rtrim($path, '/.');
}

/** Rally of $mask as stored right now: array('systemID', 'setBy') or null */
function rally_discord_current_rally($mysql, $mask) {
	$stmt = $mysql->prepare('SELECT systemID, setBy FROM fork_rally WHERE maskID = :mask');
	$stmt->bindValue(':mask', $mask);
	if (!$stmt->execute()) return null;
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	return $row ? array('systemID' => (int)$row['systemID'], 'setBy' => $row['setBy']) : null;
}

/** Bring the mask's Discord message up to date with its rally, after a change.
	Runs under a per-mask lock and posts the rally as stored when the lock is held (see the header), so
	the last change to finish always leaves Discord showing the final rally.
	@param $hook the mask's webhook (discord_webhook_for_current_mask())
	@param $action the change that triggered this, 'set' or 'clear' (only used to name who cleared)
	@param $who the character that made the change
	@return 'post' | 'edit' | 'failed' */
function rally_discord_notify($mysql, $mask, $hook, $action, $who) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_rally_discord (
		maskID decimal(12,1) NOT NULL,
		messageID varchar(32) DEFAULT NULL,
		postedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (maskID)
	)');
	if ($created === false) { error_log('rally discord: could not create fork_rally_discord'); return 'failed'; }

	// Wait behind any send in progress for this mask (each send is at most a few 5 s requests)
	$lockName = 'rally_discord_' . $mask;
	if (!rally_discord_lock($mysql, $lockName, 20)) { error_log('rally discord: lock timeout for mask ' . $mask); return 'failed'; }

	try {
		$stmt = $mysql->prepare('SELECT messageID, TIMESTAMPDIFF(SECOND, postedAt, NOW()) AS age FROM fork_rally_discord WHERE maskID = :mask');
		$stmt->bindValue(':mask', $mask);
		$last = $stmt->execute() ? $stmt->fetch(PDO::FETCH_ASSOC) : null;
		$decision = rally_discord_decision($last ?: null);

		// What Discord should show: the rally as it is now, not necessarily this request's change
		$rally = rally_discord_current_rally($mysql, $mask);
		if ($rally) {
			$appData = rally_discord_app_data();
			$systemID = $rally['systemID'];
			$system = isset($appData['systems'][$systemID]) ? $appData['systems'][$systemID] : null;
			$region = $system && isset($system['regionID']) && isset($appData['regions'][$system['regionID']]) ? $appData['regions'][$system['regionID']] : null;
			$systemLabel = rally_discord_system_label($system, $region);
			if ($systemLabel === null) $systemLabel = (string)$systemID;
			$urlBase = rally_discord_url_base(defined('EVE_SSO_REDIRECT') ? EVE_SSO_REDIRECT : null, isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '');
			$payload = rally_discord_payload('set', $rally['setBy'], $systemLabel, $system ? $system['name'] : null, $urlBase);
		} else {
			// Only name the clearer if it was this request (someone else's clear is named by their own send)
			$payload = rally_discord_payload('clear', $action === 'clear' ? $who : 'someone');
		}

		if ($decision === 'edit') {
			if (rally_discord_send(rally_discord_message_url($hook, $last['messageID']), $payload, 'PATCH') !== false) return 'edit';
			// Message gone (deleted, 404) or Discord unreachable: post a new one instead
		}

		$claim = $mysql->prepare('INSERT INTO fork_rally_discord (maskID, messageID, postedAt) VALUES (:mask, NULL, NOW())
			ON DUPLICATE KEY UPDATE messageID = NULL, postedAt = NOW()');
		$claim->bindValue(':mask', $mask);
		$claim->execute();

		$response = rally_discord_send(rally_discord_message_url($hook), $payload, 'POST');
		if ($response === false) {
			// Release the window so the next change posts
			$release = $mysql->prepare('DELETE FROM fork_rally_discord WHERE maskID = :mask');
			$release->bindValue(':mask', $mask);
			$release->execute();
			return 'failed';
		}
		if (isset($response['id']) && preg_match('/^\d{1,32}$/', (string)$response['id'])) {
			$save = $mysql->prepare('UPDATE fork_rally_discord SET messageID = :messageID WHERE maskID = :mask');
			$save->bindValue(':messageID', (string)$response['id']);
			$save->bindValue(':mask', $mask);
			$save->execute();
		}
		return 'post';
	} finally {
		rally_discord_unlock($mysql, $lockName);
	}
}

/** Release every hold this connection has on lock $name (GET_LOCK is re-entrant per connection, so a
	stale hold can count more than once). Only touches this lock name, never RELEASE_ALL_LOCKS.
	@return the number of holds released */
function rally_discord_unlock($mysql, $name) {
	$released = 0;
	for ($i = 0; $i < 100; $i++) {
		$stmt = $mysql->prepare('SELECT RELEASE_LOCK(:name)');
		$stmt->bindValue(':name', $name);
		if (!$stmt->execute() || (int)$stmt->fetchColumn() !== 1) break;
		$released++;
	}
	return $released;
}

/** GET_LOCK($name) for up to $timeout seconds. db.inc.php uses persistent connections, so a request that
	died inside the locked section (fatal error) could leave the lock held on a pooled connection:
	drop any hold this connection still has first, and release again at shutdown if a fatal error skips
	the caller's `finally`. */
function rally_discord_lock($mysql, $name, $timeout) {
	rally_discord_unlock($mysql, $name);
	$stmt = $mysql->prepare('SELECT GET_LOCK(:name, :timeout)');
	$stmt->bindValue(':name', $name);
	$stmt->bindValue(':timeout', (int)$timeout, PDO::PARAM_INT);
	if (!$stmt->execute() || (int)$stmt->fetchColumn() !== 1) return false;
	register_shutdown_function(function() use ($mysql, $name) {
		try { rally_discord_unlock($mysql, $name); } catch (Throwable $e) { /* connection gone: MySQL released it */ }
	});
	return true;
}
