<?php
// Fork-owned: the one sender of Discord messages (see discord/discord.inc.php), run by discord_notify.worker.php.
//
// Rate limits are in-process (one dispatcher holds the instance's whole budget):
//   - per webhook: X-RateLimit-Remaining / X-RateLimit-Reset-After pause the webhook until its bucket resets;
//   - 429: retry_after (JSON body, else Retry-After) pauses the webhook, or every request when it is global
//     ("global": true / X-RateLimit-Global; also an HTML 429, i.e. a Cloudflare ban). The message stays queued
//     and the attempt isn't counted;
//   - 5xx / network errors: the message is retried with backoff (5 s doubling to 15 min), given up after
//     DISCORD_MAX_ATTEMPTS;
//   - 401 / 403 / 404 (unknown webhook, invalid token): the webhook is marked broken (shown in the settings) and its
//     queued messages fail; nothing more is sent to it until an admin replaces the URL. Other 4xx: that message fails.
// A pass sends at most $limit messages and stops after $budget seconds, so the worker loop stays responsive.

const DISCORD_HTTP_TIMEOUT   = 10;
const DISCORD_SPACING        = 0.05;   // seconds between any two requests (Discord's global limit is 50/s)
const DISCORD_NAMES_WAIT     = 90;     // seconds a kill message waits for names before it is sent with fallbacks

const DISCORD_BREAKER_WINDOW = 600;   // seconds
const DISCORD_BREAKER_LIMIT  = 500;   // refused requests (401/403/404/429/other 4xx) per window before all sending stops;
                                      // Cloudflare bans an IP from Discord's API at 10,000 per 10 minutes

/** In-process limiter state: ['global' => unix, 'buckets' => key => unix, 'last' => unix, 'refused' => [unix...]] */
function &discord_limits() {
    static $limits = ['global' => 0.0, 'buckets' => [], 'last' => 0.0, 'refused' => []];
    return $limits;
}

function discord_limits_reset() {
    $limits = &discord_limits();
    $limits = ['global' => 0.0, 'buckets' => [], 'last' => 0.0, 'refused' => []];
}

/**
 * Circuit breaker: count requests Discord refused (any 4xx, 429 included) over a rolling window. At the limit, every
 * request is paused until the oldest refusal leaves the window, and it is logged loudly. Returns true when it trips.
 */
function discord_breaker_record($status, $now = null) {
    $now = $now ?? microtime(true);
    $limits = &discord_limits();
    $limits['refused'] = array_values(array_filter($limits['refused'], function ($t) use ($now) { return $t > $now - DISCORD_BREAKER_WINDOW; }));
    if ($status < 400 || $status >= 500) return false;
    $limits['refused'][] = $now;
    if (count($limits['refused']) < DISCORD_BREAKER_LIMIT) return false;
    $until = $limits['refused'][0] + DISCORD_BREAKER_WINDOW;
    if ($until > $limits['global']) {
        $limits['global'] = $until;
        discord_log('CIRCUIT BREAKER: Discord refused ' . count($limits['refused']) . ' requests in the last '
            . (DISCORD_BREAKER_WINDOW / 60) . ' min; ALL sending paused for ' . round(($until - $now) / 60, 1) . ' min');
    }
    return true;
}

/** Seconds until a request to this bucket is allowed */
function discord_wait($bucket, $now = null) {
    $now = $now ?? microtime(true);
    $limits = &discord_limits();
    return max(0.0, max($limits['global'], $limits['buckets'][$bucket] ?? 0.0) - $now);
}

/**
 * Test hook: callable($url, $jsonBody) returning [status, body, headers (lower-case keys)] replaces the network.
 */
function discord_http_transport(?callable $set = null, $clear = false) {
    static $transport = null;
    if ($clear) $transport = null;
    elseif ($set !== null) $transport = $set;
    return $transport;
}

/** POST a payload. @return array [status (0 = network error), body or error text, headers] */
function discord_http_post($url, array $payload) {
    $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $transport = discord_http_transport();
    if ($transport) return $transport($url, $body);
    $headers = [];
    $version = defined('VERSION') ? VERSION : 'dev';
    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Accept: application/json'],
        CURLOPT_USERAGENT      => 'Tripwire (https://github.com/apettey/tripwire, ' . $version . ')',
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT        => DISCORD_HTTP_TIMEOUT,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$headers) {
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
            return strlen($line);
        },
    ]);
    $response = curl_exec($curl);
    $status = $response === false ? 0 : (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = $response === false ? curl_error($curl) : '';
    curl_close($curl);
    return [$status, $response === false ? $error : $response, $headers];
}

/** Short error text from a Discord error body ({"message": "...", "code": ...}) */
function discord_error_text($status, $body) {
    $data = json_decode((string) $body, true);
    if (is_array($data) && isset($data['message'])) return "HTTP $status: " . $data['message'] . (isset($data['code']) ? ' (' . $data['code'] . ')' : '');
    return "HTTP $status" . ($status === 0 ? ': ' . substr((string) $body, 0, 120) : '');
}

/**
 * What a response means, updating the limiter. Pure apart from the limiter state.
 * @return array ['result' => 'sent'|'ratelimited'|'retry'|'broken'|'failed', 'delay' => seconds, 'error' => text]
 */
function discord_handle_response($bucket, $status, array $headers, $body, $attempts, $now = null) {
    $now = $now ?? microtime(true);
    $limits = &discord_limits();
    discord_breaker_record($status, $now);
    // Bucket headers come with successes and 429s alike
    if (isset($headers['x-ratelimit-remaining'], $headers['x-ratelimit-reset-after']) && is_numeric($headers['x-ratelimit-reset-after'])
        && (int) $headers['x-ratelimit-remaining'] <= 0) {
        $limits['buckets'][$bucket] = max($limits['buckets'][$bucket] ?? 0.0, $now + (float) $headers['x-ratelimit-reset-after']);
    }
    if ($status === 200 || $status === 204) return ['result' => 'sent', 'delay' => 0, 'error' => ''];
    if ($status === 429) {
        $data = json_decode((string) $body, true);
        $retry = is_array($data) && isset($data['retry_after']) && is_numeric($data['retry_after']) ? (float) $data['retry_after']
            : (isset($headers['retry-after']) && is_numeric($headers['retry-after']) ? (float) $headers['retry-after'] : 60.0);
        $retry = max(0.5, min(3600.0, $retry));
        $global = (is_array($data) && !empty($data['global'])) || (isset($headers['x-ratelimit-global']) && strtolower($headers['x-ratelimit-global']) === 'true')
            || !is_array($data);   // not JSON: Cloudflare in front of Discord is limiting this host
        if ($global) $limits['global'] = max($limits['global'], $now + $retry);
        else $limits['buckets'][$bucket] = max($limits['buckets'][$bucket] ?? 0.0, $now + $retry);
        return ['result' => 'ratelimited', 'delay' => $retry, 'error' => 'rate limited' . ($global ? ' (global)' : '') . ' for ' . round($retry, 1) . ' s'];
    }
    if (in_array($status, [401, 403, 404], true)) return ['result' => 'broken', 'delay' => 0, 'error' => discord_error_text($status, $body)];
    if ($status === 0 || $status >= 500) {
        $error = discord_error_text($status, $body);
        if ($attempts + 1 >= DISCORD_MAX_ATTEMPTS) return ['result' => 'failed', 'delay' => 0, 'error' => 'gave up after ' . ($attempts + 1) . ' attempts: ' . $error];
        return ['result' => 'retry', 'delay' => discord_retry_delay($attempts), 'error' => $error];
    }
    return ['result' => 'failed', 'delay' => 0, 'error' => discord_error_text($status, $body)];
}

/** The message context of an outbox row, or null when it should wait for names a little longer */
function discord_row_context(PDO $db, array $row) {
    $data = json_decode($row['data'], true);
    if (!is_array($data)) return [];
    if (in_array($row['kind'], ['chainKill', 'corpKill', 'corpLoss'], true)) {
        $names = [];
        $pending = 0;
        if (function_exists('zk_names_lookup')) {
            [$names, $pending] = zk_names_lookup($db, discord_kill_name_ids($data));
        }
        if ($pending > 0 && (int) $row['age'] < DISCORD_NAMES_WAIT) return null;
        return discord_kill_context($data, $names);
    }
    return $data;
}

function discord_webhook_mark(PDO $db, $id, $status, $message) {
    if ($status === 'ok') {
        $db->prepare("UPDATE discord_webhooks SET status = 'ok', statusMessage = '', lastSentAt = UTC_TIMESTAMP() WHERE id = ?")->execute([$id]);
    } else {
        $db->prepare('UPDATE discord_webhooks SET status = ?, statusMessage = ?, lastErrorAt = UTC_TIMESTAMP() WHERE id = ?')
            ->execute([$status, substr((string) $message, 0, 255), $id]);
    }
}

/**
 * One dispatch pass: send due messages until $limit are handled or $budget seconds have passed.
 * @return array counts ['sent', 'retry', 'ratelimited', 'failed', 'broken', 'deferred']
 */
function discord_dispatch(PDO $db, $limit = 20, $budget = 5.0) {
    $started = microtime(true);
    $counts = ['sent' => 0, 'retry' => 0, 'ratelimited' => 0, 'failed' => 0, 'broken' => 0, 'deferred' => 0];
    $limits = &discord_limits();
    if ($limits['global'] > microtime(true)) return $counts;
    $rows = discord_outbox_due($db, $limit);
    if (!$rows) return $counts;
    $ids = array_values(array_unique(array_map(function ($r) { return (int) $r['webhookID']; }, $rows)));
    $stmt = $db->prepare('SELECT id, maskID, name, url, status FROM discord_webhooks WHERE id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')');
    $stmt->execute($ids);
    $webhooks = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $w) $webhooks[(int) $w['id']] = $w;

    foreach ($rows as $row) {
        if (microtime(true) - $started >= $budget) break;
        $webhook = $webhooks[(int) $row['webhookID']] ?? null;
        if (!$webhook || (string) $webhook['maskID'] !== (string) $row['maskID']) {
            discord_outbox_mark($db, $row['id'], 'failed', 'webhook was deleted');
            $counts['failed']++;
            continue;
        }
        if ($webhook['status'] === 'broken') {
            discord_outbox_mark($db, $row['id'], 'failed', 'webhook is broken');
            $counts['failed']++;
            continue;
        }
        $url = discord_unseal($webhook['url']);
        if ($url === null || !discord_webhook_parse($url)) {
            $reason = 'cannot read the stored URL (DISCORD_SECRET_KEY missing or changed): add the webhook URL again';
            discord_webhook_mark($db, $webhook['id'], 'broken', $reason);
            $webhooks[(int) $webhook['id']]['status'] = 'broken';
            $counts['failed'] += discord_outbox_fail_webhook($db, $webhook['id'], $reason);
            discord_log("webhook {$webhook['id']} broken: $reason");
            continue;
        }
        $bucket = discord_webhook_bucket_key($url);
        $wait = discord_wait($bucket);
        if ($limits['global'] > microtime(true)) break;
        if ($wait > 0) {   // this webhook is paused; try again when its bucket resets
            discord_outbox_mark($db, $row['id'], 'queued', 'waiting for the rate limit', $wait, false);
            $counts['deferred']++;
            continue;
        }
        $context = discord_row_context($db, $row);
        if ($context === null) {
            discord_outbox_mark($db, $row['id'], 'queued', 'waiting for names', 5, false);
            $counts['deferred']++;
            continue;
        }
        if (!$context) {
            discord_outbox_mark($db, $row['id'], 'failed', 'unreadable message data');
            $counts['failed']++;
            continue;
        }
        $spacing = DISCORD_SPACING - (microtime(true) - $limits['last']);
        if ($spacing > 0) usleep((int) ($spacing * 1e6));
        $limits['last'] = microtime(true);
        [$status, $body, $headers] = discord_http_post(discord_webhook_send_url($url), discord_payload($context));
        $decision = discord_handle_response($bucket, $status, $headers, $body, (int) $row['attempts']);
        switch ($decision['result']) {
            case 'sent':
                discord_outbox_mark($db, $row['id'], 'sent');
                discord_webhook_mark($db, $webhook['id'], 'ok', '');
                break;
            case 'ratelimited':
                discord_outbox_mark($db, $row['id'], 'queued', $decision['error'], $decision['delay'], false);
                discord_log("webhook {$webhook['id']}: {$decision['error']}");
                break;
            case 'retry':
                discord_outbox_mark($db, $row['id'], 'queued', $decision['error'], $decision['delay']);
                discord_log("message {$row['id']} to webhook {$webhook['id']}: {$decision['error']}, retrying in {$decision['delay']} s");
                break;
            case 'broken':
                discord_outbox_mark($db, $row['id'], 'failed', $decision['error']);
                discord_webhook_mark($db, $webhook['id'], 'broken', $decision['error']);
                $webhooks[(int) $webhook['id']]['status'] = 'broken';
                discord_outbox_fail_webhook($db, $webhook['id'], 'webhook is broken: ' . $decision['error']);
                discord_log("webhook {$webhook['id']} ({$webhook['name']}) marked broken: {$decision['error']}");
                break;
            default:
                discord_outbox_mark($db, $row['id'], 'failed', $decision['error']);
                discord_log("message {$row['id']} to webhook {$webhook['id']} failed: {$decision['error']}");
        }
        $counts[$decision['result']]++;
        if ($limits['global'] > microtime(true)) break;
    }
    return $counts;
}
