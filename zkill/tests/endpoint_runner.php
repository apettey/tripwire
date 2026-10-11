<?php
// Fork-owned test helper: runs one public/ endpoint once with a fake request and session, for the endpoint tests in
// zkill/tests/. Reads JSON {script, method, get, session} from stdin. Prints the response body; the HTTP status goes
// to stderr as "STATUS <code>".
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

$request = json_decode(stream_get_contents(STDIN), true);
$script = basename((string) ($request['script'] ?? ''));
if (!preg_match('/^[a-z_]+\.php$/', $script) || !is_file(__DIR__ . '/../../public/' . $script)) { fwrite(STDERR, "bad script\n"); exit(1); }
$_SERVER['REQUEST_METHOD'] = $request['method'];
$_GET = $request['get'] ?? [];
$_POST = [];
// A session id without starting a session: the endpoint skips session_start() and uses this $_SESSION
session_id('zkill-endpoint-test');
$_SESSION = $request['session'] ?? [];

register_shutdown_function(function () {
    fwrite(STDERR, 'STATUS ' . (http_response_code() ?: 200) . "\n");
});
chdir(__DIR__ . '/../../public');
include __DIR__ . '/../../public/' . $script;
