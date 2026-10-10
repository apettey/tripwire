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
$d = esi_limit_decision('https://esi.evetech.net/latest/fw/systems/', 429, [], false);
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
[$status] = esi_request('GET', 'https://esi.evetech.net/latest/fw/systems/', ['Accept: application/json']);
check('request: sent', [$status, count($sent)], [200, 1]);
check('request: compatibility date header', in_array('X-Compatibility-Date: ' . ESI_COMPATIBILITY_DATE, $sent[0][2], true), true);

$headers = ['X-Compatibility-Date: 2020-01-01'];
esi_before_request('https://esi.evetech.net/status', $headers);
check('request: an explicit date is kept', $headers, ['X-Compatibility-Date: 2020-01-01']);
$headers = [];
check('before: non-ESI URL untouched', [esi_before_request('https://login.eveonline.com/v2/oauth/token', $headers), $headers], [null, []]);

// 429 pauses the route: the next request isn't sent, other routes still go
$replies[] = [429, '{"error":"too many"}', ['retry-after' => '120']];
esi_request('GET', 'https://esi.evetech.net/latest/fw/systems/');
$before = count($sent);
[$status, $error] = esi_request('GET', 'https://esi.evetech.net/latest/fw/systems/');
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
$stream = esi_open_url('https://esi.evetech.net/latest/fw/systems/?datasource=tranquility', $stale);
check('open: fresh body', stream_get_contents($stream), '[{"new":true}]');
check('open: date as header', in_array('X-Compatibility-Date: ' . ESI_COMPATIBILITY_DATE, end($sent)[2], true), true);
$replies[] = [503, 'down', []];
$stream = esi_open_url('https://esi.evetech.net/latest/fw/systems/?datasource=tranquility', $stale);
check('open: error => stale cache', stream_get_contents($stream), '[{"old":true}]');
$replies[] = [429, '', ['retry-after' => '60']];
esi_open_url('https://esi.evetech.net/latest/fw/systems/?datasource=tranquility', $stale);
$before = count($sent);
$stream = esi_open_url('https://esi.evetech.net/latest/fw/systems/?datasource=tranquility', $stale);
check('open: paused => stale cache, not sent', [stream_get_contents($stream), count($sent)], ['[{"old":true}]', $before]);
check('open: paused, no cache => false', esi_open_url('https://esi.evetech.net/latest/fw/systems/?datasource=tranquility', null), false);

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
[$s1] = esi_request('GET', 'https://esi.evetech.net/latest/fw/systems/');
[$s2] = esi_request('GET', 'https://esi.evetech.net/latest/fw/systems/');
[$s3] = esi_request('GET', 'https://esi.evetech.net/v4/corporations/1/');
check('unwritable state: requests still sent', [$s1, $s2, $s3], [429, 429, 420]);
$lines = array_values(array_filter(explode("\n", (string) file_get_contents($log)), function ($l) { return strpos($l, 'ESI:') !== false; }));
check('unwritable state: one log line', count($lines), 1);
check('unwritable state: says why', strpos($lines[0] ?? '', 'cannot write') !== false, true);
ini_set('error_log', $previousLog === false ? '' : $previousLog);
@unlink($log);
esi_limit_state_file($stateFile);

esi_transport(null, true);
@unlink($stale);
@unlink($stateFile);

echo "$count checks, $failures failures\n";
exit($failures ? 1 : 0);
