<?php
// Fork-owned: the single HTTP client of the zKillboard integration (see zkill/zkill.inc.php).
//
// Rate limits are per host and in-process: only zkill_feed.worker.php makes outgoing requests, so one process
// holds the whole instance's budget. A host is "ready" when its next allowed time has passed; 429 (Retry-After),
// 420/5xx and network errors push that time out, and ESI's error-limit headers pause ESI before it blocks us.

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

/** Record the outcome of a request and set the host's next allowed time */
function zk_http_record($host, $status, array $headers) {
    $state = &zk_http_state();
    $now = microtime(true);
    $intervals = zk_http_intervals();
    $entry = $state[$host] ?? ['next' => 0.0, 'failures' => 0];
    $next = $now + ($intervals[$host] ?? 0.5);

    if ($status === 429 || $status === 420 || $status === 0 || $status >= 500) {
        $entry['failures']++;
        $backoff = min(300, 10 * (2 ** min(5, $entry['failures'] - 1)));
        $retryAfter = isset($headers['retry-after']) && is_numeric($headers['retry-after']) ? (int) $headers['retry-after'] : 0;
        $next = max($next, $now + max($backoff, $retryAfter));
    } else {
        $entry['failures'] = 0;
    }
    // ESI: stop before the error limit is used up (it resets every X-ESI-Error-Limit-Reset seconds)
    if (isset($headers['x-esi-error-limit-remain'], $headers['x-esi-error-limit-reset'])
        && (int) $headers['x-esi-error-limit-remain'] < 20) {
        $next = max($next, $now + (int) $headers['x-esi-error-limit-reset'] + 1);
    }
    $entry['next'] = max($entry['next'], $next);
    $state[$host] = $entry;
}

function zk_http_options($method, $body) {
    $options = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERAGENT      => zk_user_agent(),
        CURLOPT_ENCODING       => 'gzip',   // sends Accept-Encoding: gzip and decodes the response
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
    ];
    if ($method === 'POST') {
        $options[CURLOPT_POST] = true;
        $options[CURLOPT_POSTFIELDS] = $body;
        $options[CURLOPT_HTTPHEADER] = ['Accept: application/json', 'Content-Type: application/json'];
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
 * One request. Waits for the host's rate limit when $wait is true, otherwise returns status -1 if not ready.
 * @return array [status (0 = network error, -1 = rate limited, not sent), body or error text, headers]
 */
function zk_http_request($method, $url, $body = null, $wait = true) {
    $host = zk_http_host($url);
    $delay = zk_http_wait($host);
    if ($delay > 0) {
        if (!$wait) return [-1, 'rate limited', []];
        usleep((int) ceil($delay * 1e6));
    }
    $headers = [];
    $curl = curl_init($url);
    curl_setopt_array($curl, zk_http_options($method, $body));
    curl_setopt($curl, CURLOPT_HEADERFUNCTION, zk_http_header_collector($headers));
    $response = curl_exec($curl);
    $status = $response === false ? 0 : (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = $response === false ? curl_error($curl) : '';
    curl_close($curl);
    zk_http_record($host, $status, $headers);
    return [$status, $response === false ? $error : $response, $headers];
}

function zk_http_get($url, $wait = true) {
    return zk_http_request('GET', $url, null, $wait);
}

/**
 * Several GETs to one host with bounded concurrency (curl_multi). Stops starting new requests once the host
 * is rate limited (429/5xx/ESI error limit); those URLs come back with status -1.
 * @return array url => [status, body]
 */
function zk_http_get_many(array $urls, $concurrency = 5) {
    $results = [];
    $queue = array_values(array_unique($urls));
    if (!$queue) return $results;
    $host = zk_http_host($queue[0]);
    $multi = curl_multi_init();
    $active = [];   // (int) handle id => [handle, url, headers]

    $start = function () use (&$queue, &$active, $multi, $host) {
        if (!$queue || !zk_http_ready($host)) return false;
        $url = array_shift($queue);
        $entry = ['handle' => curl_init($url), 'url' => $url, 'headers' => []];
        curl_setopt_array($entry['handle'], zk_http_options('GET', null));
        $active[(int) $entry['handle']] = $entry;
        $headers = &$active[(int) $entry['handle']]['headers'];
        curl_setopt($entry['handle'], CURLOPT_HEADERFUNCTION, zk_http_header_collector($headers));
        curl_multi_add_handle($multi, $entry['handle']);
        return true;
    };

    while (count($active) < $concurrency && $start()) {}
    while ($active) {
        curl_multi_exec($multi, $running);
        if (curl_multi_select($multi, 1.0) === -1) usleep(10000);
        while ($info = curl_multi_info_read($multi)) {
            $handle = $info['handle'];
            $entry = $active[(int) $handle];
            $body = curl_multi_getcontent($handle);
            $status = $info['result'] === CURLE_OK ? (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE) : 0;
            zk_http_record($host, $status, $entry['headers']);
            $results[$entry['url']] = [$status, $status === 0 ? curl_error($handle) : $body];
            curl_multi_remove_handle($multi, $handle);
            curl_close($handle);
            unset($active[(int) $handle]);
            if (count($active) < $concurrency) $start();
        }
    }
    curl_multi_close($multi);
    foreach ($queue as $url) $results[$url] = [-1, 'rate limited'];
    return $results;
}
