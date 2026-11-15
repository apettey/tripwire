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
	array('type_id' => 22, 'adjusted_price' => 2714.577),           // no average: adjusted
	array('type_id' => 20, 'average_price' => 0, 'adjusted_price' => 0),   // no usable price
	array('type_id' => 999, 'average_price' => 5),                  // not wanted
	'junk',
));
check('parse keeps wanted types with a price', market_prices_parse($body, $wanted), array('30378' => 56236.6, '22' => 2714.58));
check('parse: not json', market_prices_parse('<html>', $wanted), null);
check('parse: not a list', market_prices_parse('{"x":1}', $wanted), null);
check('parse: empty list', market_prices_parse('[]', $wanted), array());
check('normalise damaged', market_prices_normalise('x'), array('fetched' => 0, 'attempted' => 0, 'prices' => array()));
check('normalise drops bad rows', market_prices_normalise(array('prices' => array('22' => 5, 'x' => 1, '20' => 'abc')))['prices'], array('22' => 5.0));

$types = market_prices_types();
check('types come from sites.json', isset($types[30378]) && isset($types[22]) && count($types) >= 10, true);

$file = tempnam(sys_get_temp_dir(), 'market-prices-test-');
unlink($file);
$calls = 0;
$ok = function($w) use (&$calls) { $calls++; return array(array('30378' => 50000.0), null); };
$fail = function($w) use (&$calls) { $calls++; return array(null, 'ESI answered 500'); };

$t = 1000000;
$r = market_prices_get($ok, $t, $file, $wanted);
check('first call asks ESI', $calls, 1);
check('first call prices', (array) $r['prices'], array('30378' => 50000.0));
check('first call fetched', $r['fetched'], $t);

market_prices_get($ok, $t + MARKET_PRICES_TTL - 1, $file, $wanted);
check('within the TTL: no ESI call', $calls, 1);

$r = market_prices_get($fail, $t + MARKET_PRICES_TTL, $file, $wanted);
check('after the TTL: asks ESI', $calls, 2);
check('failed refresh keeps the old prices', (array) $r['prices'], array('30378' => 50000.0));
check('failed refresh keeps the old time', $r['fetched'], $t);

market_prices_get($fail, $t + MARKET_PRICES_TTL + MARKET_PRICES_RETRY - 1, $file, $wanted);
check('within the retry wait: no ESI call', $calls, 2);
$r = market_prices_get($ok, $t + MARKET_PRICES_TTL + MARKET_PRICES_RETRY, $file, $wanted);
check('after the retry wait: asks again', $calls, 3);
check('new time', $r['fetched'], $t + MARKET_PRICES_TTL + MARKET_PRICES_RETRY);

$empty = tempnam(sys_get_temp_dir(), 'market-prices-test-');
unlink($empty);
$r = market_prices_get($fail, $t, $empty, $wanted);
check('no copy and ESI down: empty, never fetched', array((array) $r['prices'], $r['fetched']), array(array(), 0));
check('empty prices encode as an object', json_encode($r['prices']), '{}');

@unlink($file); @unlink(preg_replace('/(\.json)?$/', '.lock.json', $file, 1));
@unlink($empty); @unlink(preg_replace('/(\.json)?$/', '.lock.json', $empty, 1));

if ($failures) { fwrite(STDERR, "$failures failure(s)\n"); exit(1); }
echo "market_prices_test: all passed\n";
