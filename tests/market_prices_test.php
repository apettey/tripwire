<?php
// Fork-owned: tests for market_prices.inc.php (parse, cache, refresh interval, failed refresh) with a fake ESI; no network.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/market_prices_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../market_prices.inc.php');

$failures = 0;
function check($name, $actual, $expected) {
	global $failures;
	if ($actual !== $expected) {
		$failures++;
		fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
	}
}

$wanted = array(30378 => true, 22 => true, 20 => true);
$body = json_encode(array(
	array('type_id' => 30378, 'average_price' => 56236.6, 'adjusted_price' => 58530.29),
	array('type_id' => 22, 'adjusted_price' => 2714.577),           // no average: left out (adjusted is not a market price)
	array('type_id' => 20, 'average_price' => 0, 'adjusted_price' => 0),   // no usable price
	array('type_id' => 999, 'average_price' => 5),                  // not wanted
	'junk',
));
check('parse keeps wanted types with a price', market_prices_parse($body, $wanted), array('30378' => 56236.6));
check('parse: not json', market_prices_parse('<html>', $wanted), null);
check('parse: not a list', market_prices_parse('{"x":1}', $wanted), null);
check('parse: empty list', market_prices_parse('[]', $wanted), array());
check('normalise damaged', market_prices_normalise('x'), array('fetched' => 0, 'attempted' => 0, 'prices' => array(), 'types' => ''));
check('normalise drops bad rows', market_prices_normalise(array('prices' => array('22' => 5, 'x' => 1, '20' => 'abc')))['prices'], array('22' => 5.0));

$types = market_prices_types();
check('types come from sites.json', isset($types[30378]) && isset($types[22]) && count($types) >= 10, true);
check('types include the compressed ore the ore is priced as', isset($types[62568]), true);
// relic sites (changes/2026-11-15-relic-data-site-values): all 38 pirate salvage types of the Ruined expected-loot model
$salvage = 0;
for ($id = 25588; $id <= 25625; $id++) if (isset($types[$id])) $salvage++;
check('types include every relic salvage type (T1 and T2)', $salvage, 38);
check('types include Logic Circuit', isset($types[25619]), true);
// k-space gas and ore (changes/2026-11-21-all-gas-ore-site-values): the 8 Mykoserocin and 8 Cytoserocin gases (priced raw), and
// ore grades priced as their own compressed grade
$gas = 0;
foreach (array(28694, 28695, 28696, 28697, 28698, 28699, 28700, 28701, 25268, 25273, 25274, 25275, 25276, 25277, 25278, 25279) as $id) if (isset($types[$id])) $gas++;
check('types include every Mykoserocin and Cytoserocin gas', $gas, 16);
check('types include Compressed Arkonor III-Grade (Shattered Debris Field)', isset($types[62570]), true);
check('types include Compressed Mercoxit', isset($types[62586]), true);
check('types include Compressed Crokite II-Grade (low-sec ore sites)', isset($types[62561]), true);

$file = tempnam(sys_get_temp_dir(), 'market-prices-test-');
unlink($file);
$calls = 0;
$ok = function($w) use (&$calls) { $calls++; $p = array(); foreach (array_keys($w) as $id) $p[(string) $id] = 50000.0; return array($p, null); };
$partial = function($w) use (&$calls) { $calls++; return array(array('30378' => 1.0), null); };   // 1 of 3
$none = function($w) use (&$calls) { $calls++; return array(array(), null); };
$fail = function($w) use (&$calls) { $calls++; return array(null, 'ESI answered 500'); };

$t = 1000000;
$r = market_prices_get($ok, $t, $file, $wanted);
check('first call asks ESI', $calls, 1);
check('first call prices', (array) $r['prices'], array('20' => 50000.0, '22' => 50000.0, '30378' => 50000.0));
check('first call fetched', $r['fetched'], $t);

market_prices_get($ok, $t + MARKET_PRICES_TTL - 1, $file, $wanted);
check('within the TTL: no ESI call', $calls, 1);

$r = market_prices_get($fail, $t + MARKET_PRICES_TTL, $file, $wanted);
check('after the TTL: asks ESI', $calls, 2);
check('failed refresh keeps the old prices', (array) $r['prices'], array('20' => 50000.0, '22' => 50000.0, '30378' => 50000.0));
check('failed refresh keeps the old time', $r['fetched'], $t);

market_prices_get($fail, $t + MARKET_PRICES_TTL + MARKET_PRICES_RETRY - 1, $file, $wanted);
check('within the retry wait: no ESI call', $calls, 2);
$r = market_prices_get($ok, $t + MARKET_PRICES_TTL + MARKET_PRICES_RETRY, $file, $wanted);
check('after the retry wait: asks again', $calls, 3);
check('new time', $r['fetched'], $t + MARKET_PRICES_TTL + MARKET_PRICES_RETRY);

$more = $wanted + array(62568 => true);
$r = market_prices_get($ok, $t + MARKET_PRICES_TTL + MARKET_PRICES_RETRY + 1, $file, $more);
check('other wanted items: within the retry wait, no call', $calls, 3);
market_prices_get($ok, $t + MARKET_PRICES_TTL + 2 * MARKET_PRICES_RETRY, $file, $more);
check('other wanted items: asks at once after the retry wait, before the TTL', $calls, 4);
market_prices_get($ok, $t + MARKET_PRICES_TTL + 2 * MARKET_PRICES_RETRY + 10, $file, array(62568 => true) + $wanted);
check('same items in another order: no call', $calls, 4);

$t2 = $t + 10 * MARKET_PRICES_TTL;
$r = market_prices_get($partial, $t2, $file, $more);
check('a result for under half the items: asked', $calls, 5);
check('a result for under half the items keeps the old prices', $r['prices']->{'30378'}, 50000.0);
$r = market_prices_get($none, $t2 + MARKET_PRICES_RETRY, $file, $more);
check('an empty result: asked', $calls, 6);
check('an empty result keeps the old prices', count((array) $r['prices']), 4);
check('enough: half', market_prices_enough(array('1' => 1, '2' => 1), array(1 => 1, 2 => 1, 3 => 1, 4 => 1)), true);
check('enough: under half', market_prices_enough(array('1' => 1), array(1 => 1, 2 => 1, 3 => 1)), false);
check('enough: nothing wanted', market_prices_enough(array(), array()), false);

$empty = tempnam(sys_get_temp_dir(), 'market-prices-test-');
unlink($empty);
$r = market_prices_get($fail, $t, $empty, $wanted);
check('no copy and ESI down: empty, never fetched', array((array) $r['prices'], $r['fetched']), array(array(), 0));
check('empty prices encode as an object', json_encode($r['prices']), '{}');

@unlink($file); @unlink(preg_replace('/(\.json)?$/', '.lock.json', $file, 1));
@unlink($empty); @unlink(preg_replace('/(\.json)?$/', '.lock.json', $empty, 1));

if ($failures) { fwrite(STDERR, "$failures failure(s)\n"); exit(1); }
echo "market_prices_test: all passed\n";
