<?php
// Fork-owned: authentication of public/api.php, in place of upstream's api/auth.php (public/api.php requires this file instead).
//
//   Authorization: Bearer twp_...  -> a personal access token (api/tokens.inc.php): read-only, bound to one mask. It serves
//                                     /api/v1/... (api/v1.inc.php) and the old read endpoints signatures, wormholes and comments for
//                                     its mask ($maskID is set for them); the old "statistics" endpoint is not available to tokens.
//   anything else                  -> upstream's HTTP Basic auth with the account name and password (api/auth.php), unless
//                                     TRIPWIRE_API_PASSWORD_AUTH is off. /api/v1 never accepts passwords.
//
// Included at the top level of public/api.php: it ends the request itself for errors and for /api/v1, and otherwise leaves $maskID
// for the old endpoints below it.

require_once(__DIR__ . '/tokens.inc.php');

function api_fail($status, $message, array $headers = []) {
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    foreach ($headers as $h) header($h);
    echo json_encode(['error' => $message]);
    exit();
}

$twBearer = api_token_bearer($_SERVER);
$twPath = explode('/', isset($_GET['q']) && is_string($_GET['q']) ? $_GET['q'] : '');   // "/v1/chain" -> ['', 'v1', 'chain']

if ($twBearer === null) {
    if (isset($twPath[1]) && $twPath[1] === 'v1') {
        api_fail(401, 'Authentication required: send Authorization: Bearer <token>', ['WWW-Authenticate: Bearer realm="Tripwire"']);
    }
    if (!api_password_auth_enabled()) {
        api_fail(401, 'Password authentication is turned off on this server: use a personal access token (Settings > General > API tokens)', ['WWW-Authenticate: Bearer realm="Tripwire"']);
    }
    require(__DIR__ . '/auth.php');   // upstream: HTTP Basic with the account's password
} else {
    if (!isset($mysql) || !($mysql instanceof PDO)) api_fail(503, 'Database unavailable');
    try {
        $twAuth = api_token_authenticate($mysql, $_SERVER, $_GET, time());
    } catch (PDOException $e) {
        error_log('api token auth: ' . $e->getMessage());
        api_fail(500, 'Database error');
    }
    if ($twAuth['status'] !== 200) api_fail($twAuth['status'], $twAuth['error'], $twAuth['headers']);
    foreach ($twAuth['headers'] as $h) header($h);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    $maskID = $twAuth['mask'];   // for the old endpoints (api/signatures, wormholes, comments)

    if (isset($twPath[1]) && $twPath[1] === 'v1') {
        require_once(__DIR__ . '/v1.inc.php');
        try {
            [$twStatus, $twPayload] = api_v1_route($mysql, $twAuth, array_slice($twPath, 2), $_GET, time());
        } catch (PDOException $e) {
            error_log('api v1: ' . $e->getMessage());
            api_fail(500, 'Database error');
        }
        http_response_code($twStatus);
        header('Content-Type: application/json');
        echo json_encode($twPayload, JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES);
        exit();
    }
    if (!isset($twPath[1]) || !in_array($twPath[1], ['signatures', 'wormholes', 'comments'], true)) {
        api_fail(404, 'Not found');
    }
}
