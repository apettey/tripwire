<?php
// Docker config: every setting comes from an environment variable.
// Mirrors config.example.php - keep in sync when upstream adds settings.

if (!function_exists('tw_env')) {
    function tw_env($name, $default = null) {
        $value = getenv($name);
        return ($value === false || $value === '') ? $default : $value;
    }
}

if (!function_exists('tw_env_bool')) {
    function tw_env_bool($name, $default) {
        $value = tw_env($name);
        $value = $value === null ? null : filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        return $value === null ? $default : $value;
    }
}

date_default_timezone_set(tw_env('TZ', 'UTC'));

define('APP_NAME', tw_env('APP_NAME', 'Tripwire'));

// Content file server (Use CDN here if you have one) - used for serving images, css, js files
define('CDN_DOMAIN', tw_env('CDN_DOMAIN', tw_env('TRIPWIRE_DOMAIN', 'localhost')));

// EVE SDE database name (only used by tools/)
define('EVE_DUMP', tw_env('EVE_DUMP', 'eve_dump'));

define('TRIPWIRE_API', tw_env_bool('TRIPWIRE_API', true));

define('USER_AGENT', tw_env('USER_AGENT', 'Tripwire Server - ' . tw_env('ADMIN_EMAIL', 'admin@example.com')));

// EVE SSO info
define('EVE_SSO_CLIENT', tw_env('EVE_SSO_CLIENT', ''));
define('EVE_SSO_SECRET', tw_env('EVE_SSO_SECRET', ''));
define('EVE_SSO_REDIRECT', tw_env('EVE_SSO_REDIRECT',
    (tw_env_bool('TRIPWIRE_HTTPS', true) ? 'https' : 'http') . '://' . tw_env('TRIPWIRE_DOMAIN', 'localhost') . '/index.php?mode=sso'));

define('ENABLE_SEARCH_SCOPE', tw_env_bool('ENABLE_SEARCH_SCOPE', true));

// Discord integration: DISCORD_WEB_HOOK='{"maskID":"https://discord.com/api/webhooks/..."}'
if (tw_env('DISCORD_WEB_HOOK')) {
    define('DISCORD_WEB_HOOK', json_decode(tw_env('DISCORD_WEB_HOOK'), true));
}

// Kill Reporting (fork): zkill_feed.worker.php follows zKillboard's R2Z2 feed once for the instance;
// public/kills.php marks kills by/against these corporations (plus the user's own) as friendly
define('ZKILL_FEED_ENABLED', tw_env_bool('ZKILL_FEED_ENABLED', true));
define('KILL_REPORT_FRIENDLY_CORPORATIONS', tw_env('KILL_REPORT_FRIENDLY_CORPORATIONS', ''));

// zKillboard integration (fork, zkill/): how long stored kills are kept (hours, 1-168) and the minimum
// spacing of zKillboard API requests made by the worker for back-fills (seconds, 1-60)
define('ZKILL_RETENTION_HOURS', tw_env('ZKILL_RETENTION_HOURS', 48));
define('ZKILL_API_INTERVAL', tw_env('ZKILL_API_INTERVAL', 2));

// Discord notifications (fork, discord/, docker/README.md#discord-notifications). Read straight from the
// environment by discord/ (no constants, so the key never shows up in defined constants):
//   DISCORD_SECRET_KEY  long random string; webhook URLs are stored encrypted with a key derived from it.
//                       Unset = stored in plain text (still never sent to browsers). Changing or removing it
//                       makes stored webhooks unreadable: they are marked broken and must be added again.
//   DISCORD_API_BASE    dev only: base URL of a local fake Discord (local hosts only; ignored otherwise).
