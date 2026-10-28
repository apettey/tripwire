<?php
// Fork-owned: per-session OAuth state for EVE SSO (upstream sent a fixed state, so a callback with an attacker's code
// could log a victim into the attacker's account). esi::login() sends "<purpose>.<nonce>", purpose being evessologin,
// evessoesi, evessoregisteruser or evessoregisteradmin; public/index.php routes the callback on the purpose and
// login.php / register.php only act on it when the nonce is the one this session was given (single use).

// The state to send to the SSO for $purpose; remembers its nonce in the session.
function fork_sso_state_new($purpose) {
	$nonce = bin2hex(random_bytes(16));
	if (!isset($_SESSION['ssoState']) || !is_array($_SESSION['ssoState'])) $_SESSION['ssoState'] = array();
	$_SESSION['ssoState'][(string) $purpose] = $nonce;
	return $purpose . '.' . $nonce;
}

// The purpose part of a returned state, for routing only (nothing is checked).
function fork_sso_state_purpose($state) {
	$state = (string) $state;
	$dot = strpos($state, '.');
	return $dot === false ? $state : substr($state, 0, $dot);
}

// The purpose of a returned state when its nonce matches this session's (and uses it up), else null.
function fork_sso_state_check($state) {
	if (!is_string($state) || !preg_match('/^([a-z]+)\.([0-9a-f]{32})$/', $state, $m)) return null;
	$expected = isset($_SESSION['ssoState'][$m[1]]) ? $_SESSION['ssoState'][$m[1]] : '';
	if (!is_string($expected) || $expected === '' || !hash_equals($expected, $m[2])) return null;
	unset($_SESSION['ssoState'][$m[1]]);
	return $m[1];
}
