<?php
//***********************************************************
//	File: 		logout.php
//	Author: 	Daimian
//	Created: 	2/13/2014
//	Modified: 	2/13/2014 - Daimian
//
//	Purpose:	Handles destroying session and cookies.
//
//	ToDo:
//***********************************************************
session_start();

// fork: a link or form on another site can't log a visitor out (our own Logout link and button still work)
require_once('../csrf.inc.php');
if (fork_request_cross_site()) { header('Location: .'); exit(); }

//setcookie also deletes existing cookies, must be EXACT same format as was set
setcookie('username', '', time() -3600, '/');
setcookie('password', '', time() -3600, '/');
setcookie('tripwire', '', time() -3600, '/');

$_SESSION = array();
session_regenerate_id();

session_destroy();

header('Location: .');
?>
