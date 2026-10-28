<?php
// Fork-owned: tests for sso-downtime.inc.php ("EVE is down" instead of "Unknown error"). Run in the dev stack's app
// container: the end-to-end part goes through php-fpm and the real EVE SSO token endpoint (a made-up code, refused),
// so it can fail while CCP's SSO itself is down. It replaces the shared ESI status cache file for a moment.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/sso_downtime_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../sso-downtime.inc.php');

$base = getenv('SSO_DOWNTIME_TEST_BASE') ?: 'http://127.0.0.1';
$failures = 0;
$count = 0;
function check($name, $actual, $expected) {
	global $failures, $count;
	$count++;
	if ($actual !== $expected) { $failures++; fwrite(STDERR, "FAIL $name  got " . var_export($actual, true) . "\n"); }
}

$down = function () { return false; };
$up = function () { return true; };
$asked = 0;
$counting = function () use (&$asked) { $asked++; return false; };

check('login, ESI down', fork_sso_downtime_location('./?error=login-unknown#login#sso', $down), './?error=login-downtime#login#sso');
check('register, ESI down', fork_sso_downtime_location('./?error=register-unknown#register', $down), './?error=register-downtime#register');
check('register admin, ESI down', fork_sso_downtime_location('./?error=registeradmin-unknown#register', $down), './?error=registeradmin-downtime#register');
check('ESI up keeps the redirect', fork_sso_downtime_location('./?error=login-unknown#login#sso', $up), null);

check('other errors untouched', fork_sso_downtime_location('./?error=login-account#login#sso', $counting), null);
check('success untouched', fork_sso_downtime_location('./?success=user#register#user', $counting), null);
check('look-alike untouched', fork_sso_downtime_location('./?error=login-unknownx', $counting), null);
check('ESI only asked about -unknown errors', $asked, 0);

check('status endpoint not answering is down', fork_sso_downtime_esi_up('http://127.0.0.1:1/'), false);

// End to end through php-fpm: start an SSO login (gets this cookie jar a valid state), come back with a made-up code
// (the token exchange fails), and read the redirect. The cached ESI answer decides which error it names.
function sso_callback_location($up) {
	global $base;
	@unlink(FORK_SSO_DOWNTIME_CACHE);
	file_put_contents(FORK_SSO_DOWNTIME_CACHE, json_encode(array('up' => $up)));
	chmod(FORK_SSO_DOWNTIME_CACHE, 0666);
	$jar = tempnam(sys_get_temp_dir(), 'ssodt');
	$get = function ($path) use ($jar, $base) {
		$ch = curl_init($base . '/' . $path);
		curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar, CURLOPT_TIMEOUT => 20]);
		$text = (string) curl_exec($ch);
		return preg_match('/^Location: *(\S+)/mi', $text, $m) ? $m[1] : null;
	};
	$authorize = (string) $get('login.php?mode=sso&login=sso');
	parse_str((string) parse_url($authorize, PHP_URL_QUERY), $query);
	$location = $get('index.php?mode=sso&code=made-up&state=' . urlencode($query['state'] ?? ''));
	@unlink($jar);
	@unlink(FORK_SSO_DOWNTIME_CACHE);
	return $location;
}
check('callback while ESI is down', sso_callback_location(false), './?error=login-downtime#login#sso');
check('callback while ESI is up', sso_callback_location(true), './?error=login-unknown#login#sso');

echo ($failures ? "FAILED $failures of $count\n" : "OK $count checks\n");
exit($failures ? 1 : 0);
