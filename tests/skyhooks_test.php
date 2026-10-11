<?php
// Fork-owned: tests for skyhooks.inc.php (cache, refresh interval, lock, stale copy) with a fake ESI; no network.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/skyhooks_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../skyhooks.inc.php');

$failures = 0;
function check($name, $actual, $expected) {
	global $failures;
	if ($actual !== $expected) {
		$failures++;
		fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
	}
}

$body = json_encode(array('skyhooks' => array(
	array('planet_id' => 40199091, 'solar_system_id' => 30003136, 'theft_vulnerability' => array('start' => '2026-10-11T14:06:20Z', 'end' => '2026-10-11T16:06:20Z')),
	array('planet_id' => 1, 'solar_system_id' => 2, 'theft_vulnerability' => array('start' => 'garbage', 'end' => '2026-10-11T16:06:20Z')),
	array('planet_id' => 3),
	'junk',
)));
$list = skyhooks_parse($body);
check('parse keeps the valid row only', count($list), 1);
check('parse row', $list[0], array('planetID' => 40199091, 'systemID' => 30003136, 'start' => 1791727580, 'end' => 1791734780));
check('parse: not json', skyhooks_parse('<html>'), null);
check('parse: wrong shape', skyhooks_parse('{"x":1}'), null);
check('parse: empty list is fine', skyhooks_parse('{"skyhooks":[]}'), array());

check('normalise damaged', skyhooks_cache_normalise('x'), array('fetched' => 0, 'attempted' => 0, 'skyhooks' => array(), 'error' => null));

$file = tempnam(sys_get_temp_dir(), 'skyhooks-test-');
unlink($file);
@unlink(skyhooks_lock_file($file));
$calls = 0;
$ok = function() use (&$calls, $list) { $calls++; return array($list, null); };
$fail = function() use (&$calls) { $calls++; return array(null, 'ESI answered 500'); };

$t = 1000000;
$r = skyhooks_get($ok, $t, $file);
check('first call fetches', $calls, 1);
check('first call result', array(count($r['skyhooks']), $r['fetched'], $r['stale'], $r['error']), array(1, $t, false, null));

skyhooks_get($ok, $t + 299, $file);
check('within 5 minutes: cache', $calls, 1);
skyhooks_get($ok, $t + 300, $file);
check('after 5 minutes: fetch again', $calls, 2);

$r = skyhooks_get($fail, $t + 600, $file);
check('failure: fetched', $calls, 3);
check('failure serves the old copy', array(count($r['skyhooks']), $r['fetched'], $r['stale'], $r['error']), array(1, $t + 300, false, 'ESI answered 500'));
skyhooks_get($fail, $t + 630, $file);
check('failure: no retry within 60 s', $calls, 3);
$r = skyhooks_get($fail, $t + 660, $file);
check('failure: retry after 60 s', $calls, 4);
check('copy 6 minutes old is not stale yet', $r['stale'], false);
$r = skyhooks_get($fail, $t + 920, $file);
check('copy older than 10 minutes is stale', $r['stale'], true);
$r = skyhooks_get($ok, $t + 1000, $file);
check('recovery', array($calls, $r['stale'], $r['error']), array(6, false, null));

// Lock held by someone else: serve the copy, don't call ESI
$holder = fopen(skyhooks_lock_file($file), 'c');
flock($holder, LOCK_EX);
$r = skyhooks_get($ok, $t + 5000, $file);
check('lock held: no call', $calls, 6);
check('lock held: old copy served', count($r['skyhooks']), 1);
flock($holder, LOCK_UN);
fclose($holder);
skyhooks_get($ok, $t + 5000, $file);
check('lock free: fetch', $calls, 7);

// The cache can't be written (the cache path is a directory): ESI is still asked only once per 60 s, and no temp file stays
$dirFile = sys_get_temp_dir() . '/skyhooks-test-dir-' . getmypid() . '.json';
mkdir($dirFile);
$before = $calls;
$r = skyhooks_get($ok, $t + 9000, $dirFile);
check('unwritable: first request asks ESI', $calls, $before + 1);
check('unwritable: this request still gets the list', array(count($r['skyhooks']), $r['unavailable']), array(1, false));
skyhooks_get($ok, $t + 9030, $dirFile);
check('unwritable: no second call within 60 s', $calls, $before + 1);
skyhooks_get($ok, $t + 9060, $dirFile);
check('unwritable: call again after 60 s', $calls, $before + 2);
check('unwritable: no temp file left', glob($dirFile . '.*.tmp.json'), array());
check('write failure is false', skyhooks_write_cache($dirFile, array()), false);
@unlink(skyhooks_lock_file($dirFile));
rmdir($dirFile);

// No list at all (ESI down, nothing cached): flagged as unavailable, not as an empty list
$none = sys_get_temp_dir() . '/skyhooks-test-none-' . getmypid() . '.json';
$r = skyhooks_get($fail, $t + 20000, $none);
check('unavailable: flag, empty list, error', array($r['unavailable'], $r['skyhooks'], $r['error']), array(true, array(), 'ESI answered 500'));
$r = skyhooks_get($ok, $t + 20100, $none);
check('available once fetched', array($r['unavailable'], count($r['skyhooks'])), array(false, 1));
@unlink($none); @unlink(skyhooks_lock_file($none));

// A paused ESI (esi/esi.inc.php limits) is an error, and the copy survives
esi_limit_state_file(tempnam(sys_get_temp_dir(), 'esi-test-'));
esi_limit_state_update(function(array &$state) { $state['pauses']['route:skyhooks/raidable'] = microtime(true) + 300; });
$r = skyhooks_fetch_esi();
check('paused: not sent', $r[0], null);
check('paused: reason', strpos($r[1], 'ESI asked us to wait') === 0, true);

// The request carries the newer date, once
$sent = null;
esi_limit_state_file(tempnam(sys_get_temp_dir(), 'esi-test-'));
esi_transport(function($method, $url, $headers) use (&$sent, $body) { $sent = array($method, $url, $headers); return array(200, $body, array()); });
$r = skyhooks_fetch_esi();
check('fetch ok', count($r[0]), 1);
check('fetch url', $sent[1], 'https://esi.evetech.net/skyhooks/raidable');
check('fetch date header', array_values(array_filter($sent[2], function($h) { return stripos($h, 'x-compatibility-date:') === 0; })), array('X-Compatibility-Date: 2026-10-01'));
esi_transport(function() { return array(404, 'nope', array()); });
check('fetch 404', skyhooks_fetch_esi(), array(null, 'ESI answered 404'));
esi_transport(function() { return array(200, 'not json', array()); });
check('fetch bad body', skyhooks_fetch_esi(), array(null, 'ESI answered with an unexpected body'));

@unlink($file); @unlink(skyhooks_lock_file($file));
echo $failures ? "$failures FAILED\n" : "all checks passed\n";
exit($failures ? 1 : 0);
