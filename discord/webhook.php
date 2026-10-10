<?php
// Fork-owned: Discord webhook URLs (see discord/discord.inc.php).

const DISCORD_API_BASE_DEFAULT = 'https://discord.com/api';
const DISCORD_API_BASE_HOSTS   = ['localhost', '::1', 'discord-mock'];   // DISCORD_API_BASE hosts besides 127.0.0.0/8
const DISCORD_WEBHOOK_PATTERN  = '~^https://(?:(?:canary|ptb)\.)?discord(?:app)?\.com/api(?:/v(\d{1,2}))?/webhooks/(\d{17,21})/([A-Za-z0-9_-]{30,120})/?(?:\?thread_id=(\d{17,21}))?$~';

/**
 * Validate a webhook URL as pasted from Discord (discord.com or discordapp.com, canary/ptb, optional /v10, optional
 * ?thread_id=). @return array|null ['id', 'token', 'threadID', 'url' (normalised: https://discord.com/api/webhooks/...)]
 */
function discord_webhook_parse($url) {
    if (!is_string($url)) return null;
    $url = trim($url);
    if (strlen($url) > 300 || !preg_match(DISCORD_WEBHOOK_PATTERN, $url, $m)) return null;
    $thread = isset($m[4]) && $m[4] !== '' ? $m[4] : null;
    return [
        'id'       => $m[2],
        'token'    => $m[3],
        'threadID' => $thread,
        'url'      => 'https://discord.com/api/webhooks/' . $m[2] . '/' . $m[3] . ($thread ? '?thread_id=' . $thread : ''),
    ];
}

/** What the UI shows instead of the URL: '…/' + the last 4 digits of the webhook ID */
function discord_webhook_hint($url) {
    $parsed = discord_webhook_parse($url);
    return $parsed ? '…/' . substr($parsed['id'], -4) : '…';
}

/**
 * Base URL requests go to: https://discord.com/api, or DISCORD_API_BASE for a local fake in development. The
 * override is only honoured for localhost, 127.0.0.0/8, ::1 and the dev stack's fake ('discord-mock'), so a
 * misconfiguration can never send webhook secrets to another host.
 */
function discord_api_base($override = null) {
    $base = rtrim($override !== null ? $override : discord_config('DISCORD_API_BASE'), '/');
    if ($base === '') return DISCORD_API_BASE_DEFAULT;
    $parts = parse_url($base);
    $host = strtolower(trim((string) ($parts['host'] ?? ''), '[]'));
    $scheme = strtolower((string) ($parts['scheme'] ?? ''));
    $local = in_array($host, DISCORD_API_BASE_HOSTS, true)
        || (preg_match('/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/', $host, $ip) && max($ip[1], $ip[2], $ip[3]) <= 255);
    if (!in_array($scheme, ['http', 'https'], true) || !$local || isset($parts['query']) || isset($parts['user'])) {
        return DISCORD_API_BASE_DEFAULT;
    }
    return $base;
}

/** The URL a message for this webhook is POSTed to (wait=true: Discord answers with the message, errors as JSON) */
function discord_webhook_send_url($url, $base = null) {
    $parsed = discord_webhook_parse($url);
    if (!$parsed) return null;
    $base = $base !== null ? $base : discord_api_base();
    return $base . '/webhooks/' . $parsed['id'] . '/' . $parsed['token'] . '?wait=true'
        . ($parsed['threadID'] ? '&thread_id=' . $parsed['threadID'] : '');
}

/** Rate-limit key of a webhook: Discord limits per webhook (route + webhook ID) */
function discord_webhook_bucket_key($url) {
    $parsed = discord_webhook_parse($url);
    return $parsed ? 'webhook:' . $parsed['id'] : 'webhook:?';
}

/** The URL a message of this webhook is edited at (PATCH; rally messages, discord/rally.php) */
function discord_webhook_edit_url($url, $messageID, $base = null) {
    $parsed = discord_webhook_parse($url);
    if (!$parsed || !preg_match('/^\d{1,32}$/', (string) $messageID)) return null;
    $base = $base !== null ? $base : discord_api_base();
    return $base . '/webhooks/' . $parsed['id'] . '/' . $parsed['token'] . '/messages/' . $messageID
        . ($parsed['threadID'] ? '?thread_id=' . $parsed['threadID'] : '');
}
