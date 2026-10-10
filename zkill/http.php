<?php
// Fork-owned: the single HTTP client of the zKillboard integration (see zkill/zkill.inc.php).
//
// Rate limits are per host and in-process: only zkill_feed.worker.php makes outgoing requests, so one process
// holds the whole instance's budget. A host is "ready" when its next allowed time has passed. Every request
// reserves the host's spacing when it starts; 429 (Retry-After), 420/5xx and network errors push the next time
// out exponentially; 403 or a non-JSON answer (e.g. a Cloudflare challenge page) block the host for at least
// ZK_HTTP_BLOCK_FLOOR seconds; ESI's error-limit and rate-limit headers pause ESI before it blocks us.

const ZK_HTTP_BLOCK_FLOOR = 600;    // seconds a host stays paused after a 403 / challenge page

/** Minimum spacing (seconds) between requests per host */
function zk_http_intervals() {
    return [
        'r2z2.zkillboard.com' => 0.0,                    // the worker paces R2Z2 itself (<= 4/s, R2Z2 allows 15/s)
        'zkillboard.com'      => (float) zk_api_interval(),
        'esi.evetech.net'     => 0.05,
    ];
}

/** Per-host state: next allowed request time (float), consecutive failures */
function &zk_http_state() {
    static $state = [];
    return $state;
}

function zk_http_host($url) {
    return strtolower((string) parse_url($url, PHP_URL_HOST));
}

/** Seconds until a request to this host is allowed (0 = now) */
function zk_http_wait($host) {
    $state = &zk_http_state();
    $next = $state[$host]['next'] ?? 0.0;
    return max(0.0, $next - microtime(true));
}

function zk_http_ready($host) {
    return zk_http_wait($host) <= 0.0;
}

/** Pause a host until at least $until (unix time, float) */
function zk_http_pause($host, $until) {
    $state = &zk_http_state();
    $entry = $state[$host] ?? ['next' => 0.0, 'failures' => 0];
    $entry['next'] = max($entry['next'], $until);
    $state[$host] = $entry;
}

/** Reserve the host's spacing for a request starting now */
function zk_http_reserve($host) {
    $intervals = zk_http_intervals();
    zk_http_pause($host, microtime(true) + ($intervals[$host] ?? 0.5));
}

/** Stop calling a host that refuses us (403, challenge page): at least ZK_HTTP_BLOCK_FLOOR seconds, logged loudly */
function zk_http_block($host, $seconds, $reason) {
    $seconds = max(ZK_HTTP_BLOCK_FLOOR, (int) $seconds);
    zk_http_pause($host, microtime(true) + $seconds);
    zk_log("BLOCKED by $host ($reason): no requests to it for " . round($seconds / 60) . ' min');
}

/** Record the outcome of a request (headers lower-cased) and push the host's next allowed time out if needed */
function zk_http_record($host, $status, array $headers) {
    $state = &zk_http_state();
    $now = microtime(true);
    $entry = $state[$host] ?? ['next' => 0.0, 'failures' => 0];
    $retryAfter = isset($headers['retry-after']) && is_numeric($headers['retry-after']) ? (int) $headers['retry-after'] : 0;

    if ($status === 403) {
        $state[$host] = $entry;
        zk_http_block($host, $retryAfter, 'HTTP 403');
        return;
    }
    if ($status === 429 || $status === 420 || $status === 0 || $status >= 500) {
        $entry['failures']++;
        $backoff = min(300, 10 * (2 ** min(5, $entry['failures'] - 1)));
        $entry['next'] = max($entry['next'], $now + max($backoff, $retryAfter));
    } else {
        $entry['failures'] = 0;
    }
    // ESI: stop before the error limit is used up (it resets every X-ESI-Error-Limit-Reset seconds)
    if (isset($headers['x-esi-error-limit-remain'], $headers['x-esi-error-limit-reset'])
        && (int) $headers['x-esi-error-limit-remain'] < 20) {
        $entry['next'] = max($entry['next'], $now + (int) $headers['x-esi-error-limit-reset'] + 1);
    }
    // ESI rate-limit groups (floating window, e.g. "3600/15m"): pause a minute when nearly used up
    if (isset($headers['x-ratelimit-remaining']) && is_numeric($headers['x-ratelimit-remaining'])) {
        $limit = isset($headers['x-ratelimit-limit']) ? (int) $headers['x-ratelimit-limit'] : 0;
        if ((int) $headers['x-ratelimit-remaining'] < max(5, (int) ($limit * 0.05))) {
            $entry['next'] = max($entry['next'], $now + 60);
        }
    }
    $state[$host] = $entry;
}

function zk_http_options($url, $method, $body, $timeout) {
    $headers = ['Accept: application/json'];
    if (zk_http_host($url) === 'esi.evetech.net') $headers[] = 'X-Compatibility-Date: ' . ZK_ESI_COMPATIBILITY_DATE;
    $options = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERAGENT      => zk_user_agent(),
        CURLOPT_ENCODING       => 'gzip',   // sends Accept-Encoding: gzip and decodes the response
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_CONNECTTIMEOUT => min(10, $timeout),
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
    ];
    if ($method === 'POST') {
        $headers[] = 'Content-Type: application/json';
        $options[CURLOPT_HTTPHEADER] = $headers;
        $options[CURLOPT_POST] = true;
        $options[CURLOPT_POSTFIELDS] = $body;
    }
    return $options;
}

/** Header callback collecting lower-cased response headers into $headers */
function zk_http_header_collector(array &$headers) {
    return function ($curl, $line) use (&$headers) {
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
        return strlen($line);
    };
}

/**
 * Test hook: a callable($method, $url, $body) returning [status, body, headers] replaces the network for
 * zk_http_request() (rate limiting and blocking still apply). null = real requests.
 */
function zk_http_transport(?callable $set = null, $clear = false) {
    static $transport = null;
    if ($clear) $transport = null;
    elseif ($set !== null) $transport = $set;
    return $transport;
}

/**
 * One request. Waits for the host's rate limit when $wait is true, otherwise returns status -1 if not ready.
 * @return array [status (0 = network error, -1 = rate limited, not sent), body or error text, headers]
 */
function zk_http_request($method, $url, $body = null, $wait = true, $timeout = 30) {
    $host = zk_http_host($url);
    $delay = zk_http_wait($host);
    if ($delay > 0) {
        if (!$wait) return [-1, 'rate limited', []];
        usleep((int) ceil($delay * 1e6));
    }
    zk_http_reserve($host);
    $transport = zk_http_transport();
    if ($transport) {
        [$status, $response, $headers] = $transport($method, $url, $body);
        zk_http_record($host, $status, $headers);
        return [$status, $response, $headers];
    }
    $headers = [];
    $curl = curl_init($url);
    curl_setopt_array($curl, zk_http_options($url, $method, $body, $timeout));
    curl_setopt($curl, CURLOPT_HEADERFUNCTION, zk_http_header_collector($headers));
    $response = curl_exec($curl);
    $status = $response === false ? 0 : (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = $response === false ? curl_error($curl) : '';
    curl_close($curl);
    zk_http_record($host, $status, $headers);
    return [$status, $response === false ? $error : $response, $headers];
}

function zk_http_get($url, $wait = true, $timeout = 30) {
    return zk_http_request('GET', $url, null, $wait, $timeout);
}

/**
 * JSON GET against the zKillboard / ESI APIs. A 200 that isn't JSON (Cloudflare challenge, maintenance page)
 * blocks the host like a 403. @return array [status, decoded value or null, raw body]
 */
function zk_http_get_json($url, $wait = true, $timeout = 30) {
    [$status, $body] = zk_http_get($url, $wait, $timeout);
    $data = $status === 200 ? json_decode($body, true) : null;
    if ($status === 200 && $data === null) {
        zk_http_block(zk_http_host($url), 0, 'HTTP 200 without JSON: ' . substr(preg_replace('/\s+/', ' ', strip_tags((string) $body)), 0, 80));
    }
    return [$status, $data, $body];
}

/**
 * Several GETs to one host with bounded concurrency (curl_multi). Each request keeps the host's spacing; no new
 * request starts once the host is paused (429/5xx/403/ESI limits/non-JSON answer) or after $deadline (unix time).
 * URLs that were not requested come back with status -1, non-JSON 200 answers with -2.
 * @return array url => [status, body]
 */
function zk_http_get_many(array $urls, $concurrency = 5, $timeout = 10, $deadline = null) {
    $results = [];
    $queue = array_values(array_unique($urls));
    if (!$queue) return $results;
    $host = zk_http_host($queue[0]);
    $intervals = zk_http_intervals();
    $spacing = $intervals[$host] ?? 0.5;
    $multi = curl_multi_init();
    $active = [];   // spl_object_id(handle) => ['handle', 'url', 'headers']

    $start = function () use (&$queue, &$active, $multi, $host, $spacing, $timeout, $deadline) {
        if (!$queue || ($deadline !== null && microtime(true) >= $deadline)) return false;
        $wait = zk_http_wait($host);
        if ($wait > $spacing) return false;                 // paused (limits, errors): stop starting requests
        if ($wait > 0) usleep((int) ceil($wait * 1e6));    // just the spacing
        zk_http_reserve($host);
        $url = array_shift($queue);
        $handle = curl_init($url);
        $id = spl_object_id($handle);
        $active[$id] = ['handle' => $handle, 'url' => $url, 'headers' => []];
        curl_setopt_array($handle, zk_http_options($url, 'GET', null, $timeout));
        curl_setopt($handle, CURLOPT_HEADERFUNCTION, zk_http_header_collector($active[$id]['headers']));
        curl_multi_add_handle($multi, $handle);
        return true;
    };

    while (count($active) < $concurrency && $start()) {}
    while ($active) {
        curl_multi_exec($multi, $running);
        if (curl_multi_select($multi, 1.0) === -1) usleep(10000);
        while ($info = curl_multi_info_read($multi)) {
            $handle = $info['handle'];
            $id = spl_object_id($handle);
            $entry = $active[$id];
            $body = curl_multi_getcontent($handle);
            $status = $info['result'] === CURLE_OK ? (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE) : 0;
            zk_http_record($host, $status, $entry['headers']);
            if ($status === 200 && json_decode((string) $body) === null) {
                // A challenge / maintenance page instead of JSON: stop calling the host (403 is handled by record)
                zk_http_block($host, 0, 'HTTP 200 without JSON: ' . substr(preg_replace('/\s+/', ' ', strip_tags((string) $body)), 0, 80));
                $status = -2;
            }
            $results[$entry['url']] = [$status, $status === 0 ? curl_error($handle) : $body];
            curl_multi_remove_handle($multi, $handle);
            curl_close($handle);
            unset($active[$id]);
        }
        while (count($active) < $concurrency && $start()) {}
    }
    curl_multi_close($multi);
    foreach ($queue as $url) $results[$url] = [-1, 'not requested'];
    return $results;
}
