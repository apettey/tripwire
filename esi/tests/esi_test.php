<?php
// Fork-owned: tests for esi/esi.inc.php with a fake transport (no network, no tokens).
//   docker compose -f docker-compose.dev.yml exec -T app php esi/tests/esi_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../esi.inc.php');

$failures = 0;
$count = 0;
function check($name, $actual, $expected) {
    global $failures, $count;
    $count++;
    if ($actual !== $expected) {
        $failures++;
        fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
    }
}

// Shared state goes to a throw-away file
$stateFile = tempnam(sys_get_temp_dir(), 'esi-test-');
esi_limit_state_file($stateFile);
function reset_state() { global $stateFile; file_put_contents($stateFile, ''); }
reset_state();
$etagDir = sys_get_temp_dir() . "/esi-etag-test-" . getmypid();
esi_etag_dir($etagDir);

// --- URL helpers ---
check('date format', (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', ESI_COMPATIBILITY_DATE), true);
check('is esi', esi_is_url('https://esi.evetech.net/v4/corporations/1/'), true);
check('not esi: sso', esi_is_url('https://login.eveonline.com/v2/oauth/token'), false);
check('not esi: lookalike', esi_is_url('https://esi.evetech.net.example.com/x'), false);
check('route: version prefix and id', esi_route_key('https://esi.evetech.net/v4/corporations/98000001/'), 'corporations/{id}');
check('route: latest', esi_route_key('https://esi.evetech.net/latest/fw/systems/?datasource=tranquility'), 'fw/systems');
check('route: versionless', esi_route_key('https://esi.evetech.net/characters/123/roles'), 'characters/{id}/roles');
check('route: two ids', esi_route_key('https://esi.evetech.net/killmails/1/abc'), 'killmails/{id}/abc');
check('character', esi_character_of('https://esi.evetech.net/v2/characters/90000001/roles/'), '90000001');
check('character: affiliation is not one', esi_character_of('https://esi.evetech.net/v2/characters/affiliation/'), null);
check('authenticated', esi_is_authenticated(['Authorization: Bearer x']), true);
check('not authenticated', esi_is_authenticated(['Accept: application/json']), false);
check('retry-after seconds', esi_retry_after('120'), 120);
check('retry-after date', esi_retry_after(gmdate('D, d M Y H:i:s', 1000 + 30) . ' GMT', 1000), 30);
check('retry-after junk', esi_retry_after('soon'), null);

// --- decisions ---
$url = 'https://esi.evetech.net/v2/characters/90000001/roles/';
$d = esi_limit_decision($url, 200, ['x-ratelimit-group' => 'char-detail', 'x-ratelimit-limit' => '600/15m', 'x-ratelimit-remaining' => '500'], true);
check('200: group learned, no pause', $d, ['group' => 'char-detail', 'pauses' => []]);
$d = esi_limit_decision($url, 429, ['x-ratelimit-group' => 'char-detail', 'retry-after' => '90'], true);
check('429: per-character group pause', $d['pauses'], ['group:char-detail:90000001' => 90]);
$d = esi_limit_decision($url, 429, ['x-ratelimit-group' => 'char-detail', 'retry-after' => '90'], false);
check('429 unauthenticated: group pause', $d['pauses'], ['group:char-detail' => 90]);
$d = esi_limit_decision('https://esi.evetech.net/fw/systems/', 429, [], false);
check('429 without headers: route pause, default length', $d['pauses'], ['route:fw/systems' => ESI_DEFAULT_PAUSE]);
$d = esi_limit_decision($url, 429, ['retry-after' => '99999'], false);
check('pause is capped', $d['pauses'], ['route:characters/{id}/roles' => ESI_MAX_PAUSE]);
$d = esi_limit_decision($url, 420, ['x-esi-error-limit-remain' => '0', 'x-esi-error-limit-reset' => '37'], false);
check('420: everything until the error window resets', $d['pauses'], ['*' => 38]);
$d = esi_limit_decision($url, 404, ['x-esi-error-limit-remain' => '5', 'x-esi-error-limit-reset' => '20'], false);
check('error limit nearly used: pause all', $d['pauses'], ['*' => 21]);
$d = esi_limit_decision($url, 200, ['x-esi-error-limit-remain' => '50', 'x-esi-error-limit-reset' => '20'], false);
check('error limit fine', $d['pauses'], []);
$d = esi_limit_decision($url, 200, ['x-ratelimit-group' => 'char-detail', 'x-ratelimit-limit' => '600/15m', 'x-ratelimit-remaining' => '20'], true);
check('tokens nearly used (< 5%): short pause', $d['pauses'], ['group:char-detail:90000001' => ESI_LOW_TOKENS_PAUSE]);
$d = esi_limit_decision($url, 200, ['x-ratelimit-group' => 'char-detail', 'x-ratelimit-limit' => '600/15m', 'x-ratelimit-remaining' => '30'], true);
check('tokens at 5%: no pause', $d['pauses'], []);

// --- state ---
$state = [];
$started = esi_limit_apply($state, $url, ['group' => 'char-detail', 'pauses' => ['group:char-detail:90000001' => 90]], 1000);
check('apply: started', $started, ['group:char-detail:90000001' => 90]);
check('apply: route learned', $state['routes'], ['characters/{id}/roles' => 'char-detail']);
check('paused: same character', esi_paused_for($url, true, $state, 1010), 80.0);
check('not paused: other character', esi_paused_for('https://esi.evetech.net/v2/characters/90000002/roles/', true, $state, 1010), 0.0);
check('not paused: other route', esi_paused_for('https://esi.evetech.net/v4/corporations/1/', false, $state, 1010), 0.0);
check('not paused: after the pause', esi_paused_for($url, true, $state, 1091), 0.0);
$started = esi_limit_apply($state, $url, ['group' => 'char-detail', 'pauses' => ['group:char-detail:90000001' => 30]], 1020);
check('apply: already paused, not started again (logged once)', $started, []);
check('apply: never shortens a pause', $state['pauses']['group:char-detail:90000001'], 1090);
esi_limit_apply($state, $url, ['group' => null, 'pauses' => ['*' => 10]], 1100);
check('apply: expired pauses dropped', array_keys($state['pauses']), ['*']);
check('global pause stops every route', esi_paused_for('https://esi.evetech.net/v4/corporations/1/', false, $state, 1105), 5.0);

// --- request flow with a fake transport ---
reset_state();
$sent = [];
$replies = [];
esi_transport(function ($method, $url, $headers, $body) use (&$sent, &$replies) {
    $sent[] = [$method, $url, $headers];
    return array_shift($replies) ?? [200, '{}', []];
});

$replies[] = [200, '[]', []];
[$status] = esi_request('GET', 'https://esi.evetech.net/fw/systems/', ['Accept: application/json']);
check('request: sent', [$status, count($sent)], [200, 1]);
check('request: compatibility date header', in_array('X-Compatibility-Date: ' . ESI_COMPATIBILITY_DATE, $sent[0][2], true), true);

$headers = ['X-Compatibility-Date: 2020-01-01'];
esi_before_request('https://esi.evetech.net/status', $headers);
check('request: an explicit date is kept', $headers, ['X-Compatibility-Date: 2020-01-01']);
$headers = [];
check('before: non-ESI URL untouched', [esi_before_request('https://login.eveonline.com/v2/oauth/token', $headers), $headers], [null, []]);

// 429 pauses the route: the next request isn't sent, other routes still go
$replies[] = [429, '{"error":"too many"}', ['retry-after' => '120']];
esi_request('GET', 'https://esi.evetech.net/fw/systems/');
$before = count($sent);
[$status, $error] = esi_request('GET', 'https://esi.evetech.net/fw/systems/');
check('paused: not sent', [$status, count($sent)], [-1, $before]);
check('paused: says why', strpos($error, 'retry in') !== false, true);
[$status] = esi_request('GET', 'https://esi.evetech.net/v4/corporations/1/');
check('paused: other routes still go', [$status, count($sent)], [200, $before + 1]);

// A learned group pauses every route of that group
reset_state();
$replies[] = [429, '', ['x-ratelimit-group' => 'status', 'retry-after' => '60']];
esi_request('GET', 'https://esi.evetech.net/status');
$before = count($sent);
esi_request('GET', 'https://esi.evetech.net/v1/status/');
check('group pause: same group via another path', count($sent), $before);

// 420 stops all ESI requests, but not SSO
reset_state();
$replies[] = [420, '', ['x-esi-error-limit-remain' => '0', 'x-esi-error-limit-reset' => '30']];
esi_request('GET', 'https://esi.evetech.net/v4/corporations/1/');
$before = count($sent);
esi_request('POST', 'https://esi.evetech.net/v2/characters/affiliation/', [], '[1]');
check('420: everything paused', count($sent), $before);
$headers = [];
check('420: SSO not affected', esi_before_request('https://login.eveonline.com/v2/oauth/token', $headers), null);

// Pauses are shared through the state file (another process sees them)
$shared = json_decode(file_get_contents($stateFile), true);
check('state file: global pause stored', isset($shared['pauses']['*']) && $shared['pauses']['*'] > microtime(true), true);

// esi_open_url: stale cache when paused, fresh body otherwise
reset_state();
$stale = tempnam(sys_get_temp_dir(), 'esi-stale-');
file_put_contents($stale, '[{"old":true}]');
$replies[] = [200, '[{"new":true}]', []];
$stream = esi_open_url('https://esi.evetech.net/fw/systems/?datasource=tranquility', $stale);
check('open: fresh body', stream_get_contents($stream), '[{"new":true}]');
check('open: date as header', in_array('X-Compatibility-Date: ' . ESI_COMPATIBILITY_DATE, end($sent)[2], true), true);
$replies[] = [503, 'down', []];
$stream = esi_open_url('https://esi.evetech.net/fw/systems/?datasource=tranquility', $stale);
check('open: error => stale cache', stream_get_contents($stream), '[{"old":true}]');
$replies[] = [429, '', ['retry-after' => '60']];
esi_open_url('https://esi.evetech.net/fw/systems/?datasource=tranquility', $stale);
$before = count($sent);
$stream = esi_open_url('https://esi.evetech.net/fw/systems/?datasource=tranquility', $stale);
check('open: paused => stale cache, not sent', [stream_get_contents($stream), count($sent)], ['[{"old":true}]', $before]);
check('open: paused, no cache => false', esi_open_url('https://esi.evetech.net/fw/systems/?datasource=tranquility', null), false);

// A damaged or foreign state file never breaks ESI calls
foreach (['{"routes":5,"pauses":"x"}', '[1,2]', '"text"', '{"pauses":{"*":"soon"},"routes":{"status":7}}', 'not json'] as $junk) {
    file_put_contents($stateFile, $junk);
    $before = count($sent);
    [$status] = esi_request('GET', 'https://esi.evetech.net/v1/status/');
    check("junk state $junk: request goes", [$status, count($sent)], [200, $before + 1]);
    check("junk state $junk: read is normalised", esi_limit_state_read(), ['pauses' => [], 'routes' => []]);
}
file_put_contents($stateFile, '{"routes":5}');
$replies[] = [429, '', ['x-ratelimit-group' => 'status', 'retry-after' => '60']];
esi_request('GET', 'https://esi.evetech.net/status');
$shared = json_decode(file_get_contents($stateFile), true);
check('junk state: rewritten in shape after a pause', [array_keys($shared), $shared['routes']], [['pauses', 'routes'], ['status' => 'status']]);

// State file can't be written: the request still works, the problem is logged once (not every pause)
$log = tempnam(sys_get_temp_dir(), 'esi-log-');
$previousLog = ini_set('error_log', $log);
esi_limit_state_file(sys_get_temp_dir() . '/no-such-dir-' . getmypid() . '/esi-limits.json');
$replies[] = [429, '', ['retry-after' => '60']];
$replies[] = [429, '', ['retry-after' => '60']];
$replies[] = [420, '', []];
[$s1] = esi_request('GET', 'https://esi.evetech.net/fw/systems/');
[$s2] = esi_request('GET', 'https://esi.evetech.net/fw/systems/');
[$s3] = esi_request('GET', 'https://esi.evetech.net/v4/corporations/1/');
check('unwritable state: requests still sent', [$s1, $s2, $s3], [429, 429, 420]);
$lines = array_values(array_filter(explode("\n", (string) file_get_contents($log)), function ($l) { return strpos($l, 'ESI:') !== false; }));
check('unwritable state: one log line', count($lines), 1);
check('unwritable state: says why', strpos($lines[0] ?? '', 'cannot write') !== false, true);
ini_set('error_log', $previousLog === false ? '' : $previousLog);
@unlink($log);
esi_limit_state_file($stateFile);

// --- ETags: If-None-Match, 304 => stored body as a 200 ---
reset_state();
$etagUrl = 'https://esi.evetech.net/corporations/1/';
$sent = [];
$replies = [[200, '{"name":"A"}', ['etag' => '"abc"', 'content-type' => 'application/json']]];
[$status, $body] = esi_request('GET', $etagUrl, ['Accept: application/json']);
check('etag: first request has no If-None-Match', [$status, $body, in_array('If-None-Match: "abc"', $sent[0][2], true)], [200, '{"name":"A"}', false]);
$replies = [[304, '', ['etag' => '"abc"']]];
[$status, $body, $respHeaders] = esi_request('GET', $etagUrl, ['Accept: application/json']);
check('etag: second request sends If-None-Match', in_array('If-None-Match: "abc"', end($sent)[2], true), true);
check('etag: 304 becomes the stored 200', [$status, $body, $respHeaders['content-type'] ?? null], [200, '{"name":"A"}', 'application/json']);
$replies = [[200, '{"name":"B"}', ['etag' => '"def"']]];
esi_request('GET', $etagUrl);
$replies = [[304, '', []]];
[$status, $body] = esi_request('GET', $etagUrl);
check('etag: a new 200 replaces the stored body', [$status, $body, in_array('If-None-Match: "def"', end($sent)[2], true)], [200, '{"name":"B"}', true]);
$replies = [[500, 'oops', []]];
[$status, $body] = esi_request('GET', $etagUrl);
check('etag: errors pass through', [$status, $body], [500, 'oops']);
$replies = [[304, '', []]];
[$status] = esi_request('GET', 'https://esi.evetech.net/corporations/2/');
check('etag: a 304 without a stored copy is not turned into a 200', [$status, in_array('If-None-Match: "def"', end($sent)[2], true)], [304, false]);
$replies = [[200, '{}', ['etag' => '"p"']]];
esi_request('POST', 'https://esi.evetech.net/universe/names/', [], '[1]');
check('etag: POST is never stored', count(glob($etagDir . '/*.json')), 1);
// Authenticated responses are per access token
$replies = [[200, '{"roles":["x"]}', ['etag' => '"r1"']]];
esi_request('GET', 'https://esi.evetech.net/characters/9/', ['Authorization: Bearer one']);
$replies = [[200, '{}', []]];
esi_request('GET', 'https://esi.evetech.net/characters/9/', ['Authorization: Bearer two']);
check('etag: another token does not get the stored ETag', in_array('If-None-Match: "r1"', end($sent)[2], true), false);
esi_request('GET', 'https://esi.evetech.net/characters/9/', ['Authorization: Bearer one']);
check('etag: the same token does', in_array('If-None-Match: "r1"', end($sent)[2], true), true);
// Non-ESI URLs and pruning
check('etag: only ESI urls', esi_etag_load('https://example.com/x'), null);
// Immutable per-ID routes are never stored
$before = count(glob($etagDir . '/*.json'));
$replies = [[200, '{"k":1}', ['etag' => '"k"']], [200, '{"k":1}', ['etag' => '"k"']]];
esi_request('GET', 'https://esi.evetech.net/killmails/1/abc/');
esi_request('GET', 'https://esi.evetech.net/universe/types/587/');
check('etag: killmails and types are not stored', [count(glob($etagDir . '/*.json')), esi_etag_load('https://esi.evetech.net/killmails/1/abc/')], [$before, null]);
// Language / compatibility date are part of the key
$replies = [[200, '{}', ['etag' => '"l"']]];
esi_request('GET', 'https://esi.evetech.net/fw/systems/', ['Accept-Language: de']);
$replies = [[200, '{}', []]];
esi_request('GET', 'https://esi.evetech.net/fw/systems/', ['Accept-Language: en']);
check('etag: language is part of the key', in_array('If-None-Match: "l"', end($sent)[2], true), false);
esi_request('GET', 'https://esi.evetech.net/fw/systems/', ['accept-language: DE']);
check('etag: header names and values are case-insensitive', in_array('If-None-Match: "l"', end($sent)[2], true), true);
$replies = [[200, '{}', []]];
esi_request('GET', 'https://esi.evetech.net/fw/systems/', ['Accept-Language: de', 'X-Compatibility-Date: 2020-01-01']);
check('etag: compatibility date is part of the key', in_array('If-None-Match: "l"', end($sent)[2], true), false);
// Pruning: hourly via a marker file, old entries and stray temp files
file_put_contents($etagDir . '/stray.tmp', 'x');
foreach (glob($etagDir . '/*.json') as $f) touch($f, time() - ESI_ETAG_MAX_AGE - 10);
touch($etagDir . '/stray.tmp', time() - 7200);
esi_etag_prune();
check('prune: skipped while the marker is fresh', count(glob($etagDir . '/*.json')) > 0, true);
touch($etagDir . '/.pruned', time() - 7200);
esi_etag_prune();
check('prune: old entries and stray temp files go', [glob($etagDir . '/*.json'), glob($etagDir . '/*.tmp')], [[], []]);

esi_transport(null, true);
foreach (array_merge(glob($etagDir . '/*') ?: [], glob($etagDir . '/.pruned') ?: []) as $f) @unlink($f);
@unlink($etagDir . '/.pruned');
@rmdir($etagDir);
@unlink($stale);
@unlink($stateFile);

echo "$count checks, $failures failures\n";
exit($failures ? 1 : 0);
