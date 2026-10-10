<?php
// Fork override of upstream's settings.php (copied over /opt/app/settings.php in the image, bind-mounted
// over it in the dev stack). See docker/README.md#versions.
//
// VERSION is what the app shows and compares everywhere (top-left of the app, landing page, the
// "Tripwire update available" prompt in public/refresh.php, ?v= cache busting): the fork release
// version from TRIPWIRE_FORK_VERSION (set at image build time by CI), "dev" when unset.
// UPSTREAM_VERSION is upstream's own define('VERSION', ...), read from upstream's settings.php, which the
// image keeps as settings.upstream.php (TRIPWIRE_UPSTREAM_SETTINGS overrides the path; the dev stack
// mounts the repo's settings.php outside /opt/app).
//
// Upstream's settings.php only defines VERSION today. If it ever defines anything else, this override
// hides it: revisit this file (docker/Dockerfile fails the build in that case).

if (!defined('VERSION')) {
	$forkVersion = trim((string) getenv('TRIPWIRE_FORK_VERSION'));
	// Output unescaped into HTML and URLs by upstream code, so only allow version-like strings
	define('VERSION', preg_match('/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/', $forkVersion) ? $forkVersion : 'dev');
	unset($forkVersion);
}

if (!defined('UPSTREAM_VERSION')) {
	$upstreamSettings = trim((string) getenv('TRIPWIRE_UPSTREAM_SETTINGS')) ?: __DIR__ . '/settings.upstream.php';
	$upstreamSource = is_readable($upstreamSettings) ? file_get_contents($upstreamSettings) : false;
	define('UPSTREAM_VERSION',
		$upstreamSource !== false && preg_match('/define\(\s*[\'"]VERSION[\'"]\s*,\s*[\'"]([^\'"]+)[\'"]\s*\)/', $upstreamSource, $m)
			? $m[1] : 'unknown');
	unset($upstreamSettings, $upstreamSource, $m);
}
