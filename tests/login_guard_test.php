<?php
// Fork-owned: tests for login-guard.inc.php (per-account password login limit) against the dev database.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/login_guard_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

$mysql = new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
require_once(__DIR__ . '/../login-guard.inc.php');

$failures = 0;
$count = 0;
function check($name, $ok, $detail = '') {
	global $failures, $count;
	$count++;
	if (!$ok) { $failures++; fwrite(STDERR, "FAIL $name  $detail\n"); }
}

$user = 'guardtest' . mt_rand(1000, 9999);
$ins = $mysql->prepare("INSERT INTO _history_login (ip, username, method, result, time) VALUES (:ip, :username, 'user', :result, DATE_SUB(NOW(), INTERVAL :ago MINUTE))");
// _history_login's key is (ip, time): one IP per row
function add($result, $ago) { global $ins, $user; static $n = 0; $n++; $ins->execute(array(':ip' => "198.51.100.$n", ':username' => $user, ':result' => $result, ':ago' => $ago)); }

try {
	check('empty username is not throttled', !fork_login_user_throttled($mysql, ''));
	check('non-string username is not throttled', !fork_login_user_throttled($mysql, array('x')) && !fork_login_user_throttled($mysql, null));
	for ($i = 0; $i < 9; $i++) add('fail', 1);
	add('success', 1);
	check('9 failures (and a success) are allowed', !fork_login_user_throttled($mysql, $user));
	add('fail', 20);
	check('a failure outside the window does not count', !fork_login_user_throttled($mysql, $user));
	add('fail', 2);
	check('10 failures in the window lock the account', fork_login_user_throttled($mysql, $user));
	check('another username is not affected', !fork_login_user_throttled($mysql, $user . 'x'));
} finally {
	$mysql->prepare('DELETE FROM _history_login WHERE username = :username')->execute(array(':username' => $user));
}

echo ($failures ? "FAILED $failures of $count\n" : "OK $count checks\n");
exit($failures ? 1 : 0);
