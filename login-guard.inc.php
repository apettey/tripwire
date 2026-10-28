<?php
// Fork-owned: per-account limit for password logins in public/login.php. Upstream only counts attempts per IP
// (4 in 30 seconds), so an attacker rotating addresses could keep guessing one account's password. EVE SSO login is
// not affected, so a locked password login never locks the user out completely.

define('FORK_LOGIN_USER_MAX_FAILS', 10);
define('FORK_LOGIN_USER_WINDOW_MINUTES', 15);

// True when $username had FORK_LOGIN_USER_MAX_FAILS or more failed logins in the last FORK_LOGIN_USER_WINDOW_MINUTES.
function fork_login_user_throttled($mysql, $username) {
	if (!is_string($username) || $username === '') return false;
	$stmt = $mysql->prepare("SELECT COUNT(*) FROM _history_login WHERE username = :username AND result = 'fail' AND time > DATE_SUB(NOW(), INTERVAL " . (int) FORK_LOGIN_USER_WINDOW_MINUTES . " MINUTE)");
	$stmt->bindValue(':username', $username);
	$stmt->execute();
	return (int) $stmt->fetchColumn(0) >= FORK_LOGIN_USER_MAX_FAILS;
}
