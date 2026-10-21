<?php
// Fork-owned: one CSRF token per logged-in session for the upstream endpoints that change state
// (options.php: options, password, username; masks.php: create, save, delete, join, leave).
// tripwire.php prints it in <meta name="csrf-token">, app/js/fork/csrf.js sends it as the X-CSRF-Token header
// on same-origin jQuery POSTs. Cross-site forms can't set headers and cross-site fetch can't read the token.

// This session's token, made on first use and again whenever a different account logs in on the session.
function fork_csrf_token() {
	$user = isset($_SESSION['userID']) ? (string) $_SESSION['userID'] : '';
	if (empty($_SESSION['appCsrf']) || !is_string($_SESSION['appCsrf']) || !isset($_SESSION['appCsrfUser']) || $_SESSION['appCsrfUser'] !== $user) {
		$_SESSION['appCsrf'] = bin2hex(random_bytes(32));
		$_SESSION['appCsrfUser'] = $user;
	}
	return $_SESSION['appCsrf'];
}

// True only for a POST carrying this session's token for the logged-in account.
function fork_csrf_valid() {
	if (!isset($_SERVER['REQUEST_METHOD']) || strtoupper($_SERVER['REQUEST_METHOD']) !== 'POST') return false;
	$session = isset($_SESSION['appCsrf']) && is_string($_SESSION['appCsrf']) ? $_SESSION['appCsrf'] : '';
	$user = isset($_SESSION['userID']) ? (string) $_SESSION['userID'] : '';
	if ($session === '' || $user === '' || !isset($_SESSION['appCsrfUser']) || $_SESSION['appCsrfUser'] !== $user) return false;
	$token = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
	return $token !== '' && hash_equals($session, $token);
}

// Ends the request with 403 unless fork_csrf_valid().
function fork_csrf_require() {
	if (fork_csrf_valid()) return;
	http_response_code(403);
	header('Content-Type: application/json');
	echo json_encode(array('error' => 'Invalid CSRF token: reload the page'));
	exit();
}
