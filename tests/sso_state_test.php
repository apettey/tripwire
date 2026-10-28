<?php
// Fork-owned: tests for sso-state.inc.php (per-session EVE SSO state). No database needed.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/sso_state_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../sso-state.inc.php');

$failures = 0;
$count = 0;
function check($name, $ok, $detail = '') {
	global $failures, $count;
	$count++;
	if (!$ok) { $failures++; fwrite(STDERR, "FAIL $name  $detail\n"); }
}

$_SESSION = array();
$state = fork_sso_state_new('evessologin');
check('state is purpose.nonce', (bool) preg_match('/^evessologin\.[0-9a-f]{32}$/', $state), $state);
check('purpose for routing', fork_sso_state_purpose($state) === 'evessologin');
check('old fixed state routes the same', fork_sso_state_purpose('evessoesi') === 'evessoesi');
check('valid state gives the purpose', fork_sso_state_check($state) === 'evessologin');
check('state is single use', fork_sso_state_check($state) === null);

$a = fork_sso_state_new('evessologin');
$b = fork_sso_state_new('evessoesi');
check('purposes keep their own nonce', fork_sso_state_check($b) === 'evessoesi' && fork_sso_state_check($a) === 'evessologin');

$mine = fork_sso_state_new('evessologin');
check('fixed upstream state is refused', fork_sso_state_check('evessologin') === null);
check('other session\'s nonce is refused', fork_sso_state_check('evessologin.' . str_repeat('a', 32)) === null);
check('nonce for another purpose is refused', fork_sso_state_check('evessoesi.' . substr($mine, strlen('evessologin.'))) === null);
check('non-string is refused', fork_sso_state_check(array('x')) === null && fork_sso_state_check(null) === null);
check('refusals keep the real nonce', fork_sso_state_check($mine) === 'evessologin');

$_SESSION = array();
check('empty session refuses', fork_sso_state_check(fork_sso_state_purpose($mine) . '.' . str_repeat('0', 32)) === null);

echo ($failures ? "FAILED $failures of $count\n" : "OK $count checks\n");
exit($failures ? 1 : 0);
