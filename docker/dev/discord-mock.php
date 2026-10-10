<?php
// Dev only: a fake Discord webhook API for the local stack (service `discord-mock` in docker-compose.dev.yml; the
// app container's DISCORD_API_BASE points at it). Never part of the image.
//
//   POST /api/webhooks/<id>/<token>   accepts a message like Discord. The webhook ID picks a behaviour:
//                                     ...0404 -> 404 Unknown Webhook (the webhook gets marked broken)
//                                     ...0401 -> 401 Invalid Webhook Token
//                                     ...0429 -> every other request 429 (retry_after 2 s, per webhook)
//                                     ...0430 -> every other request a global 429 (retry_after 3 s)
//                                     ...0500 -> 500 for the first 2 requests, then OK
//                                     anything else -> 200; X-RateLimit-* headers with a bucket of 5 per 2 s
//   GET  /messages                    the last 50 requests (JSON, newest first)
//   GET  /reset                       forget everything
//
//   php -S 0.0.0.0:8080 docker/dev/discord-mock.php

$dir = sys_get_temp_dir() . '/discord-mock';
@mkdir($dir, 0777, true);
$log = $dir . '/messages.jsonl';
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
header('Content-Type: application/json');

function mock_state($dir, $key, callable $update) {
    $file = $dir . '/state.json';
    $fp = fopen($file, 'c+');
    flock($fp, LOCK_EX);
    $state = json_decode(stream_get_contents($fp), true) ?: [];
    $result = $update($state[$key] ?? null);
    $state[$key] = $result[0];
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($state));
    flock($fp, LOCK_UN);
    fclose($fp);
    return $result[1];
}

if ($path === '/messages') {
    $lines = is_file($log) ? array_slice(file($log, FILE_IGNORE_NEW_LINES), -50) : [];
    echo json_encode(array_reverse(array_map('json_decode', $lines)), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return;
}
if ($path === '/reset') {
    @unlink($log);
    @unlink($dir . '/state.json');
    echo '{"reset":true}';
    return;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !preg_match('~^/api/webhooks/(\d+)/([A-Za-z0-9_-]+)$~', $path, $m)) {
    http_response_code(404);
    echo '{"message": "404: Not Found", "code": 0}';
    return;
}
$id = $m[1];
$body = json_decode(file_get_contents('php://input'), true);
$count = mock_state($dir, 'count:' . $id, function ($n) { $n = (int) $n + 1; return [$n, $n]; });

$status = 200;
$response = ['id' => (string) (time() * 1000 + $count), 'channel_id' => '1', 'content' => $body['content'] ?? ''];
$headers = [];
$suffix = substr($id, -4);
if ($suffix === '0404') { $status = 404; $response = ['message' => 'Unknown Webhook', 'code' => 10015]; }
elseif ($suffix === '0401') { $status = 401; $response = ['message' => 'Invalid Webhook Token', 'code' => 50027]; }
elseif ($suffix === '0429' && $count % 2 === 1) { $status = 429; $response = ['message' => 'You are being rate limited.', 'retry_after' => 2.0, 'global' => false]; $headers['Retry-After'] = '2'; $headers['X-RateLimit-Scope'] = 'user'; }
elseif ($suffix === '0430' && $count % 2 === 1) { $status = 429; $response = ['message' => 'You are being rate limited.', 'retry_after' => 3.0, 'global' => true]; $headers['X-RateLimit-Global'] = 'true'; $headers['X-RateLimit-Scope'] = 'global'; }
elseif ($suffix === '0500' && $count <= 2) { $status = 500; $response = ['message' => 'Internal Server Error', 'code' => 0]; }
elseif (!is_array($body) || (($body['content'] ?? '') === '' && empty($body['embeds']))) { $status = 400; $response = ['message' => 'Cannot send an empty message', 'code' => 50006]; }

// Bucket of 5 requests per 2 s per webhook
$remaining = mock_state($dir, 'bucket:' . $id, function ($b) {
    $now = microtime(true);
    if (!$b || $b['reset'] <= $now) $b = ['reset' => $now + 2, 'used' => 0];
    $b['used']++;
    return [$b, [max(0, 5 - $b['used']), max(0.0, $b['reset'] - $now)]];
});
$headers += ['X-RateLimit-Limit' => '5', 'X-RateLimit-Remaining' => (string) $remaining[0],
    'X-RateLimit-Reset-After' => number_format($remaining[1], 3, '.', ''), 'X-RateLimit-Bucket' => 'mock-' . $id];

file_put_contents($log, json_encode(['at' => gmdate('Y-m-d H:i:s'), 'webhook' => $id, 'status' => $status, 'query' => $_SERVER['QUERY_STRING'] ?? '',
    'userAgent' => $_SERVER['HTTP_USER_AGENT'] ?? '', 'body' => $body], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);
http_response_code($status);
foreach ($headers as $name => $value) header("$name: $value");
echo json_encode($response);
