<?php
//***********************************************************
//	File: 		rally_discord.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	Posts rally point changes (public/rally.php) to the mask's Discord webhook: the same
//				DISCORD_WEB_HOOK entry upstream's pings use (ping.inc.php), sent the same way as
//				public/ping.php (file_get_contents with an http stream context, JSON body).
//
//	Same rules as the Mask Admin > Discord type (discord/rally.php), with fixed texts and no pings:
//	  - set / moved within RALLY_DISCORD_WINDOW seconds of the last post: that message is edited;
//	  - moved later: a new message is posted, then the old one is edited into its text struck through +
//	    "Moved to ... by ... at <time>";
//	  - cleared, at any time: the live message is edited into its text struck through + "Cleared by ...
//	    at <time>". Nothing is posted for a clear, also when there is no message to edit (or it is gone).
//	Every send runs under a per-mask MySQL lock (GET_LOCK) and shows the rally as it is in fork_rally *at
//	that moment*, not the change that triggered it, so concurrent changes are serialised and the last send
//	always shows the final rally. A failed post keeps the old message tracked (a later change ends it); a
//	failed edit of a live message (deleted, unreachable) falls back to a new post, and the old one is still
//	sent its "Moved to" edit (harmless when it is gone). A failed clear edit is not retried. The live message (id and text) is in fork_rally_discord_message;
//	fork_rally_discord (1.15-1.17, no text) is no longer read.
//
//	The pure functions (rally_discord_clean, _system_label, _payload, _end_payload, _decision, _message_url,
//	_url_base, _redact) have no side effects; tests/rally_discord_test.php exercises them.
//
//	Since the rally point is a notification type in Mask Admin > Discord (discord/rally.php), this direct path is
//	only the fallback for masks that don't have that type turned on: see rally_discord_route().
//***********************************************************

if (!defined('RALLY_DISCORD_WINDOW')) define('RALLY_DISCORD_WINDOW', 30);

/** Where a rally change of $mask goes (needs discord/discord.inc.php):
	array('via' => 'settings', 'type' => <rally type>) when a corp admin turned the type on in Mask Admin > Discord
	(queued in the Discord outbox), else array('via' => 'legacy', 'hook' => <url>) when upstream's server-wide
	DISCORD_WEB_HOOK ($legacyMap, null = the constant) has a webhook for the mask (posted directly, as before),
	else null. The Mask Admin setting wins; an error reading it (e.g. no discord_* tables yet) counts as not set. */
function rally_discord_route($mysql, $mask, $legacyMap = null) {
	try {
		$type = discord_rally_target($mysql, $mask);
		if ($type) return array('via' => 'settings', 'type' => $type);
	} catch (Throwable $e) {
		// No discord_* tables yet (the Discord worker creates them) is normal and asked on every poll: not logged
		if (!($e instanceof PDOException && $e->getCode() === '42S02')) error_log('rally discord: reading the Discord settings failed: ' . rally_discord_redact($e->getMessage()));
	}
	$hook = discord_rally_legacy_hook($mask, $legacyMap);
	return $hook ? array('via' => 'legacy', 'hook' => $hook) : null;
}

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

/** "AABCA · J152820" / "J152820", cleaned: the system's chain label (discord_chain_label) before it, when it has one.
	The label is a signature name (user text): also no links (':' escaped, as discord_escape does) */
function rally_discord_with_label($chainLabel, $text, $max = 150) {
	$label = str_replace(':', '\\:', rally_discord_clean(trim((string)$chainLabel), 100));
	$text = rally_discord_clean($text, $max);
	return $label !== '' ? $label . ' · ' . $text : $text;
}

/** Webhook payload. $action 'set' or 'clear'. All text is cleaned here; allowed_mentions blocks pings
	even if something slipped through. Format follows upstream's ping message.
	$chainLabel: the system's chain label (e.g. AABCA), shown before the system; a clear with $systemName
	names the system the rally was on. Same text as the Mask Admin > Discord default templates. */
function rally_discord_payload($action, $who, $systemLabel = null, $systemName = null, $urlBase = null, $chainLabel = '') {
	$who = rally_discord_clean($who !== null && $who !== '' ? $who : 'someone');
	if ($action === 'clear') {
		$content = 'Tripwire rally point cleared by *' . $who . '*';
		if ($systemName !== null && $systemName !== '') $content .= ' (was on ' . rally_discord_with_label($chainLabel, $systemName) . ')';
	} else {
		$content = 'Tripwire rally point from *' . $who . '*: **' . rally_discord_with_label($chainLabel, $systemLabel) . '**';
		$urlBase = preg_replace('/[<>\s]+/', '', (string)$urlBase);	// can't break out of the <autolink>
		if ($urlBase !== '' && $systemName !== null && $systemName !== '') {
			$content .= "\n<" . $urlBase . '/?system=' . rawurlencode($systemName) . '>';
		}
	}
	return array('content' => $content, 'allowed_mentions' => array('parse' => array()));
}

/** The edit that ends a rally message: $previous (its text as posted) struck through, then $action 'clear'
	("Cleared by *who* at <time>") or 'moved' ("Moved to **AB · J152820** by *who* at <time>"; $systemName and
	$chainLabel: where it moved). <time> is a Discord timestamp, shown in each reader's own time zone. */
function rally_discord_end_payload($previous, $action, $who, $time, $systemName = null, $chainLabel = '') {
	$who = rally_discord_clean($who !== null && $who !== '' ? $who : 'someone');
	$line = $action === 'moved'
		? 'Moved to **' . rally_discord_with_label($chainLabel, $systemName) . '** by *' . $who . '*'
		: 'Cleared by *' . $who . '*';
	$struck = discord_rally_strike($previous);
	$content = ($struck !== '' ? $struck . "\n" : '') . $line . ' at ' . discord_timestamp($time);
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

/** The chain label of a system (discord_chain_label in discord/rally.php), '' when there is none or it can't be read */
function rally_discord_chain_label($mysql, $mask, $systemID) {
	if (!function_exists('discord_chain_label')) return '';
	try {
		return discord_chain_label($mysql, $mask, $systemID);
	} catch (Throwable $e) {
		return '';
	}
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
	Runs under a per-mask lock and sends the rally as stored when the lock is held (see the header), so
	the last change to finish always leaves Discord showing the final rally.
	@param $hook the mask's legacy webhook (rally_discord_route()'s 'hook')
	@param $action the change that triggered this, 'set' or 'clear' (only used to name who cleared)
	@param $who the character that made the change
	@param $previousSystemID unused since the cleared text is the struck rally message (kept for callers)
	@return 'post' | 'edit' | 'none' (nothing to send) | 'failed' */
function rally_discord_notify($mysql, $mask, $hook, $action, $who, $previousSystemID = 0) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_rally_discord_message (
		maskID decimal(12,1) NOT NULL,
		messageID varchar(32) DEFAULT NULL,
		content text,
		postedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (maskID)
	)');
	if ($created === false) { error_log('rally discord: could not create fork_rally_discord_message'); return 'failed'; }

	// Wait behind any send in progress for this mask (each send is at most a few 5 s requests)
	$lockName = 'rally_discord_' . $mask;
	if (!rally_discord_lock($mysql, $lockName, 20)) { error_log('rally discord: lock timeout for mask ' . $mask); return 'failed'; }

	try {
		$stmt = $mysql->prepare('SELECT messageID, content, TIMESTAMPDIFF(SECOND, postedAt, NOW()) AS age FROM fork_rally_discord_message WHERE maskID = :mask');
		$stmt->bindValue(':mask', $mask);
		$last = $stmt->execute() ? $stmt->fetch(PDO::FETCH_ASSOC) : null;
		// The live message: posted (an id) with its text
		$live = $last && !empty($last['messageID']) && isset($last['content']) && $last['content'] !== '' ? $last : null;
		$forget = function() use ($mysql, $mask) {
			$stmt = $mysql->prepare('DELETE FROM fork_rally_discord_message WHERE maskID = :mask');
			$stmt->bindValue(':mask', $mask);
			$stmt->execute();
		};

		// What Discord should show: the rally as it is now, not necessarily this request's change
		$rally = rally_discord_current_rally($mysql, $mask);
		if (!$rally) {
			// Cleared (by this request, or by someone else's that didn't post): end the live message, post nothing
			if (!$live) return 'none';
			$payload = rally_discord_end_payload($live['content'], 'clear', $action === 'clear' ? $who : null, time());
			$forget();	// ended either way: a failed edit (deleted, unreachable) is not retried
			return rally_discord_send(rally_discord_message_url($hook, $live['messageID']), $payload, 'PATCH') !== false ? 'edit' : 'failed';
		}

		$appData = rally_discord_app_data();
		$systemID = $rally['systemID'];
		$system = isset($appData['systems'][$systemID]) ? $appData['systems'][$systemID] : null;
		$region = $system && isset($system['regionID']) && isset($appData['regions'][$system['regionID']]) ? $appData['regions'][$system['regionID']] : null;
		$systemLabel = rally_discord_system_label($system, $region);
		if ($systemLabel === null) $systemLabel = (string)$systemID;
		$systemName = $system ? $system['name'] : (string)$systemID;
		$chainLabel = rally_discord_chain_label($mysql, $mask, $systemID);
		$urlBase = rally_discord_url_base(defined('EVE_SSO_REDIRECT') ? EVE_SSO_REDIRECT : null, isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '');
		$payload = rally_discord_payload('set', $rally['setBy'], $systemLabel, $system ? $system['name'] : null, $urlBase, $chainLabel);

		if ($live && rally_discord_decision($live) === 'edit') {
			if ($payload['content'] === $live['content']) return 'none';	// already shows it
			if (rally_discord_send(rally_discord_message_url($hook, $live['messageID']), $payload, 'PATCH') !== false) {
				$save = $mysql->prepare('UPDATE fork_rally_discord_message SET content = :content WHERE maskID = :mask');
				$save->bindValue(':content', $payload['content']);
				$save->bindValue(':mask', $mask);
				$save->execute();
				return 'edit';
			}
			// Message gone (deleted, 404) or Discord unreachable: post a new one instead, and still try to end the
			// old one below (harmless when it is gone)
		}

		// The live row stays as it is until the new message is out: a failed post keeps the old message tracked
		$response = rally_discord_send(rally_discord_message_url($hook), $payload, 'POST');
		if ($response === false) return 'failed';
		if (isset($response['id']) && preg_match('/^\d{1,32}$/', (string)$response['id'])) {
			$save = $mysql->prepare('INSERT INTO fork_rally_discord_message (maskID, messageID, content, postedAt) VALUES (:mask, :messageID, :content, NOW())
				ON DUPLICATE KEY UPDATE messageID = VALUES(messageID), content = VALUES(content), postedAt = VALUES(postedAt)');
			$save->bindValue(':mask', $mask);
			$save->bindValue(':messageID', (string)$response['id']);
			$save->bindValue(':content', $payload['content']);
			$save->execute();
		} else {
			$forget();	// posted without an id: can't be edited
		}
		// Moved: end the old message (after the new one is out, so people see the new place first)
		if ($live) {
			rally_discord_send(rally_discord_message_url($hook, $live['messageID']),
				rally_discord_end_payload($live['content'], 'moved', $rally['setBy'], time(), $systemName, $chainLabel), 'PATCH');
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
