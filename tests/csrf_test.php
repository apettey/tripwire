<?php
// Fork-owned: tests for csrf.inc.php (the CSRF token options.php and masks.php require). No database needed.
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

echo ($failures ? "FAILED $failures of $count\n" : "OK $count checks\n");
exit($failures ? 1 : 0);
