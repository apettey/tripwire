<?php
// Fork-owned: one CSRF token per logged-in session for the endpoints that change state
// (options.php, masks.php, flares.php, ping.php, the tracking/esiDelete parts of refresh.php, fork endpoints).
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

// True when the browser says the request came from another site: Sec-Fetch-Site cross-site or same-site (a sibling
// subdomain), or, from browsers that don't send Sec-Fetch-Site, an Origin header for another host. Used where no token
// can exist yet (password login on the landing page) or a plain link must keep working (logout). Requests without
// either header (curl, old browsers on a GET navigation) pass. Pages can't set Sec-Fetch-Site, so when it is there it
// decides alone (Host may be rewritten by a proxy).
function fork_request_cross_site() {
	$site = isset($_SERVER['HTTP_SEC_FETCH_SITE']) ? strtolower((string) $_SERVER['HTTP_SEC_FETCH_SITE']) : '';
	if ($site === 'cross-site' || $site === 'same-site') return true;
	if ($site === 'same-origin' || $site === 'none') return false;
	if (!isset($_SERVER['HTTP_ORIGIN']) || (string) $_SERVER['HTTP_ORIGIN'] === '') return false;
	$origin = (string) $_SERVER['HTTP_ORIGIN'];
	$host = parse_url($origin, PHP_URL_HOST);
	$port = parse_url($origin, PHP_URL_PORT);
	if (!is_string($host) || $host === '') return true;	// "null" (sandboxed frame, file:) or garbage
	$own = isset($_SERVER['HTTP_HOST']) ? strtolower((string) $_SERVER['HTTP_HOST']) : '';
	return strtolower($host . ($port ? ':' . $port : '')) !== $own;
}
