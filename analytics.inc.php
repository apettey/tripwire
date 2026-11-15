<?php
// Defence in depth: callers also check these settings, but do not emit a
// tracker if this file is included directly by another template.
if (!defined('ENABLE_ANALYTICS') || !ENABLE_ANALYTICS) {
	return;
}
?>
<!-- Google Analytics -->
<script type="text/javascript">
	(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){
	(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),
	m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)
	})(window,document,'script','//www.google-analytics.com/analytics.js','ga');

	ga('create', 'UA-48258312-1', 'auto');
	ga('send', 'pageview');
</script>
