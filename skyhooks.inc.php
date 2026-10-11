<?php
// Fork-owned: raidable skyhooks list, cached once for the whole server (see changes/2026-10-11-raidable-skyhooks).
//
// ESI's GET /skyhooks/raidable is public but allows only 30 requests per 15 minutes per IP, so browsers never call
// it: public/skyhooks.php serves this cache, which is refreshed from ESI at most once per SKYHOOKS_TTL seconds for all
// users. The refresh runs under an exclusive flock so concurrent requests don't stampede ESI; the others get the old
// copy. When ESI fails or asks us to wait (esi/esi.inc.php limits), the old copy is served and ESI is not asked
// again for SKYHOOKS_RETRY seconds.
//
// The route needs a newer compatibility date than the one pinned for the rest of the fork (ESI_COMPATIBILITY_DATE
// answers 404): the date is sent for this one call only, as a header esi_request() leaves alone.

require_once(__DIR__ . '/esi/esi.inc.php');

const SKYHOOKS_URL = 'https://esi.evetech.net/skyhooks/raidable';
const SKYHOOKS_COMPATIBILITY_DATE = '2026-10-01';
const SKYHOOKS_TTL = 300;       // ESI's own Cache-Control: max-age
const SKYHOOKS_RETRY = 60;      // seconds to wait after a failed refresh
const SKYHOOKS_LOCK_WAIT = 10;  // seconds a request with no copy at all waits for another request's refresh

/** [{planetID, systemID, start, end}] (unix seconds) from ESI's JSON body, or null if it isn't the expected shape */
function skyhooks_parse($body) {
	$data = json_decode((string) $body, true);
	if (!is_array($data) || !isset($data['skyhooks']) || !is_array($data['skyhooks'])) return null;
	$list = array();
	foreach ($data['skyhooks'] as $row) {
		if (!is_array($row) || !isset($row['planet_id'], $row['solar_system_id'])) continue;
		$window = isset($row['theft_vulnerability']) && is_array($row['theft_vulnerability']) ? $row['theft_vulnerability'] : array();
		$start = isset($window['start']) ? strtotime((string) $window['start']) : false;
		$end = isset($window['end']) ? strtotime((string) $window['end']) : false;
		if ($start === false || $end === false || $end <= $start) continue;
		$list[] = array('planetID' => (int) $row['planet_id'], 'systemID' => (int) $row['solar_system_id'], 'start' => $start, 'end' => $end);
	}
	return $list;
}

/** Normalised cache content: {fetched, attempted, skyhooks[], error}; anything damaged reads as empty */
function skyhooks_cache_normalise($cache) {
	$cache = is_array($cache) ? $cache : array();
	return array(
		'fetched'   => isset($cache['fetched']) && is_numeric($cache['fetched']) ? (int) $cache['fetched'] : 0,
		'attempted' => isset($cache['attempted']) && is_numeric($cache['attempted']) ? (int) $cache['attempted'] : 0,
		'skyhooks'  => isset($cache['skyhooks']) && is_array($cache['skyhooks']) ? array_values($cache['skyhooks']) : array(),
		'error'     => isset($cache['error']) && is_string($cache['error']) ? $cache['error'] : null,
	);
}

/** Whether this request should ask ESI: the copy is older than the TTL and the last attempt was long enough ago */
function skyhooks_needs_refresh(array $cache, $now) {
	return $now - $cache['fetched'] >= SKYHOOKS_TTL && $now - $cache['attempted'] >= SKYHOOKS_RETRY;
}

function skyhooks_cache_file(?string $set = null) {
	static $file = null;
	if ($set !== null) $file = $set;
	if ($file === null) {
		$dir = __DIR__ . '/cache';
		$file = (is_dir($dir) && is_writable($dir) ? $dir : sys_get_temp_dir()) . '/skyhooks.json';
	}
	return $file;
}

/** Lock file next to the cache file; named *.json too, as cache/.gitignore ignores only *.json */
function skyhooks_lock_file($file) {
	return preg_replace('/(\.json)?$/', '.lock.json', $file, 1);
}

function skyhooks_read_cache($file) {
	$raw = @file_get_contents($file);
	return skyhooks_cache_normalise($raw ? json_decode($raw, true) : null);
}

/** Atomic write through a temp file (named *.tmp.json: cache/.gitignore ignores only *.json); false if it failed */
function skyhooks_write_cache($file, array $cache) {
	$tmp = $file . '.' . getmypid() . '.tmp.json';
	if (@file_put_contents($tmp, json_encode($cache)) === false) { @unlink($tmp); return false; }
	@chmod($tmp, 0666);
	if (!@rename($tmp, $file)) { @unlink($tmp); return false; }
	return true;
}

/**
 * When the cache can't be written, nobody could see that ESI was asked, so every request would ask again. The time of
 * the last ESI attempt is then kept in the lock file instead (it is only ever written under the lock).
 */
function skyhooks_backoff_read($lockFile) {
	$raw = @file_get_contents($lockFile);
	return $raw !== false && ctype_digit(trim($raw)) ? (int) $raw : 0;
}

/** One ESI call; @return [skyhooks list or null, error text or null] */
function skyhooks_fetch_esi() {
	[$status, $body] = esi_request('GET', SKYHOOKS_URL, array(
		'Accept: application/json',
		'X-Compatibility-Date: ' . SKYHOOKS_COMPATIBILITY_DATE,
	), null, 15);
	if ($status !== 200) return array(null, $status === -1 ? (string) $body : 'ESI answered ' . $status);
	$list = skyhooks_parse($body);
	return $list === null ? array(null, 'ESI answered with an unexpected body') : array($list, null);
}

/**
 * The cached list, refreshed when due.
 * @param callable|null $fetch () => [list|null, error|null]; default: ESI
 * @return array {skyhooks[], fetched (unix seconds, 0 = never), stale (bool), unavailable (bool: no list yet), error (string|null)}
 */
function skyhooks_get(?callable $fetch = null, $now = null, ?string $file = null) {
	$fetch = $fetch ?: 'skyhooks_fetch_esi';
	$now = $now ?? time();
	$file = $file ?? skyhooks_cache_file();
	$lockFile = skyhooks_lock_file($file);
	$cache = skyhooks_read_cache($file);
	$cache['attempted'] = max($cache['attempted'], skyhooks_backoff_read($lockFile));

	if (skyhooks_needs_refresh($cache, $now)) {
		$lock = @fopen($lockFile, 'c');
		if ($lock) {
			@chmod($lockFile, 0666);
			// Somebody else refreshing: a request with a copy uses it, one without waits a little for the result
			$got = flock($lock, LOCK_EX | LOCK_NB);
			if (!$got && !$cache['fetched']) {
				for ($i = 0; $i < SKYHOOKS_LOCK_WAIT * 10 && !$got; $i++) {
					usleep(100000);
					$got = flock($lock, LOCK_EX | LOCK_NB);
				}
			}
			if ($got) {
				try {
					$cache = skyhooks_read_cache($file);   // another request may have refreshed while we waited
					$cache['attempted'] = max($cache['attempted'], skyhooks_backoff_read($lockFile));
					if (skyhooks_needs_refresh($cache, $now)) {
						[$list, $error] = $fetch();
						$cache['attempted'] = $now;
						if ($list !== null) {
							$cache['fetched'] = $now;
							$cache['skyhooks'] = $list;
							$cache['error'] = null;
						} else {
							$cache['error'] = $error;
							esi_log('skyhooks refresh failed: ' . $error);
						}
						if (!skyhooks_write_cache($file, $cache)) {
							// Remember the attempt where we can, and say so (once per backoff, not per request)
							@file_put_contents($lockFile, (string) $now);
							esi_log('cannot write ' . $file . ': skyhooks are asked from ESI at most every ' . SKYHOOKS_RETRY . ' s until it can');
						}
					}
				} finally {
					flock($lock, LOCK_UN);
				}
			} else {
				$cache = skyhooks_read_cache($file);
			}
			fclose($lock);
		}
	}
	return array(
		'skyhooks' => $cache['skyhooks'],
		'fetched'  => $cache['fetched'],
		'stale'    => $now - $cache['fetched'] >= 2 * SKYHOOKS_TTL,
		// No list at all (ESI failed or the cache can't be written): "no skyhooks" would be wrong
		'unavailable' => $cache['fetched'] === 0,
		'error'    => $cache['error'],
	);
}
