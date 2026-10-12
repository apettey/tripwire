<?php
// Fork-owned (environment tags, see changes/2026-10-12-environment-tags): the server-wide copy of EVE-Scout's public
// observations list, used through public/cached_third_party.php (key eve-scout-observations).
//
// Before anything is cached the list is stripped to what the chain map needs (storms only; category, type, system, time
// reported and hours in the system), so reporter names and ids never reach the browser. The copy is written atomically
// (temp file + rename), and a failed refresh leaves the old copy and its age alone: it is served as it is, and
// EVE-Scout is asked again at most every ENVIRONMENT_TAGS_RETRY seconds.

const ENVIRONMENT_TAGS_RETRY = 60;
const ENVIRONMENT_TAGS_KEEP = ['observation_category', 'observation_type', 'system_id', 'created_at', 'hours_in_system'];

/** The storms of an observations body with only the kept fields, as JSON; null when the body is not a list */
function environment_tags_strip_observations($body) {
	$list = json_decode((string) $body, true);
	if (!is_array($list)) return null;
	$out = array();
	foreach ($list as $row) {
		if (!is_array($row) || ($row['observation_category'] ?? null) !== 'storm') continue;
		$keep = array();
		foreach (ENVIRONMENT_TAGS_KEEP as $k) if (array_key_exists($k, $row)) $keep[$k] = $row[$k];
		$out[] = $keep;
	}
	return json_encode($out);
}

function environment_tags_fetch($url) {
	$context = stream_context_create(array('http' => array('timeout' => 15, 'header' => "Accept: application/json\r\nUser-Agent: Tripwire-fork\r\n")));
	$body = @file_get_contents($url, false, $context);
	return $body === false ? null : $body;
}

/**
 * Refresh the cache file when it is older than $ttl.
 * @param callable|null $fetch url => body string or null (default: HTTP GET)
 * @return bool whether a copy (fresh or stale) is available to serve
 */
function environment_tags_refresh($url, $cache_file, $ttl, ?callable $fetch = null, $now = null) {
	$now = $now ?? time();
	$retry_file = preg_replace('/\.json$/', '', $cache_file) . '.retry.json';	// *.json: cache/.gitignore ignores only those
	$exists = file_exists($cache_file);
	if ($exists && $now - filemtime($cache_file) < $ttl) return true;
	if (file_exists($retry_file) && $now - filemtime($retry_file) < ENVIRONMENT_TAGS_RETRY) return $exists;
	$json = environment_tags_strip_observations(($fetch ?: 'environment_tags_fetch')($url));
	if ($json !== null) {
		$tmp = $cache_file . '.' . getmypid() . '.tmp.json';
		if (@file_put_contents($tmp, $json) !== false && @rename($tmp, $cache_file)) {
			@chmod($cache_file, 0666);
			@unlink($retry_file);
			return true;
		}
		@unlink($tmp);
	}
	@touch($retry_file);	// failed: keep the old copy (and its age), try again later
	return $exists;
}
