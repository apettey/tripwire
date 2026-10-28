<?php
// Fork-owned: say "EVE is down" instead of "Unknown error" when an EVE SSO login or registration fails because
// CCP's servers aren't answering (daily downtime at 11:00 UTC, or an outage). login.php and register.php send every
// failure to ./?error=<login|register|registeradmin>-unknown; fork_sso_downtime_redirects() (called after the SSO
// state check, so a stale or forged callback never gets here) changes that redirect to <...>-downtime, just before
// the headers go out, when ESI's status endpoint doesn't answer 200. landing.php shows the message. Only failed
// logins ask ESI, through the fork's ESI rate-limit layer, and the answer is cached for 30 s. A login refused for a
// reason of our own (X-Login-Error other than an ESI error, e.g. a ban) keeps "Unknown error".

require_once(__DIR__ . '/esi/esi.inc.php');

define('FORK_SSO_DOWNTIME_CACHE', dirname(esi_limit_state_file()) . '/sso-esi-status.json');
define('FORK_SSO_DOWNTIME_CACHE_TTL', 30);

// The redirect to use instead of $location when ESI is down, else null. $esiUp: callable returning true/false.
function fork_sso_downtime_location($location, $esiUp) {
	$location = (string) $location;
	if (!preg_match('/[?&]error=(?:login|register|registeradmin)-unknown(?=[&#]|$)/', $location)) return null;
	if (call_user_func($esiUp)) return null;
	return preg_replace('/([?&]error=(?:login|register|registeradmin))-unknown(?=[&#]|$)/', '$1-downtime', $location, 1);
}

// True when ESI's status endpoint answers 200 within a few seconds, false when not, null when the rate-limit layer
// says to wait (not asked: we can't tell).
function fork_sso_downtime_esi_up($url = 'https://esi.evetech.net/status/') {
	$headers = array();
	if (esi_before_request($url, $headers) !== null) return null;
	$curl = curl_init($url);
	curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
	curl_setopt($curl, CURLOPT_HTTPHEADER, $headers);
	curl_setopt($curl, CURLOPT_CONNECTTIMEOUT, 3);
	curl_setopt($curl, CURLOPT_TIMEOUT, 4);
	if (defined('USER_AGENT')) curl_setopt($curl, CURLOPT_USERAGENT, USER_AGENT);
	$responseHeaders = array();
	curl_setopt($curl, CURLOPT_HEADERFUNCTION, esi_header_collector($responseHeaders));
	$ok = curl_exec($curl) !== false;
	$status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
	esi_after_response($url, $status, $responseHeaders, $headers);
	return $ok && $status == 200;
}

// fork_sso_downtime_esi_up(), remembered for FORK_SSO_DOWNTIME_CACHE_TTL seconds. Can't tell counts as up (not cached).
function fork_sso_downtime_esi_up_cached() {
	$file = FORK_SSO_DOWNTIME_CACHE;
	$mtime = @filemtime($file);
	if ($mtime !== false && time() - $mtime < FORK_SSO_DOWNTIME_CACHE_TTL) {
		$cached = json_decode((string) @file_get_contents($file), true);
		if (is_array($cached) && is_bool($cached['up'] ?? null)) return $cached['up'];
	}
	$up = fork_sso_downtime_esi_up();
	if ($up === null) return true;
	@file_put_contents($file, json_encode(array('up' => $up)), LOCK_EX);
	return $up;
}

// Rewrites this request's "-unknown" error redirect when ESI is down. Call once, before any output.
function fork_sso_downtime_redirects() {
	header_register_callback(function () {
		$location = null;
		foreach (headers_list() as $header) {
			if (stripos($header, 'X-Login-Error:') === 0 && trim(substr($header, 14)) !== 'EVE ESI error.') return;
			if ($location === null && stripos($header, 'Location:') === 0) $location = trim(substr($header, 9));
		}
		if ($location === null) return;
		$location = fork_sso_downtime_location($location, 'fork_sso_downtime_esi_up_cached');
		if ($location !== null) header('Location: ' . $location);
	});
}
