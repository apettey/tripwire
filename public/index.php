<?php

// SSO redirecting
$state = isset($_REQUEST['state']) && is_string($_REQUEST['state'])?preg_replace('/\..*$/s', '', $_REQUEST['state']):null; // fork: "<purpose>.<nonce>" (sso-state.inc.php)
if ($state == 'evessologin' || $state == 'evessoesi') {
	require('login.php');
	exit();
} else if ($state == 'evessoregisteruser' || $state == 'evessoregisteradmin') {
	require('register.php');
	exit();
}

session_start();

if (!isset($_SESSION['username']) && isset($_COOKIE['tripwire']))
	include('login.php');

if (isset($_GET['system']) && isset($_SESSION['userID'])) {
	require('../tripwire.php');
} else {
	require('../landing.php');
}

?>
