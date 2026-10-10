<?php
// Fork replacement for upstream's analytics.inc.php (upstream's Google Analytics property UA-48258312-1).
// Copied over /opt/app/analytics.inc.php in the image and bind-mounted over it in the dev stack.
//
// - Always defines a no-op window.ga, because tripwire.php calls ga('send', 'pageview') every 4 minutes.
// - Only if GA_MEASUREMENT_ID is set (e.g. G-XXXXXXXXXX): loads your own GA4 property via gtag.js and
//   forwards ga('send', 'pageview') to a GA4 page_view event. Unset = no third-party requests.

$tw_ga_id = getenv('GA_MEASUREMENT_ID');
$tw_ga_id = ($tw_ga_id === false) ? '' : trim($tw_ga_id);
?>
<script type="text/javascript">
	window.ga = window.ga || function() {};
</script>
<?php if ($tw_ga_id !== '') { ?>
<!-- Google Analytics (GA_MEASUREMENT_ID) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=<?= rawurlencode($tw_ga_id) ?>"></script>
<script type="text/javascript">
	window.dataLayer = window.dataLayer || [];
	function gtag(){dataLayer.push(arguments);}
	gtag('js', new Date());
	gtag('config', <?= json_encode($tw_ga_id, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>);
	window.ga = function(command, hitType) {
		if (command === 'send' && hitType === 'pageview') gtag('event', 'page_view');
	};
</script>
<?php }
