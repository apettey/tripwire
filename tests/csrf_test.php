<?php
// Fork-owned: tests for csrf.inc.php (the CSRF token and the cross-site check). No database needed.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/csrf_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../csrf.inc.php');

$failures = 0;
$count = 0;
function check($name, $ok, $detail = '') {
	global $failures, $count;
	$count++;
	if (!$ok) { $failures++; fwrite(STDERR, "FAIL $name  $detail\n"); }
}
function request($method, $token = null) {
	$_SERVER['REQUEST_METHOD'] = $method;
	if ($token === null) unset($_SERVER['HTTP_X_CSRF_TOKEN']); else $_SERVER['HTTP_X_CSRF_TOKEN'] = $token;
}

$_SESSION = array('userID' => 7);
$token = fork_csrf_token();
check('token is 64 hex chars', (bool) preg_match('/^[0-9a-f]{64}$/', $token), $token);
check('token is stable in the session', fork_csrf_token() === $token);

request('POST', $token);
check('POST with the token passes', fork_csrf_valid());
request('post', $token);
check('method is case-insensitive', fork_csrf_valid());
request('GET', $token);
check('GET with the token fails', !fork_csrf_valid());
request('POST');
check('POST without the token fails', !fork_csrf_valid());
request('POST', '');
check('POST with an empty token fails', !fork_csrf_valid());
request('POST', substr($token, 0, 63) . (substr($token, -1) === 'a' ? 'b' : 'a'));
check('POST with a wrong token fails', !fork_csrf_valid());

$_SESSION['userID'] = 8;
request('POST', $token);
check('token of a previous account fails', !fork_csrf_valid());
$next = fork_csrf_token();
check('new account gets a new token', $next !== $token);
request('POST', $next);
check('new token passes', fork_csrf_valid());

$_SESSION = array();
request('POST', $next);
check('logged out fails', !fork_csrf_valid());
$_SESSION = array('appCsrf' => '', 'appCsrfUser' => '', 'userID' => 9);
request('POST', '');
check('empty session token fails', !fork_csrf_valid());

// fork_request_cross_site: Sec-Fetch-Site and Origin
function site($fetch, $origin, $host = 'tripwire.example.com') {
	unset($_SERVER['HTTP_SEC_FETCH_SITE'], $_SERVER['HTTP_ORIGIN']);
	if ($fetch !== null) $_SERVER['HTTP_SEC_FETCH_SITE'] = $fetch;
	if ($origin !== null) $_SERVER['HTTP_ORIGIN'] = $origin;
	$_SERVER['HTTP_HOST'] = $host;
	return fork_request_cross_site();
}
check('no headers is not cross-site', !site(null, null));
check('same-origin fetch passes', !site('same-origin', 'https://tripwire.example.com'));
check('typed URL (none) passes', !site('none', null));
check('cross-site fetch is refused', site('cross-site', null));
check('same-site (sibling subdomain) is refused', site('same-site', null));
check('other Origin is refused', site(null, 'https://evil.example'));
check('Origin null is refused', site(null, 'null'));
check('own Origin with port passes', !site(null, 'http://127.0.0.1:8080', '127.0.0.1:8080'));
check('Origin on another port is refused', site(null, 'http://127.0.0.1:9000', '127.0.0.1:8080'));
check('host compare is case-insensitive', !site(null, 'https://Tripwire.Example.com'));
check('same-origin fetch decides alone (proxy rewrote Host)', !site('same-origin', 'https://tripwire.example.com', 'app:80'));
check('cross-site fetch wins over a matching Origin', site('cross-site', 'https://tripwire.example.com'));
check('IPv6 Origin with port passes', !site(null, 'http://[::1]:8080', '[::1]:8080'));
check('Origin without a host is refused', site(null, 'https://'));

echo ($failures ? "FAILED $failures of $count\n" : "OK $count checks\n");
exit($failures ? 1 : 0);
