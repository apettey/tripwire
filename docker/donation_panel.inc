<?php
// Fork replacement for upstream's donation_panel.inc (upstream's PayPal donate form and tracking pixel).
// Copied over /opt/app/donation_panel.inc in the image and bind-mounted over it in the dev stack.
// upstream includes this file (PHP include) in the footer of tripwire.php and landing.php.
//
// Empty by default. Set DONATION_PANEL_HTML_FILE to a readable file (e.g. a bind-mounted
// /config/donation.html) to show your own panel; its contents are output as-is (trusted HTML).

$tw_donation_file = getenv('DONATION_PANEL_HTML_FILE');
if ($tw_donation_file !== false && $tw_donation_file !== '') {
	if (is_file($tw_donation_file) && is_readable($tw_donation_file)) {
		readfile($tw_donation_file);
	} else {
		error_log('DONATION_PANEL_HTML_FILE is set but not a readable file: ' . $tw_donation_file);
	}
}
