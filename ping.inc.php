<?php
require_once('../config.php');

function discord_webhook_for_current_mask() {
	if(!defined('DISCORD_WEB_HOOK')) { return null; }
	$mask = $_SESSION['mask'];
	return isset(DISCORD_WEB_HOOK[$mask]) ? DISCORD_WEB_HOOK[$mask] : null;
}

?>