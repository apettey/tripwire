<?php
// Fork-owned: market prices of the items in wormhole gas and ore sites (see changes/2026-11-15-site-value-estimate).
//
// ESI's GET /markets/prices/ is public (no key) and lists the average price of every item (about 16,000 rows), so
// browsers never load it: public/market_prices.php serves a small copy with only the items in
// public/site-values/sites.json, refreshed from ESI at most once per MARKET_PRICES_TTL seconds for all users. The
// refresh runs under an exclusive flock so concurrent requests don't stampede ESI; the others get the old copy. When
// ESI fails or asks us to wait (esi/esi.inc.php limits), the old copy is served and ESI is not asked again for
// MARKET_PRICES_RETRY seconds. With no copy at all the browser falls back to the prices stored in sites.json.

require_once(__DIR__ . '/esi/esi.inc.php');

const MARKET_PRICES_URL = 'https://esi.evetech.net/markets/prices/';
const MARKET_PRICES_TTL = 3600;     // ESI updates the list about once an hour
const MARKET_PRICES_RETRY = 300;    // seconds to wait after a failed refresh

/** Type ids whose prices we keep: every item in a site of public/site-values/sites.json */
function market_prices_types(?string $sitesFile = null) {
	$sitesFile = $sitesFile ?? __DIR__ . '/public/site-values/sites.json';
	$data = json_decode((string) @file_get_contents($sitesFile), true);
	$ids = array();
	if (is_array($data) && isset($data['types']) && is_array($data['types'])) {
		foreach ($data['types'] as $id => $type) {
			if (ctype_digit((string) $id)) $ids[(int) $id] = true;
			// ore is priced as its compressed form
			if (is_array($type) && isset($type['priceAs']) && ctype_digit((string) $type['priceAs'])) $ids[(int) $type['priceAs']] = true;
		}
	}
	return $ids;
}

/** {typeID: price} for the wanted types from ESI's body, or null if it isn't the expected shape. Only average_price (the
market average) counts: adjusted_price is CCP's industry/tax value, often far off the market (a type without an average
is left out, and the browser uses the price stored in sites.json for it). */
function market_prices_parse($body, array $wanted) {
	$rows = json_decode((string) $body, true);
	if (!is_array($rows) || ($rows && !isset($rows[0]))) return null;
	$prices = array();
	foreach ($rows as $row) {
		if (!is_array($row) || !isset($row['type_id']) || !isset($wanted[(int) $row['type_id']])) continue;
		$price = isset($row['average_price']) && is_numeric($row['average_price']) && $row['average_price'] > 0 ? $row['average_price'] : null;
		if ($price !== null) $prices[(string) (int) $row['type_id']] = round((float) $price, 2);
	}
	return $prices;
}

/** Normalised cache content: {fetched, attempted, prices{}}; anything damaged reads as empty */
function market_prices_normalise($cache) {
	$cache = is_array($cache) ? $cache : array();
	$prices = array();
	if (isset($cache['prices']) && is_array($cache['prices'])) {
		foreach ($cache['prices'] as $id => $price) if (ctype_digit((string) $id) && is_numeric($price)) $prices[(string) $id] = (float) $price;
	}
	return array(
		'fetched'   => isset($cache['fetched']) && is_numeric($cache['fetched']) ? (int) $cache['fetched'] : 0,
		'attempted' => isset($cache['attempted']) && is_numeric($cache['attempted']) ? (int) $cache['attempted'] : 0,
		'prices'    => $prices,
		'types'     => isset($cache['types']) && is_string($cache['types']) ? $cache['types'] : '',
	);
}

function market_prices_cache_file() {
	$dir = __DIR__ . '/cache';
	return (is_dir($dir) && is_writable($dir) ? $dir : sys_get_temp_dir()) . '/market-prices.json';
}

function market_prices_read($file) {
	$raw = @file_get_contents($file);
	return market_prices_normalise($raw ? json_decode($raw, true) : null);
}

/** Atomic write through a temp file (named *.tmp.json: cache/.gitignore ignores only *.json) */
function market_prices_write($file, array $cache) {
	$tmp = $file . '.' . getmypid() . '.tmp.json';
	if (@file_put_contents($tmp, json_encode($cache)) === false) { @unlink($tmp); return false; }
	@chmod($tmp, 0666);
	if (!@rename($tmp, $file)) { @unlink($tmp); return false; }
	return true;
}

/** One ESI call; @return [prices or null, error text or null] */
function market_prices_fetch_esi(array $wanted) {
	[$status, $body] = esi_request('GET', MARKET_PRICES_URL, array('Accept: application/json'), null, 20);
	if ($status !== 200) return array(null, $status === -1 ? (string) $body : 'ESI answered ' . $status);
	$prices = market_prices_parse($body, $wanted);
	if ($prices === null) return array(null, 'ESI answered with an unexpected body');
	return array($prices, null);
}

/** Whether a refresh result is complete enough to replace the copy: at least half the wanted types have a price
(an empty or cut-off answer would otherwise wipe good prices for an hour) */
function market_prices_enough(array $prices, array $wanted) {
	return count($wanted) > 0 && count($prices) * 2 >= count($wanted);
}

/**
 * The cached prices, refreshed when due.
 * @param callable|null $fetch (wanted types) => [prices|null, error|null]; default: ESI
 * @return array {prices{typeID: ISK}, fetched (unix seconds, 0 = never)}
 */
function market_prices_get(?callable $fetch = null, $now = null, ?string $file = null, ?array $wanted = null) {
	$fetch = $fetch ?: 'market_prices_fetch_esi';
	$now = $now ?? time();
	$file = $file ?? market_prices_cache_file();
	$cache = market_prices_read($file);
	$wanted = $wanted ?? market_prices_types();
	ksort($wanted);
	$types = implode(',', array_keys($wanted));
	// due after the TTL, or at once when sites.json now wants other items than the copy has; never within the retry wait
	$due = function($c) use ($now, $types) { return ($now - $c['fetched'] >= MARKET_PRICES_TTL || $c['types'] !== $types) && $now - $c['attempted'] >= MARKET_PRICES_RETRY; };

	if ($due($cache)) {
		$lock = @fopen(preg_replace('/(\.json)?$/', '.lock.json', $file, 1), 'c');
		if ($lock && flock($lock, LOCK_EX | LOCK_NB)) {
			try {
				$cache = market_prices_read($file);   // another request may have refreshed meanwhile
				if ($due($cache)) {
					[$prices, $error] = $fetch($wanted);
					$cache['attempted'] = $now;
					if ($prices !== null && !market_prices_enough($prices, $wanted)) {
						$error = 'ESI answered with prices for only ' . count($prices) . ' of ' . count($wanted) . ' items';
						$prices = null;
					}
					if ($prices !== null) {
						$cache['fetched'] = $now;
						$cache['prices'] = $prices;
						$cache['types'] = $types;
					} else {
						esi_log('market prices refresh failed: ' . $error);
					}
					market_prices_write($file, $cache);
				}
			} finally {
				flock($lock, LOCK_UN);
			}
		}
		if ($lock) fclose($lock);
	}
	return array('prices' => (object) $cache['prices'], 'fetched' => $cache['fetched']);
}
