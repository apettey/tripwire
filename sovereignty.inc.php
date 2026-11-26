<?php
// Fork-owned: sovereignty and incursions for the region map's Sovereignty overlay (see
// changes/2026-11-26-region-map-sovereignty). public/region_sov.php serves it; browsers never call ESI for it.
//
// Three server-wide caches in cache/, shared by every user (one ESI fetch per period for everyone):
//   sov-map.json        GET /sovereignty/map (every k-space system: alliance + corporation, NPC faction, or nobody),
//                       refreshed at most every SOV_MAP_TTL (ESI's own cache time, 1 h), stored compact
//   sov-incursions.json GET /incursions, refreshed at most every SOV_INCURSIONS_TTL
//   sov-alliances.json  alliance names and tickers: POST /universe/names for the names of a region's holders (one
//                       call), GET /alliances/{id} for the tickers; kept SOV_ALLIANCE_TTL, at most
//                       SOV_ALLIANCE_PER_PASS lookups per request, so a region's holders are named on first use
// Faction warfare is not here: public/cached_third_party.php?key=fw already caches GET /fw/systems (app/js/fw.js).
// Refreshes run under an exclusive flock so concurrent requests don't stampede ESI; the others use the old copy.
// When ESI fails or asks us to wait (esi/esi.inc.php limits), the old copy is served and ESI is not asked again for
// SOV_RETRY seconds. Angel / Guristas insurgencies are not in ESI at all, so they are not shown.

require_once(__DIR__ . '/esi/esi.inc.php');

const SOV_ESI = 'https://esi.evetech.net/';
const SOV_MAP_TTL = 3600;            // ESI: Cache-Control max-age=3600
const SOV_INCURSIONS_TTL = 600;      // ESI caches 5 minutes; 10 is plenty for a map
const SOV_RETRY = 120;               // seconds to wait after a failed refresh
const SOV_LOCK_WAIT = 10;            // seconds a request with no copy at all waits for another request's refresh
const SOV_ALLIANCE_TTL = 604800;     // alliance names and tickers are looked up again after a week
const SOV_ALLIANCE_RETRY = 900;      // an alliance ESI could not answer for is asked again after this long
const SOV_ALLIANCE_PER_PASS = 40;    // GET /alliances/{id} per request at most
const SOV_ALLIANCE_SECONDS = 6;      // no new alliance lookup after this long in one request
const SOV_REGION_DIR = __DIR__ . '/public/region-map';

// ---- Parsing ESI ----

/** {systemID: {a: allianceID, c: corporationID} | {f: factionID}} from GET /sovereignty/map; unclaimed systems are
 * left out. null if the body isn't the expected shape */
function sov_parse_map($body) {
	$data = json_decode((string) $body, true);
	if (!is_array($data) || ($data && !array_is_list($data))) return null;
	$out = array();
	foreach ($data as $row) {
		if (!is_array($row) || !isset($row['system_id']) || !is_numeric($row['system_id'])) continue;
		$id = (int) $row['system_id'];
		if (isset($row['alliance_id']) && is_numeric($row['alliance_id']) && (int) $row['alliance_id'] > 0) {
			$out[$id] = array('a' => (int) $row['alliance_id'], 'c' => isset($row['corporation_id']) && is_numeric($row['corporation_id']) ? (int) $row['corporation_id'] : 0);
		} elseif (isset($row['faction_id']) && is_numeric($row['faction_id']) && (int) $row['faction_id'] > 0) {
			$out[$id] = array('f' => (int) $row['faction_id']);
		}
	}
	return $out;
}

/** [{constellationID, factionID, boss, systems[], influence, staging, state, type}] from GET /incursions, or null */
function sov_parse_incursions($body) {
	$data = json_decode((string) $body, true);
	if (!is_array($data) || ($data && !array_is_list($data))) return null;
	$out = array();
	foreach ($data as $row) {
		if (!is_array($row) || !isset($row['constellation_id']) || !is_numeric($row['constellation_id'])) continue;
		$systems = array();
		foreach (isset($row['infested_solar_systems']) && is_array($row['infested_solar_systems']) ? $row['infested_solar_systems'] : array() as $id) {
			if (is_numeric($id)) $systems[] = (int) $id;
		}
		$state = isset($row['state']) && in_array($row['state'], array('mobilizing', 'established', 'withdrawing'), true) ? $row['state'] : 'established';
		$out[] = array(
			'constellationID' => (int) $row['constellation_id'],
			'factionID' => isset($row['faction_id']) && is_numeric($row['faction_id']) ? (int) $row['faction_id'] : 0,
			'boss' => !empty($row['has_boss']),
			'systems' => $systems,
			'influence' => isset($row['influence']) && is_numeric($row['influence']) ? (float) max(0, min(1, round((float) $row['influence'], 3))) : 0,
			'staging' => isset($row['staging_solar_system_id']) && is_numeric($row['staging_solar_system_id']) ? (int) $row['staging_solar_system_id'] : 0,
			'state' => $state,
			'type' => isset($row['type']) && is_string($row['type']) ? mb_substr($row['type'], 0, 40) : 'Incursion',
		);
	}
	return $out;
}

/** Text from ESI made safe to store: no control characters, at most $max characters */
function sov_clean_text($s, $max) {
	return mb_substr(trim(preg_replace('/[\x00-\x1F\x7F]/u', '', (string) $s) ?? ''), 0, $max);
}

// ---- One cached ESI feed (sovereignty map, incursions) ----

function sov_cache_dir(?string $set = null) {
	static $dir = null;
	if ($set !== null) $dir = $set;
	if ($dir === null) {
		$base = __DIR__ . '/cache';
		$dir = is_dir($base) && is_writable($base) ? $base : sys_get_temp_dir();
	}
	return $dir;
}

/** Lock file next to a cache file; named *.json too, as cache/.gitignore ignores only *.json */
function sov_lock_file($file) {
	return preg_replace('/(\.json)?$/', '.lock.json', $file, 1);
}

/** {fetched, attempted, data, error}; anything damaged reads as empty */
function sov_feed_read($file) {
	$raw = @file_get_contents($file);
	$c = $raw ? json_decode($raw, true) : null;
	$c = is_array($c) ? $c : array();
	return array(
		'fetched'   => isset($c['fetched']) && is_numeric($c['fetched']) ? (int) $c['fetched'] : 0,
		'attempted' => isset($c['attempted']) && is_numeric($c['attempted']) ? (int) $c['attempted'] : 0,
		'data'      => isset($c['data']) && is_array($c['data']) ? $c['data'] : array(),
		'error'     => isset($c['error']) && is_string($c['error']) ? $c['error'] : null,
	);
}

/** Atomic write through a temp file (named *.tmp.json: cache/.gitignore ignores only *.json); false if it failed */
function sov_write_json($file, $value) {
	$tmp = $file . '.' . getmypid() . '.tmp.json';
	if (@file_put_contents($tmp, json_encode($value)) === false) { @unlink($tmp); return false; }
	@chmod($tmp, 0666);
	if (!@rename($tmp, $file)) { @unlink($tmp); return false; }
	return true;
}

/** When the cache can't be written, the time of the last ESI attempt is kept in the lock file instead */
function sov_backoff_read($lockFile) {
	$raw = @file_get_contents($lockFile);
	return $raw !== false && ctype_digit(trim($raw)) ? (int) $raw : 0;
}

function sov_feed_due(array $cache, $now, $ttl) {
	return $now - $cache['fetched'] >= $ttl && $now - $cache['attempted'] >= SOV_RETRY;
}

/**
 * A cached feed, refreshed when due.
 * @param callable $fetch () => [data array|null, error|null]
 * @return array {data, fetched (unix seconds, 0 = never), stale (bool), unavailable (bool: no copy at all), error}
 */
function sov_feed_get($file, $ttl, callable $fetch, $now) {
	$lockFile = sov_lock_file($file);
	$cache = sov_feed_read($file);
	$cache['attempted'] = max($cache['attempted'], sov_backoff_read($lockFile));
	if (sov_feed_due($cache, $now, $ttl)) {
		$lock = @fopen($lockFile, 'c');
		if ($lock) {
			@chmod($lockFile, 0666);
			// Somebody else refreshing: a request with a copy uses it, one without waits a little for the result
			$got = flock($lock, LOCK_EX | LOCK_NB);
			if (!$got && !$cache['fetched']) {
				for ($i = 0; $i < SOV_LOCK_WAIT * 10 && !$got; $i++) {
					usleep(100000);
					$got = flock($lock, LOCK_EX | LOCK_NB);
				}
			}
			if ($got) {
				try {
					$cache = sov_feed_read($file);   // another request may have refreshed while we waited
					$cache['attempted'] = max($cache['attempted'], sov_backoff_read($lockFile));
					if (sov_feed_due($cache, $now, $ttl)) {
						[$data, $error] = $fetch();
						$cache['attempted'] = $now;
						if ($data !== null) {
							$cache['fetched'] = $now;
							$cache['data'] = $data;
							$cache['error'] = null;
						} else {
							$cache['error'] = $error;
							esi_log(basename($file) . ' refresh failed: ' . $error);
						}
						if (!sov_write_json($file, $cache)) {
							@file_put_contents($lockFile, (string) $now);
							esi_log('cannot write ' . $file . ': it is asked from ESI at most every ' . SOV_RETRY . ' s until it can');
						}
					}
				} finally {
					flock($lock, LOCK_UN);
				}
			} else {
				$cache = sov_feed_read($file);
			}
			fclose($lock);
		}
	}
	return array(
		'data' => $cache['data'],
		'fetched' => $cache['fetched'],
		'stale' => $cache['fetched'] > 0 && $now - $cache['fetched'] >= 2 * $ttl,
		'unavailable' => $cache['fetched'] === 0,
		'error' => $cache['error'],
	);
}

/** One public ESI GET; @return [parsed|null, error|null] */
function sov_fetch_esi($route, callable $parse) {
	[$status, $body] = esi_request('GET', SOV_ESI . $route, array('Accept: application/json'), null, 15);
	if ($status !== 200) return array(null, $status === -1 ? (string) $body : 'ESI answered ' . ($status ?: 'nothing'));
	$parsed = $parse($body);
	return $parsed === null ? array(null, 'ESI answered with an unexpected body') : array($parsed, null);
}

// ---- Alliance names and tickers ----

/** {allianceID: {name, ticker, fetched, tried}}; anything damaged is dropped */
function sov_alliances_read($file) {
	$raw = @file_get_contents($file);
	$data = $raw ? json_decode($raw, true) : null;
	$out = array();
	foreach (is_array($data) ? $data : array() as $id => $row) {
		if (!is_numeric($id) || !is_array($row)) continue;
		$out[(int) $id] = array(
			'name' => isset($row['name']) && is_string($row['name']) ? $row['name'] : '',
			'ticker' => isset($row['ticker']) && is_string($row['ticker']) ? $row['ticker'] : '',
			'fetched' => isset($row['fetched']) && is_numeric($row['fetched']) ? (int) $row['fetched'] : 0,
			'tried' => isset($row['tried']) && is_numeric($row['tried']) ? (int) $row['tried'] : 0,
		);
	}
	return $out;
}

/** The alliances of $ids that need a lookup now: never looked up, or older than the TTL, and not tried just now */
function sov_alliances_due(array $known, array $ids, $now) {
	$due = array();
	foreach ($ids as $id) {
		$row = $known[$id] ?? null;
		if ($row && $row['ticker'] !== '' && $now - $row['fetched'] < SOV_ALLIANCE_TTL) continue;
		if ($row && $now - $row['tried'] < SOV_ALLIANCE_RETRY) continue;
		$due[] = $id;
	}
	return $due;
}

/** Default ESI lookups. names: POST /universe/names => {id: name} or null; one: GET /alliances/{id} => {name, ticker} or null */
function sov_alliance_lookups() {
	return array(
		'names' => function (array $ids) {
			[$status, $body] = esi_request('POST', SOV_ESI . 'universe/names', array('Accept: application/json', 'Content-Type: application/json'), json_encode(array_values($ids)), 10);
			if ($status !== 200) return null;
			$out = array();
			foreach (json_decode((string) $body, true) ?: array() as $row) {
				if (is_array($row) && ($row['category'] ?? '') === 'alliance' && isset($row['id'], $row['name'])) $out[(int) $row['id']] = (string) $row['name'];
			}
			return $out;
		},
		'one' => function ($id) {
			[$status, $body] = esi_request('GET', SOV_ESI . 'alliances/' . (int) $id, array('Accept: application/json'), null, 5);
			if ($status !== 200) return null;
			$data = json_decode((string) $body, true);
			return is_array($data) && isset($data['name']) ? array('name' => (string) $data['name'], 'ticker' => (string) ($data['ticker'] ?? '')) : null;
		},
	);
}

/**
 * Names and tickers of the alliances $ids, looking up the missing ones (under a lock; a request that finds it busy
 * serves what is known).
 * @return array [{allianceID: {name, ticker}}, pending (bool: some are still unnamed or without ticker and will be asked again)]
 */
function sov_alliances($ids, $now, ?array $lookups = null, ?string $file = null) {
	$file = $file ?? sov_cache_dir() . '/sov-alliances.json';
	$ids = array_values(array_unique(array_map('intval', $ids)));
	$known = sov_alliances_read($file);
	$due = sov_alliances_due($known, $ids, $now);
	if ($due) {
		$lookups = $lookups ?? sov_alliance_lookups();
		$lock = @fopen(sov_lock_file($file), 'c');
		if ($lock && flock($lock, LOCK_EX | LOCK_NB)) {
			try {
				$known = sov_alliances_read($file);
				$due = sov_alliances_due($known, $ids, $now);
				if ($due) {
					$unnamed = array_values(array_filter($due, function ($id) use ($known) { return !isset($known[$id]) || $known[$id]['name'] === ''; }));
					$names = $unnamed ? $lookups['names']($unnamed) : array();
					$started = microtime(true);
					$asked = 0;
					foreach ($due as $id) {
						$row = $known[$id] ?? array('name' => '', 'ticker' => '', 'fetched' => 0, 'tried' => 0);
						if (is_array($names) && isset($names[$id])) $row['name'] = sov_clean_text($names[$id], 100);
						if ($asked < SOV_ALLIANCE_PER_PASS && microtime(true) - $started < SOV_ALLIANCE_SECONDS) {
							$asked++;
							$info = $lookups['one']($id);
							$row['tried'] = $now;
							if (is_array($info) && $info['name'] !== '') {
								$row['name'] = sov_clean_text($info['name'], 100);
								$row['ticker'] = sov_clean_text($info['ticker'], 10);
								$row['fetched'] = $now;
							}
						}
						$known[$id] = $row;
					}
					@chmod(sov_lock_file($file), 0666);
					if (!sov_write_json($file, $known)) esi_log('cannot write ' . $file . ': alliance names are looked up again on each request');
				}
			} finally {
				flock($lock, LOCK_UN);
			}
		}
		if ($lock) fclose($lock);
	}
	$out = array();
	$pending = false;
	foreach ($ids as $id) {
		$row = $known[$id] ?? null;
		$out[$id] = array('name' => $row ? $row['name'] : '', 'ticker' => $row ? $row['ticker'] : '');
		// Not looked up yet (the per-request cap, or another request held the lock): the browser asks again soon
		if (!$row || ($row['ticker'] === '' && $now - $row['tried'] >= SOV_ALLIANCE_RETRY)) $pending = true;
	}
	return array($out, $pending);
}

// ---- One region ----

/** The system IDs of a k-space region, from its region map layout file (public/region-map/<id>.json); null if none */
function sov_region_systems($regionID, ?string $dir = null) {
	$regionID = (int) $regionID;
	if ($regionID <= 0) return null;
	$raw = @file_get_contents(($dir ?? SOV_REGION_DIR) . '/' . $regionID . '.json');
	$data = $raw ? json_decode($raw, true) : null;
	if (!is_array($data) || !isset($data['systems']) || !is_array($data['systems'])) return null;
	$ids = array();
	foreach ($data['systems'] as $row) {
		if (is_array($row) && isset($row[0]) && is_numeric($row[0])) $ids[] = (int) $row[0];
	}
	return $ids;
}

/** The region's part of the sovereignty map, and the alliances holding any of it */
function sov_region_shape(array $map, array $systemIDs) {
	$systems = array();
	$alliances = array();
	foreach ($systemIDs as $id) {
		$row = $map[$id] ?? $map[(string) $id] ?? null;
		if (!is_array($row)) continue;
		if (!empty($row['a'])) {
			$systems[$id] = array('a' => (int) $row['a'], 'c' => (int) ($row['c'] ?? 0));
			$alliances[(int) $row['a']] = true;
		} elseif (!empty($row['f'])) {
			$systems[$id] = array('f' => (int) $row['f']);
		}
	}
	return array($systems, array_keys($alliances));
}

/**
 * Everything the overlay needs for one region.
 * @param array $deps optional fakes for tests: map, incursions (callables => [data|null, error|null]), lookups, dir (cache), regionDir
 * @return array|null {region, systems, alliances, pending, incursions (all of them: a few), sov: {fetched, stale,
 *         unavailable, error}, incursionsStatus: {...}} or null for an unknown region
 */
function sov_region($regionID, $now = null, array $deps = array()) {
	$now = $now ?? time();
	$ids = sov_region_systems($regionID, $deps['regionDir'] ?? null);
	if ($ids === null) return null;
	$dir = $deps['dir'] ?? sov_cache_dir();
	$map = sov_feed_get($dir . '/sov-map.json', SOV_MAP_TTL, $deps['map'] ?? function () { return sov_fetch_esi('sovereignty/map', 'sov_parse_map'); }, $now);
	$inc = sov_feed_get($dir . '/sov-incursions.json', SOV_INCURSIONS_TTL, $deps['incursions'] ?? function () { return sov_fetch_esi('incursions', 'sov_parse_incursions'); }, $now);
	[$systems, $allianceIDs] = sov_region_shape($map['data'], $ids);
	[$alliances, $pending] = $allianceIDs ? sov_alliances($allianceIDs, $now, $deps['lookups'] ?? null, $dir . '/sov-alliances.json') : array(array(), false);
	$status = function ($f) { return array('fetched' => $f['fetched'], 'stale' => $f['stale'], 'unavailable' => $f['unavailable'], 'error' => $f['error']); };
	return array(
		'region' => (int) $regionID,
		'systems' => (object) $systems,
		'alliances' => (object) $alliances,
		'pending' => $pending,
		'incursions' => array_values($inc['data']),
		'sov' => $status($map),
		'incursionsStatus' => $status($inc),
	);
}
