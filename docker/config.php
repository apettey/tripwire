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
