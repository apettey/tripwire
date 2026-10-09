<?php

// Place all app configs here
date_default_timezone_set('UTC');

// Application name
define('APP_NAME', 'Tripwire');

// Content file server (Use CDN here if you have one) - used for serving images, css, js files
define('CDN_DOMAIN', 'your domain');

// EVE SDE table name
define('EVE_DUMP', 'eve_dump');

// Enable Tripwire API?
define('TRIPWIRE_API', true);

// EVE API userAgent
define('USER_AGENT', 'Tripwire Server - adminEmail@example.com');

// EVE SSO info
define('EVE_SSO_CLIENT', 'client');
define('EVE_SSO_SECRET', 'secret');
define('EVE_SSO_REDIRECT', 'https://yourdomain/index.php?mode=sso');

// As of 2022-07-12, searching via the ESI API uses an endpoint that requires an
// authentication token. In order to use the new search functionality, you will
// need to add the `esi-search.search_structures.v1` scope to your application
// in the `developers.eveonline.com` portal. Once you have done that, this
// value can be changed from 'false' to 'true'.
define('ENABLE_SEARCH_SCOPE', true);

// Discord integration
/*define('DISCORD_WEB_HOOK', array(
	'maskID' => 'https://discord.com/api/webhooks/[discord web hook url]'
));*/
