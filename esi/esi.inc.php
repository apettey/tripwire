<?php
// Fork-owned: ESI compatibility date and rate-limit handling for the server's own ESI calls
// (esi.class.php, public/cached_third_party.php). The pooled zKillboard module (zkill/) keeps its own HTTP client
// and limiter but takes the date from here. Browser calls: app/js/fork/esi-limits.js (keep both dates equal).
//
// ESI picks a route's behaviour by compatibility date (X-Compatibility-Date header or compatibility_date query
// parameter, YYYY-MM-DD); without one it serves the oldest date (2020-01-01). Path prefixes such as /v4/ or
// /latest/ no longer select a version. Change the date only after checking that the response shapes of every
// route we call are unchanged (see changes/2026-10-10-esi-compat-rate-limits/README.md).
//
// Limits: 429 (rate limit, Retry-After), 420 (legacy error limit, X-ESI-Error-Limit-Reset) and nearly used-up
// budgets pause the affected requests. Pauses are shared between PHP processes through a small JSON file in
// cache/, so php-fpm workers and the cron jobs don't keep calling ESI while it asks us to wait; each pause is
// logged once when it starts. A paused request is not sent: callers see it as a failed request.

const ESI_COMPATIBILITY_DATE = '2025-12-16';
const ESI_HOST = 'esi.evetech.net';
const ESI_ERROR_LIMIT_FLOOR = 10;   // pause everything when fewer errors than this are left in the window
const ESI_DEFAULT_PAUSE = 60;       // seconds, when ESI doesn't say how long
const ESI_MAX_PAUSE = 900;          // seconds; ESI's rate-limit window is 15 minutes
const ESI_LOW_TOKENS_PAUSE = 60;    // seconds to wait when a rate-limit group is nearly used up

function esi_is_url($url) {
    return strtolower((string) parse_url((string) $url, PHP_URL_HOST)) === ESI_HOST;
}

/** Route of an ESI URL without version prefix, query or IDs, e.g. /v4/corporations/123/ => corporations/{id} */
function esi_route_key($url) {
    $path = strtolower(trim((string) parse_url((string) $url, PHP_URL_PATH), '/'));
    $path = preg_replace('#^(v\d+|latest|legacy|dev)(/|$)#', '', $path);
    $path = preg_replace('#(^|/)\d+(?=/|$)#', '$1{id}', $path);
    return $path;
}

/** Character ID of a /characters/{id}/... URL, or null */
function esi_character_of($url) {
    $path = (string) parse_url((string) $url, PHP_URL_PATH);
    return preg_match('#/characters/(\d+)(/|$)#', $path, $m) ? $m[1] : null;
}

/** Whether a list of "Name: value" request headers carries an access token */
function esi_is_authenticated(array $headers) {
    foreach ($headers as $header) {
        if (stripos(ltrim((string) $header), 'authorization:') === 0) return true;
    }
    return false;
}

/** Seconds from a Retry-After value (delta seconds or HTTP date), or null */
function esi_retry_after($value, $now = null) {
    if ($value === null || $value === '') return null;
    if (is_numeric($value)) return max(0, (int) $value);
    $time = strtotime((string) $value);
    if ($time === false) return null;
    return max(0, $time - (int) ($now ?? time()));
}

function esi_clamp_pause($seconds) {
    return max(1, min(ESI_MAX_PAUSE, (int) ceil($seconds)));
}

/** Pause key of a rate-limit group; authenticated buckets are per character, so the key is too */
function esi_group_key($group, $characterID) {
    return 'group:' . strtolower($group) . ($characterID !== null ? ':' . $characterID : '');
}

/**
 * Pure decision for one response (headers lower-cased): which pauses to start and which group the route is in.
 * @return array ['group' => string|null, 'pauses' => [key => seconds]]
 */
function esi_limit_decision($url, $status, array $headers, $authenticated, $now = null) {
    $route = esi_route_key($url);
    $group = isset($headers['x-ratelimit-group']) && $headers['x-ratelimit-group'] !== '' ? strtolower($headers['x-ratelimit-group']) : null;
    $characterID = $authenticated ? esi_character_of($url) : null;
    $routeKey = $group !== null ? esi_group_key($group, $characterID) : 'route:' . $route;
    $retryAfter = esi_retry_after($headers['retry-after'] ?? null, $now);
    $errorReset = isset($headers['x-esi-error-limit-reset']) && is_numeric($headers['x-esi-error-limit-reset'])
        ? (int) $headers['x-esi-error-limit-reset'] : null;
    $pauses = [];
    $add = function ($key, $seconds) use (&$pauses) {
        $seconds = esi_clamp_pause($seconds);
        $pauses[$key] = max($pauses[$key] ?? 0, $seconds);
    };

    if ($status === 420) {
        // Legacy error limit: ESI rejects every route from this IP until the window resets
        $add('*', $retryAfter ?? ($errorReset !== null ? $errorReset + 1 : ESI_DEFAULT_PAUSE));
    } elseif ($status === 429) {
        $add($routeKey, $retryAfter ?? ESI_DEFAULT_PAUSE);
    }
    if (isset($headers['x-esi-error-limit-remain']) && is_numeric($headers['x-esi-error-limit-remain'])
        && (int) $headers['x-esi-error-limit-remain'] < ESI_ERROR_LIMIT_FLOOR) {
        $add('*', $errorReset !== null ? $errorReset + 1 : ESI_DEFAULT_PAUSE);
    }
    if ($group !== null && isset($headers['x-ratelimit-remaining']) && is_numeric($headers['x-ratelimit-remaining'])) {
        $limit = isset($headers['x-ratelimit-limit']) ? (int) $headers['x-ratelimit-limit'] : 0;   // "150/15m" => 150
        if ((int) $headers['x-ratelimit-remaining'] < max(5, (int) floor($limit * 0.05))) {
            $add($routeKey, $retryAfter ?? ESI_LOW_TOKENS_PAUSE);
        }
    }
    return ['group' => $group, 'pauses' => $pauses];
}

/** Keys that can pause a request to this URL, given the route => group map learned from earlier responses */
function esi_pause_keys($url, $authenticated, array $routes) {
    $route = esi_route_key($url);
    $keys = ['*', 'route:' . $route];
    if (isset($routes[$route])) {
        $keys[] = esi_group_key($routes[$route], $authenticated ? esi_character_of($url) : null);
    }
    return $keys;
}

/** Seconds this request has to wait (0 = go) */
function esi_paused_for($url, $authenticated, array $state, $now = null) {
    $now = $now ?? microtime(true);
    $wait = 0.0;
    foreach (esi_pause_keys($url, $authenticated, $state['routes'] ?? []) as $key) {
        $until = $state['pauses'][$key] ?? 0;
        if ($until > $now) $wait = max($wait, (float) ($until - $now));
    }
    return $wait;
}

/** Apply a decision to the state; @return array the pause keys that just started (were not paused before) */
function esi_limit_apply(array &$state, $url, array $decision, $now = null) {
    $now = $now ?? microtime(true);
    $state += ['pauses' => [], 'routes' => []];
    foreach ($state['pauses'] as $key => $until) {
        if ($until <= $now) unset($state['pauses'][$key]);
    }
    if ($decision['group'] !== null) {
        $state['routes'][esi_route_key($url)] = $decision['group'];
        if (count($state['routes']) > 200) $state['routes'] = array_slice($state['routes'], -200, null, true);
    }
    $started = [];
    foreach ($decision['pauses'] as $key => $seconds) {
        $previous = $state['pauses'][$key] ?? 0;
        if ($previous <= $now) $started[$key] = $seconds;
        $state['pauses'][$key] = max($previous, $now + $seconds);
    }
    return $started;
}

// --- shared state (cache/esi-limits.json, flock) ---

function esi_limit_state_file(?string $set = null) {
    static $file = null;
    if ($set !== null) $file = $set;
    if ($file === null) {
        $dir = dirname(__DIR__) . '/cache';
        $file = (is_dir($dir) && is_writable($dir) ? $dir : sys_get_temp_dir()) . '/esi-limits.json';
    }
    return $file;
}

/** Decoded state in the expected shape (a damaged or foreign file must never break ESI calls) */
function esi_limit_state_normalise($state) {
    $state = is_array($state) ? $state : [];
    $pauses = is_array($state['pauses'] ?? null) ? $state['pauses'] : [];
    $routes = is_array($state['routes'] ?? null) ? $state['routes'] : [];
    return [
        'pauses' => array_filter($pauses, function ($until) { return is_int($until) || is_float($until); }),
        'routes' => array_filter($routes, function ($group) { return is_string($group) && $group !== ''; }),
    ];
}

function esi_limit_state_read() {
    $raw = @file_get_contents(esi_limit_state_file());
    return esi_limit_state_normalise($raw ? json_decode($raw, true) : null);
}

/**
 * Read-modify-write the shared state under an exclusive lock; $fn(array &$state) returns the result.
 * $persisted is false when the state file can't be opened (the decision then only applies to this request).
 */
function esi_limit_state_update(callable $fn, &$persisted = null) {
    $file = esi_limit_state_file();
    $created = !file_exists($file);
    $handle = @fopen($file, 'c+');
    if ($handle && $created) @chmod($file, 0666);   // cron, php-fpm and admin shells may run as different users
    $persisted = (bool) $handle;
    if (!$handle) {
        $state = esi_limit_state_normalise(null);   // can't share state: still decide for this request
        return $fn($state);
    }
    flock($handle, LOCK_EX);
    $raw = stream_get_contents($handle);
    $state = esi_limit_state_normalise($raw ? json_decode($raw, true) : null);
    $result = $fn($state);
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, json_encode($state));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
    return $result;
}

function esi_log($message) {
    error_log('[tripwire] ESI: ' . $message);
}

// --- hooks for HTTP clients ---

/**
 * Before an ESI request: adds X-Compatibility-Date to $headers. Returns null to go ahead, or an error text when
 * ESI asked us to wait (the request must not be sent). Non-ESI URLs are left alone.
 */
function esi_before_request($url, array &$headers) {
    if (!esi_is_url($url)) return null;
    $hasDate = false;
    foreach ($headers as $header) {
        if (stripos(ltrim((string) $header), 'x-compatibility-date:') === 0) $hasDate = true;
    }
    if (!$hasDate) $headers[] = 'X-Compatibility-Date: ' . ESI_COMPATIBILITY_DATE;
    $wait = esi_paused_for($url, esi_is_authenticated($headers), esi_limit_state_read());
    return $wait > 0 ? 'ESI asked us to wait (rate limit): retry in ' . (int) ceil($wait) . ' s' : null;
}

/** CURLOPT_HEADERFUNCTION collecting lower-cased response headers into $headers */
function esi_header_collector(array &$headers) {
    return function ($curl, $line) use (&$headers) {
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
        return strlen($line);
    };
}

/** After an ESI response (headers lower-cased): start pauses ESI asked for, log each new one once */
function esi_after_response($url, $status, array $responseHeaders, array $requestHeaders = []) {
    if (!esi_is_url($url)) return;
    $decision = esi_limit_decision($url, (int) $status, $responseHeaders, esi_is_authenticated($requestHeaders));
    if (!$decision['pauses']) {
        // Nothing to pause: only write when there is a new route => group pair to remember
        if ($decision['group'] === null) return;
        $state = esi_limit_state_read();
        if (($state['routes'][esi_route_key($url)] ?? null) === $decision['group']) return;
    }
    $started = esi_limit_state_update(function (array &$state) use ($url, $decision) {
        return esi_limit_apply($state, $url, $decision);
    }, $persisted);
    if (!$persisted) {
        // Nothing is remembered, so every limited response would look like a new pause: say so once instead
        static $warned = false;
        if (!$warned && $decision['pauses']) {
            $warned = true;
            esi_log('cannot write ' . esi_limit_state_file() . ': ESI limits are not remembered between requests');
        }
        return;
    }
    foreach ($started as $key => $seconds) {
        esi_log("HTTP $status from " . esi_route_key($url) . ": pausing " . ($key === '*' ? 'all ESI requests' : $key)
            . " for $seconds s");
    }
}

// --- ETag cache (GET requests) ---
// A GET with a stored ETag is sent with If-None-Match; ESI answers 304 (no body, cheaper on rate limits) and the
// stored body is returned as a 200, so callers never see the 304. One small file per URL (and per access token,
// so a character's data is never served to another) in cache/esi-etag/, shared by all PHP processes.

const ESI_ETAG_MAX_BODY = 1048576;   // bytes; larger bodies are not stored
const ESI_ETAG_MAX_AGE  = 604800;    // seconds; unused entries are deleted after a week

function esi_etag_dir(?string $set = null) {
    static $dir = null;
    if ($set !== null) $dir = $set;
    if ($dir === null) {
        $base = dirname(__DIR__) . '/cache';
        $dir = (is_dir($base) && is_writable($base) ? $base : sys_get_temp_dir()) . '/esi-etag';
    }
    return $dir;
}

/** Routes that are fetched again and again; immutable per-ID routes (killmails/*, types, ...) are never stored */
function esi_etag_routes() {
    return ['fw/systems', 'universe/system_jumps', 'universe/system_kills', 'skyhooks/raidable', 'characters/affiliation',
        'corporations/{id}', 'alliances/{id}', 'characters/{id}'];
}

function esi_etag_allowed($url) {
    $route = esi_route_key($url);
    return in_array($route, esi_etag_routes(), true) || strpos($route, 'sovereignty/') === 0;
}

/** Cache key: URL plus what changes the answer (token, compatibility date, language) */
function esi_etag_file($url, array $headers = []) {
    $vary = ['authorization' => '', 'x-compatibility-date' => '', 'accept-language' => ''];
    foreach ($headers as $header) {
        $parts = explode(':', (string) $header, 2);
        $name = strtolower(trim($parts[0]));
        if (isset($vary[$name]) && count($parts) === 2) $vary[$name] = $name === 'authorization' ? trim($parts[1]) : strtolower(trim($parts[1]));
    }
    return esi_etag_dir() . '/' . sha1(strtolower($url) . "\n" . implode("\n", $vary)) . '.json';
}

/** @return array|null ['etag' => string, 'body' => string, 'headers' => array] stored for this request */
function esi_etag_load($url, array $headers = []) {
    if (!esi_etag_allowed($url)) return null;
    $raw = @file_get_contents(esi_etag_file($url, $headers));
    $entry = $raw ? json_decode($raw, true) : null;
    return is_array($entry) && is_string($entry['etag'] ?? null) && is_string($entry['body'] ?? null) ? $entry : null;
}

/** Remember a 200 response that carries an ETag (weak or strong); anything else is ignored */
function esi_etag_store($url, array $requestHeaders, $body, array $responseHeaders) {
    $etag = $responseHeaders['etag'] ?? '';
    if ($etag === '' || !esi_etag_allowed($url) || !is_string($body) || strlen($body) > ESI_ETAG_MAX_BODY) return;
    $dir = esi_etag_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0777, true) && !is_dir($dir)) return;
    $keep = array_intersect_key($responseHeaders, array_flip(['content-type', 'x-pages', 'expires', 'last-modified']));
    $file = esi_etag_file($url, $requestHeaders);
    $tmp = $file . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode(['etag' => $etag, 'body' => $body, 'headers' => $keep])) === false) return;
    @chmod($tmp, 0666);
    if (!@rename($tmp, $file)) @unlink($tmp);
    esi_etag_prune();
}

/** Delete unused entries and stray temp files; runs at most once an hour (marker file) unless $force */
function esi_etag_prune($now = null, $force = false) {
    $now = $now ?? time();
    $marker = esi_etag_dir() . '/.pruned';
    clearstatcache();
    if (!$force && @filemtime($marker) > $now - 3600) return;
    @touch($marker, $now);
    foreach (glob(esi_etag_dir() . '/*.json') ?: [] as $file) {
        if (@filemtime($file) < $now - ESI_ETAG_MAX_AGE) @unlink($file);
    }
    foreach (glob(esi_etag_dir() . '/*.tmp') ?: [] as $file) {
        if (@filemtime($file) < $now - 3600) @unlink($file);
    }
}

/** Adds If-None-Match to $headers when a stored ETag exists; @return array|null the stored entry */
function esi_etag_prepare($url, array &$headers) {
    $entry = esi_etag_load($url, $headers);
    if ($entry) $headers[] = 'If-None-Match: ' . $entry['etag'];
    return $entry;
}

/** Hook for a finished GET: 304 => [200, stored body, headers], 200 => remember its ETag. @return array [status, body, headers] */
function esi_etag_finish($url, array $requestHeaders, ?array $entry, $status, $body, array $responseHeaders) {
    if ($status === 304 && $entry) {
        @touch(esi_etag_file($url, $requestHeaders));   // keeps a used entry out of the prune
        return [200, $entry['body'], $responseHeaders + ($entry['headers'] ?? [])];
    }
    if ($status === 200) esi_etag_store($url, $requestHeaders, $body, $responseHeaders);
    return [$status, $body, $responseHeaders];
}

/**
 * Test hook: a callable($method, $url, $headers, $body) returning [status, body, headers] replaces the network
 * for esi_request(). null = real requests.
 */
function esi_transport(?callable $set = null, $clear = false) {
    static $transport = null;
    if ($clear) $transport = null;
    elseif ($set !== null) $transport = $set;
    return $transport;
}

/** One ESI request through the hooks. @return array [status (0 = network error, -1 = paused, not sent), body or error, headers] */
function esi_request($method, $url, array $headers = [], $body = null, $timeout = 30) {
    if ($error = esi_before_request($url, $headers)) return [-1, $error, []];
    $entry = $method === 'GET' && esi_is_url($url) ? esi_etag_prepare($url, $headers) : null;
    $transport = esi_transport();
    if ($transport) {
        [$status, $response, $responseHeaders] = $transport($method, $url, $headers, $body);
    } else {
        $responseHeaders = [];
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_USERAGENT      => defined('USER_AGENT') ? USER_AGENT : (getenv('USER_AGENT') ?: 'Tripwire Server'),
            CURLOPT_CONNECTTIMEOUT => min(10, $timeout),
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_HEADERFUNCTION => esi_header_collector($responseHeaders),
        ]);
        if ($method === 'POST') {
            curl_setopt($curl, CURLOPT_POST, true);
            curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
        }
        $response = curl_exec($curl);
        $status = $response === false ? 0 : (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        if ($response === false) $response = curl_error($curl);
    }
    esi_after_response($url, $status, $responseHeaders, $headers);
    if ($method === 'GET' && esi_is_url($url)) return esi_etag_finish($url, $headers, $entry, $status, $response, $responseHeaders);
    return [$status, $response, $responseHeaders];
}

/**
 * Drop-in for fopen($url, 'r') when filling a cache file (public/cached_third_party.php). Non-ESI URLs are
 * opened exactly as before. ESI URLs go through esi_request(); when ESI is paused or fails, the stale cache
 * file (if any) is returned instead, so the caller rewrites it and doesn't ask again until it expires.
 * @return resource|false
 */
function esi_open_url($url, $staleFile = null) {
    if (!esi_is_url($url)) return fopen($url, 'r');
    [$status, $body] = esi_request('GET', $url, ['Accept: application/json']);
    if ($status === 200) {
        $content = $body;
    } elseif ($staleFile !== null && is_readable($staleFile)) {
        $content = file_get_contents($staleFile);
        if ($content === false || $content === '') return false;
    } else {
        return false;
    }
    $stream = fopen('php://temp', 'r+');
    fwrite($stream, $content);
    rewind($stream);
    return $stream;
}
