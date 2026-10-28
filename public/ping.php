<?php
if (!session_id()) session_start();

if(!isset($_SESSION['userID'])) {
	http_response_code(403);
	exit();
}

require_once('../csrf.inc.php'); fork_csrf_require(); // fork: pings only by the app's own POST
require_once('../ping.inc.php');
$hook = discord_webhook_for_current_mask();

if(!$hook) {
	http_response_code(400);
	die('No endpoint configured to send pings to on mask ' . $_SESSION['mask']);
}

$url_base = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http') . '://' . $_SERVER['SERVER_NAME'].dirname($_SERVER["REQUEST_URI"].'?');
$ping_type = isset($_REQUEST['pingType']) && in_array($_REQUEST['pingType'], array('here', 'everyone'), true) ? $_REQUEST['pingType'] : null; // fork: only the dialog's two buttons
$ping_type_text = $ping_type ? ' as @' . $ping_type : '';
$content = 'Tripwire ping from *' . $_SESSION['username'] . '* in **' . $_REQUEST['systemText'] . "**$ping_type_text\n<" . $url_base . '/?system=' . $_REQUEST['systemName'] . ">\n" . $_REQUEST['message'];

// fork: @here/@everyone only ping through the dialog's buttons, never from text typed into the message (or names)
$content = preg_replace('/@(everyone|here)/i', "@\u{200B}$1", $content);
if ($ping_type) $content = str_replace(' as @' . "\u{200B}" . $ping_type, ' as @' . $ping_type, $content);
$data = array('content' => $content, 'allowed_mentions' => array('parse' => $ping_type ? array('everyone', 'users', 'roles') : array('users', 'roles')));

// use key 'http' even if you send the request to https://...
$options = array(
    'http' => array(
        'header'  => "Content-type: application/json\r\n",
        'method'  => 'POST',
        'content' => json_encode($data)
    )
);
$context  = stream_context_create($options);
$result = @file_get_contents($hook, false, $context);

header('Content-type: application/json');
if ($result === FALSE) { 
	http_response_code(500);
	error_log(error_get_last()['message']);
	die(json_encode(array('error' => 'Failed to post to hook')));
}
