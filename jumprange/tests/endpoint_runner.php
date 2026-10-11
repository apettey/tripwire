<?php
// Fork-owned test helper: runs public/jump_jammed.php once with a fake request and session, for
// jumprange/tests/jammed_endpoint_test.php. Reads JSON {method, get, post, session, headers} from stdin.
// Prints the response body; the HTTP status goes to stderr as "STATUS <code>".
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

$request = json_decode(stream_get_contents(STDIN), true);
$_SERVER['REQUEST_METHOD'] = $request['method'];
$_GET = $request['get'] ?? [];
$_POST = $request['post'] ?? [];
foreach (($request['headers'] ?? []) as $name => $value) {
    $_SERVER['HTTP_' . strtoupper(str_replace('-', '_', $name))] = $value;
}
// A session id without starting a session: the endpoint skips session_start() and uses this $_SESSION
session_id('jump-jammed-endpoint-test');
$_SESSION = $request['session'] ?? [];

register_shutdown_function(function () {
    fwrite(STDERR, 'STATUS ' . (http_response_code() ?: 200) . "\n");
});
chdir(__DIR__ . '/../../public');
include __DIR__ . '/../../public/jump_jammed.php';
