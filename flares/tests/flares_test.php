<?php
// Fork-owned: tests for flares/flares.inc.php and public/flares.php (flare reason and lifetime), against the dev stack
// (its MySQL, nginx/PHP in the app container and the dev login from docker/dev-seed.sh).
//   docker compose -f docker-compose.dev.yml exec -T app php flares/tests/flares_test.php
// 1. Pure: reason cleaning, the length cap, lifetimes, colours, system IDs.
// 2. Schema: an older flares table (no lifeLength / reason, the 24 hour flaresClean event) gets its columns and the
//    per-flare event from flares_ensure_schema; the event's DELETE removes only flares whose own lifetime is over.
// 3. Storage: set / replace / remove and the list are per mask; expired flares are left out of the list.
// 4. public/flares.php over HTTP: CSRF, validation (400), reason cap, lifetimes, scoped to the session's mask.
// The flares table is snapshotted first and put back when it ends; its own test masks are removed.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../flares.inc.php');

$failures = 0;
$count = 0;
function check($name, $actual, $expected) {
	global $failures, $count;
	$count++;
	if ($actual !== $expected) {
		$failures++;
		fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
	}
}

// --- 1. Pure ---
check('reason one line', flares_clean_reason("  Loki\tgang \n on the  null "), 'Loki gang on the null');
check('reason zero-width / bidi removed', flares_clean_reason("a\u{200B}b\u{202E}c"), 'abc');
check('reason html kept as text', flares_clean_reason('<b>x</b>'), '<b>x</b>');
check('reason not a string', flares_clean_reason(['x']), '');

$ok = function($in) { return flares_parse_set($in); };
check('set: defaults to 1 day, no reason', $ok(['systemID' => '31000880', 'flare' => 'red']),
	[['systemID' => 31000880, 'flare' => 'red', 'lifeLength' => 86400, 'reason' => null, 'restart' => false], null]);
check('set: forever + reason', $ok(['systemID' => '31000880', 'flare' => 'green', 'lifeLength' => 'forever', 'reason' => ' op  here ']),
	[['systemID' => 31000880, 'flare' => 'green', 'lifeLength' => null, 'reason' => 'op here', 'restart' => false], null]);
check('set: 86400 explicit', $ok(['systemID' => '1', 'flare' => 'yellow', 'lifeLength' => '86400'])[0]['lifeLength'], 86400);
check('set: empty reason is no reason', $ok(['systemID' => '1', 'flare' => 'red', 'reason' => "  \n "])[0]['reason'], null);
check('set: reason of 200 characters', mb_strlen($ok(['systemID' => '1', 'flare' => 'red', 'reason' => str_repeat('é', 200)])[0]['reason']), 200);
check('set: reason of 201 characters refused', $ok(['systemID' => '1', 'flare' => 'red', 'reason' => str_repeat('é', 201)]), [null, 'The reason can be at most 200 characters']);
check('set: other lifetime refused', $ok(['systemID' => '1', 'flare' => 'red', 'lifeLength' => '3600'])[1], 'Invalid flare lifetime');
check('set: lifetime 0 refused', $ok(['systemID' => '1', 'flare' => 'red', 'lifeLength' => '0'])[1], 'Invalid flare lifetime');
check('set: lifetime array refused', $ok(['systemID' => '1', 'flare' => 'red', 'lifeLength' => ['x']])[1], 'Invalid flare lifetime');
check('set: colour refused', $ok(['systemID' => '1', 'flare' => 'blue'])[1], 'Invalid flare colour');
check('set: colour missing', $ok(['systemID' => '1'])[1], 'Invalid flare colour');
check('set: system refused', $ok(['systemID' => '1 OR 1=1', 'flare' => 'red'])[1], 'Invalid system');
check('set: system 0 refused', $ok(['systemID' => '0', 'flare' => 'red'])[1], 'Invalid system');
check('set: system too big', $ok(['systemID' => '99999999999', 'flare' => 'red'])[1], 'Invalid system');

// --- Database ---
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$maskA = '999990021.0';
$maskB = '999990022.0';

// Snapshot of the table (columns as they are now), put back at the end
$columnsBefore = $db->query('SHOW COLUMNS FROM flares')->fetchAll(PDO::FETCH_COLUMN);
$snapshot = $db->query('SELECT * FROM flares')->fetchAll(PDO::FETCH_ASSOC);
$eventBefore = $db->query("SELECT EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'flaresClean'")->fetchColumn();

function restore() {
	global $db, $snapshot, $maskA, $maskB;
	flares_ensure_schema($db);
	$db->exec('DELETE FROM flares');
	foreach ($snapshot as $row) {
		$cols = array_keys($row);
		$stmt = $db->prepare('INSERT INTO flares (`' . implode('`, `', $cols) . '`) VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')');
		$stmt->execute(array_values($row));
	}
}
register_shutdown_function('restore');

function columns($db) { return array_map('strtolower', $db->query('SHOW COLUMNS FROM flares')->fetchAll(PDO::FETCH_COLUMN)); }
function eventDefinition($db) { return (string) $db->query("SELECT EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'flaresClean'")->fetchColumn(); }

// --- 2. Schema: make the table and event what upstream 1.x had, then let ensure_schema bring them up to date ---
$db->exec('DELETE FROM flares WHERE maskID IN (' . $db->quote($maskA) . ', ' . $db->quote($maskB) . ')');
foreach (['lifeLength', 'reason'] as $c) {
	if (in_array(strtolower($c), columns($db), true)) $db->exec("ALTER TABLE flares DROP COLUMN `$c`");
}
$db->exec('DROP EVENT IF EXISTS `flaresClean`');
$db->exec('CREATE EVENT `flaresClean` ON SCHEDULE EVERY 1 HOUR STARTS CURRENT_TIMESTAMP ON COMPLETION NOT PRESERVE ENABLE DO DELETE FROM flares WHERE time < NOW() - INTERVAL 24 HOUR');
$db->prepare("INSERT INTO flares (maskID, systemID, flare, `time`) VALUES (?, 31000001, 'red', NOW() - INTERVAL 2 HOUR)")->execute([$maskA]);

// Without the columns (when they cannot be added): the legacy list, 1 day each, no reason
$legacy = flares_list_legacy($db, $maskA);
check('legacy list on the old table', [count($legacy), $legacy[0]->systemID, $legacy[0]->lifeLength, $legacy[0]->reason, is_int($legacy[0]->setAt)], [1, 31000001, 86400, null, true]);

// The refresh list on the old table: the legacy list, and it never changes the schema
$list = flares_list_for_refresh($db, $maskA);
check('refresh on the old table: legacy list', [count($list), $list[0]->lifeLength, $list[0]->reason], [1, 86400, null]);
check('refresh on the old table: no columns added', array_values(array_intersect(['lifelength', 'reason'], columns($db))), []);

// A PDO whose ALTER / CREATE EVENT / ALTER EVENT / DROP EVENT are refused (an app user without ALTER and EVENT), and
// that counts the statements it is given
class DeniedException extends PDOException {
	public function __construct($sql) { parent::__construct('SQLSTATE[42000]: command denied: ' . $sql); $this->code = '42000'; }
}
class TestPDO extends PDO {
	public $deny = false;
	public $statements = 0;
	public function exec(string $statement): int|false {
		$this->statements++;
		if ($this->deny && preg_match('/^\s*(ALTER|CREATE EVENT|DROP EVENT)/i', $statement)) throw new DeniedException($statement);
		return parent::exec($statement);
	}
	public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false {
		$this->statements++;
		return $fetchMode === null ? parent::query($query) : parent::query($query, $fetchMode, ...$fetchModeArgs);
	}
}
$tdb = new TestPDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$tdb->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$state = sys_get_temp_dir() . '/flares-schema-test.json';
@unlink($state);
$now = time();

// Without the privileges: nothing changes, the failure is recorded, nothing is dropped, and no retry within the cooldown
$tdb->deny = true;
check('denied: columns not there', flares_ensure_schema_once($tdb, false, $state, $now), false);
$saved = json_decode((string) file_get_contents($state), true);
check('denied: recorded', [$saved['columns'], $saved['event'], $saved['failedAt']], [false, false, $now]);
check('denied: old event still there (not dropped)', stripos(eventDefinition($db), '24 HOUR') !== false, true);
$tdb->statements = 0;
check('denied, within the cooldown: not tried', [flares_ensure_schema_once($tdb, false, $state, $now + 60), flares_ensure_schema_once($tdb, true, $state, $now + 60), $tdb->statements], [false, false, 2]);	// only the identity query each time
check('denied, after the cooldown: tried again', [flares_ensure_schema_once($tdb, false, $state, $now + FLARES_SCHEMA_COOLDOWN + 1), $tdb->statements > 3], [false, true]);

// With them: columns added, the event changed in place, recorded as done; then only the identity query
$tdb->deny = false;
check('allowed after the cooldown: columns added', flares_ensure_schema_once($tdb, false, $state, $now + 2 * FLARES_SCHEMA_COOLDOWN + 2), true);
check('old table: columns added', array_values(array_intersect(['lifelength', 'reason'], columns($db))), ['lifelength', 'reason']);
check('old table: event uses the lifetime', stripos(eventDefinition($db), 'lifeLength') !== false, true);
check('event is enabled', $db->query("SELECT STATUS FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'flaresClean'")->fetchColumn(), 'ENABLED');
$saved = json_decode((string) file_get_contents($state), true);
check('done: recorded', [$saved['version'], $saved['columns'], $saved['event'], $saved['failedAt']], [FLARES_SCHEMA_VERSION, true, true, null]);
$tdb->statements = 0;
check('done: only the identity query afterwards', [flares_ensure_schema_once($tdb, false, $state), $tdb->statements], [true, 1]);
$identity = flares_db_identity($db);
check('identity: recorded, names this database', [$saved['db'] === $identity, strpos($identity, '|' . getenv('DB_NAME') . '|') !== false], [true, true]);
// A restore / move (the state file survives redeploys): the dump re-creates the table, its events are often lost or old.
// Simulated by re-creating `flares` (a new CREATE_TIME) and putting the 24 hour event back: ensure runs again.
$db->exec("ALTER EVENT `flaresClean` DO DELETE FROM flares WHERE time < NOW() - INTERVAL 24 HOUR");
sleep(1);	// CREATE_TIME has a resolution of a second
$db->exec('DROP TABLE IF EXISTS flares_test_old');
$db->exec('CREATE TABLE flares_test_new LIKE flares');
$db->exec('INSERT INTO flares_test_new SELECT * FROM flares');
$db->exec('RENAME TABLE flares TO flares_test_old, flares_test_new TO flares');
$db->exec('DROP TABLE flares_test_old');
check('restore: another identity', flares_db_identity($db) !== $identity, true);
check('restore: runs again and fixes the event', [flares_ensure_schema_once($db, false, $state), stripos(eventDefinition($db), 'lifeLength') !== false], [true, true]);
check('restore: new identity recorded', json_decode((string) file_get_contents($state), true)['db'], flares_db_identity($db));
// A state file from another database (or none readable) never counts as done
file_put_contents($state, json_encode(['version' => FLARES_SCHEMA_VERSION, 'db' => 'another|database|2020-01-01', 'columns' => true, 'event' => true, 'failedAt' => null]));
$db->exec("ALTER EVENT `flaresClean` DO DELETE FROM flares WHERE time < NOW() - INTERVAL 24 HOUR");
check('state of another database: runs again', [flares_ensure_schema_once($db, false, $state), stripos(eventDefinition($db), 'lifeLength') !== false], [true, true]);
$list = flares_list($db, $maskA);
check('old table: a flare from before keeps 1 day', [count($list), $list[0]->lifeLength, property_exists($list[0], 'reason') ? $list[0]->reason : 'none'], [1, 86400, null]);
check('ensure again: columns once, no error', [flares_ensure_schema($db)['errors'], count(array_keys(columns($db), 'reason'))], [[], 1]);
// A missing event is created
$db->exec('DROP EVENT IF EXISTS `flaresClean`');
check('missing event: created', [flares_ensure_schema($db)['event'], stripos(eventDefinition($db), 'lifeLength') !== false], [true, true]);
// A database replaced after the state said done: forced once a query finds a column missing (flares_set_with_schema)
$db->exec('ALTER TABLE flares DROP COLUMN `reason`');
check('forced: columns back', [flares_ensure_schema_once($db, true, $state), in_array('reason', columns($db), true)], [true, true]);
@unlink($state);

// The event's DELETE: only flares whose own lifetime is over
$db->exec('DELETE FROM flares WHERE maskID IN (' . $db->quote($maskA) . ', ' . $db->quote($maskB) . ')');
$ins = $db->prepare('INSERT INTO flares (maskID, systemID, flare, `time`, lifeLength, reason) VALUES (?, ?, ?, NOW() - INTERVAL ? SECOND, ?, ?)');
$ins->execute([$maskA, 31000001, 'red', 2 * 86400, 86400, 'old day']);		// over
$ins->execute([$maskA, 31000002, 'red', 3600, 86400, 'fresh day']);			// 23 h left
$ins->execute([$maskA, 31000003, 'green', 30 * 86400, null, 'forever']);	// until removed
$ins->execute([$maskB, 31000001, 'yellow', 3600, 86400, 'other mask']);
$list = flares_list($db, $maskA);
check('list leaves out an expired flare before the event runs', array_map(function($f) { return $f->systemID; }, $list), [31000002, 31000003]);
check('list: types', [$list[0]->systemID, $list[0]->lifeLength, $list[1]->lifeLength, is_int($list[0]->setAt)], [31000002, 86400, null, true]);
check('list: setAt is the set time', abs($list[0]->setAt - (time() - 3600)) <= 5, true);
$db->exec(FLARES_CLEAN_SQL);
$left = $db->query('SELECT systemID FROM flares WHERE maskID = ' . $db->quote($maskA) . ' ORDER BY systemID')->fetchAll(PDO::FETCH_COLUMN);
check('clean event: deletes the expired flare only', array_map('intval', $left), [31000002, 31000003]);

// --- 3. Storage per mask ---
function setAtOf($db, $mask, $systemID) {
	foreach (flares_list($db, $mask) as $f) if ($f->systemID === $systemID) return $f->setAt;
	return null;
}
// 31000002 was set an hour ago: a re-colour (no restart) keeps that time
flares_set($db, $maskA, ['systemID' => 31000002, 'flare' => 'yellow', 'lifeLength' => 86400, 'reason' => 'fresh day']);
check('re-colour keeps the time it was set', [abs(setAtOf($db, $maskA, 31000002) - (time() - 3600)) <= 5, flares_list($db, $maskA)[0]->flare ?? null], [true, 'yellow']);
// the dialog (restart) starts it again
flares_set($db, $maskA, ['systemID' => 31000002, 'flare' => 'green', 'lifeLength' => null, 'reason' => 'staging', 'restart' => true]);
$list = flares_list($db, $maskA);
check('set again in the dialog replaces (one row) and restarts the clock', [count($list), $list[0]->systemID, $list[0]->flare, $list[0]->lifeLength, $list[0]->reason, abs($list[0]->setAt - time()) <= 5],
	[2, 31000002, 'green', null, 'staging', true]);
// a re-colour of a flare whose lifetime is over (not deleted yet) is a new flare
$ins->execute([$maskA, 31000009, 'red', 2 * 86400, 86400, null]);
flares_set($db, $maskA, ['systemID' => 31000009, 'flare' => 'green', 'lifeLength' => 86400, 'reason' => null]);
check('re-colour of an expired flare starts it again', abs((int) setAtOf($db, $maskA, 31000009) - time()) <= 5, true);
flares_remove($db, $maskA, 31000009);
check('other mask untouched by a set', flares_list($db, $maskB)[0]->reason, 'other mask');
flares_remove($db, $maskB, 31000002);
check('remove on another mask leaves this one', count(flares_list($db, $maskA)), 2);
flares_remove($db, $maskA, 31000002);
check('remove', array_map(function($f) { return $f->systemID; }, flares_list($db, $maskA)), [31000003]);
check('unicode reason stored', (function() use ($db, $maskA) {
	flares_set($db, $maskA, ['systemID' => 31000004, 'flare' => 'red', 'lifeLength' => 86400, 'reason' => str_repeat('é', 200)]);
	return mb_strlen(flares_find_reason($db, $maskA, 31000004));
})(), 200);
function flares_find_reason($db, $mask, $systemID) {
	foreach (flares_list($db, $mask) as $f) if ($f->systemID === $systemID) return $f->reason;
	return null;
}

// --- 4. public/flares.php over HTTP ---
$base = getenv('FLARES_BASE') ?: 'http://127.0.0.1';
$user = getenv('DEV_USERNAME') ?: 'dev';
$password = getenv('DEV_PASSWORD') ?: 'dev-password';
function http($method, $path, $jar, $body = null, array $headers = []) {
	global $base;
	$ch = curl_init($base . '/' . ltrim($path, '/'));
	curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar,
		CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20]);
	if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
	$text = curl_exec($ch);
	return [curl_getinfo($ch, CURLINFO_RESPONSE_CODE), json_decode((string) $text, true), (string) $text];
}
$jar = sys_get_temp_dir() . '/flares-test.cookies';
@unlink($jar);
[, $out] = http('POST', 'login.php', $jar, http_build_query(['mode' => 'login', 'username' => $user, 'password' => $password]));
if (($out['result'] ?? '') !== 'success') { fwrite(STDERR, "login failed (run docker/dev-seed.sh first)\n"); exit(1); }
[, , $page] = http('GET', '?system=Jita', $jar);
preg_match('/<meta name="csrf-token" content="([0-9a-f]+)"/', $page, $m);
$csrf = $m[1] ?? '';
check('page has a CSRF token', strlen($csrf), 64);
$stmt = $db->prepare('SELECT c.corporationID FROM accounts a INNER JOIN characters c ON c.userID = a.id WHERE a.username = ?');
$stmt->execute([$user]);
$myMask = $stmt->fetchColumn() . '.2';	// the dev login's session mask (its corporation mask)
$sys = 31000005;
$db->prepare('DELETE FROM flares WHERE systemID = ? AND maskID IN (?, ?)')->execute([$sys, $myMask, $maskB]);
$db->prepare("INSERT INTO flares (maskID, systemID, flare, lifeLength, reason) VALUES (?, ?, 'yellow', 86400, 'other mask')")->execute([$maskB, $sys]);
function post($body, $token) {
	global $jar;
	return http('POST', 'flares.php', $jar, http_build_query($body), $token === null ? [] : ['X-CSRF-Token: ' . $token]);
}
function mine($db, $mask, $sys) {
	$stmt = $db->prepare('SELECT flare, lifeLength, reason FROM flares WHERE maskID = ? AND systemID = ?');
	$stmt->execute([$mask, $sys]);
	return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

// On an old table (and no state file): refresh and remove work without touching the schema, the first set migrates it
$appState = flares_schema_state_file();
@unlink($appState);
$db->exec('ALTER TABLE flares DROP COLUMN `reason`, DROP COLUMN `lifeLength`');
$db->prepare("INSERT INTO flares (maskID, systemID, flare) VALUES (?, ?, 'red')")->execute([$myMask, $sys]);
[$status, $out] = http('POST', 'refresh.php', $jar, http_build_query(['mode' => 'refresh', 'systemID' => 30000142]), ['X-CSRF-Token: ' . $csrf]);
$sent = array_values(array_filter($out['flares']['flares'] ?? [], function($f) use ($sys) { return (int) $f['systemID'] === $sys; }));
check('old table: refresh sends the legacy list', [$status, count($sent), $sent[0]['lifeLength'] ?? null], [200, 1, 86400]);
[$status, $out] = post(['systemID' => $sys], $csrf);
check('old table: remove works and migrates nothing', [$status, $out['result'] ?? null, in_array('reason', columns($db), true), is_file($appState)], [200, true, false, false]);
[$status, $out] = post(['systemID' => $sys, 'flare' => 'red', 'reason' => 'first'], $csrf);
check('old table: the first set migrates it and is stored', [$status, $out['result'] ?? null, mine($db, $myMask, $sys)], [200, true, ['flare' => 'red', 'lifeLength' => 86400, 'reason' => 'first']]);
$db->prepare('DELETE FROM flares WHERE maskID = ? AND systemID = ?')->execute([$myMask, $sys]);
$db->prepare("UPDATE flares SET reason = 'other mask' WHERE maskID = ? AND systemID = ?")->execute([$maskB, $sys]);	// lost with the column

check('no CSRF token: 403', post(['systemID' => $sys, 'flare' => 'red'], null)[0], 403);
check('wrong CSRF token: 403', post(['systemID' => $sys, 'flare' => 'red'], str_repeat('0', 64))[0], 403);
check('no CSRF: nothing stored', mine($db, $myMask, $sys), null);
[$status, $out] = post(['systemID' => $sys, 'flare' => 'red', 'lifeLength' => 'forever', 'reason' => '<script>x</script> camp'], $csrf);
check('set forever with reason: 200', [$status, $out['result'] ?? null], [200, true]);
check('stored as text, in my mask', mine($db, $myMask, $sys), ['flare' => 'red', 'lifeLength' => null, 'reason' => '<script>x</script> camp']);
check('other mask untouched', mine($db, $maskB, $sys)['reason'], 'other mask');
[$status, $out] = post(['systemID' => $sys, 'flare' => 'yellow', 'lifeLength' => 'forever', 'reason' => '<script>x</script> camp'], $csrf);
check('re-colour keeping lifetime and reason', [$status, mine($db, $myMask, $sys)], [200, ['flare' => 'yellow', 'lifeLength' => null, 'reason' => '<script>x</script> camp']]);
[$status] = post(['systemID' => $sys, 'flare' => 'green'], $csrf);
check('no lifetime / reason fields: 1 day, no reason', [$status, mine($db, $myMask, $sys)], [200, ['flare' => 'green', 'lifeLength' => 86400, 'reason' => null]]);
$db->prepare('UPDATE flares SET `time` = NOW() - INTERVAL 2 HOUR WHERE maskID = ? AND systemID = ?')->execute([$myMask, $sys]);
post(['systemID' => $sys, 'flare' => 'yellow'], $csrf);
check('re-colour over HTTP keeps the time', abs((int) setAtOf($db, $myMask, $sys) - (time() - 7200)) <= 5, true);
post(['systemID' => $sys, 'flare' => 'green', 'restart' => '1'], $csrf);
check('restart=1 (the dialog) starts it again', abs((int) setAtOf($db, $myMask, $sys) - time()) <= 5, true);
[$status, $out] = post(['systemID' => $sys, 'flare' => 'red', 'reason' => str_repeat('a', 201)], $csrf);
check('reason over 200 characters: 400', [$status, $out['error'] ?? null], [400, 'The reason can be at most 200 characters']);
check('refused set changes nothing', mine($db, $myMask, $sys)['flare'], 'green');
check('lifetime 3600: 400', post(['systemID' => $sys, 'flare' => 'red', 'lifeLength' => '3600'], $csrf)[0], 400);
check('colour blue: 400', post(['systemID' => $sys, 'flare' => 'blue'], $csrf)[0], 400);
check('bad system: 400', post(['systemID' => 'x', 'flare' => 'red'], $csrf)[0], 400);
check('remove with a bad system: 400', post(['systemID' => '-1'], $csrf)[0], 400);
// refresh.php sends the reason and lifetime back to the page
[, $out] = http('POST', 'refresh.php', $jar, http_build_query(['mode' => 'refresh', 'systemID' => 30000142]), ['X-CSRF-Token: ' . $csrf]);
$sent = array_values(array_filter($out['flares']['flares'] ?? [], function($f) use ($sys) { return (int) $f['systemID'] === $sys; }));
check('refresh.php sends the flare with lifetime and reason', [count($sent), $sent[0]['flare'] ?? null, $sent[0]['lifeLength'] ?? 'missing', array_key_exists('reason', $sent[0] ?? []), is_int($sent[0]['setAt'] ?? null)],
	[1, 'green', 86400, true, true]);
check('refresh.php sends no other mask\'s flare', count(array_filter($out['flares']['flares'] ?? [], function($f) { return ($f['reason'] ?? '') === 'other mask'; })), 0);
[$status, $out] = post(['systemID' => $sys], $csrf);
check('remove: 200', [$status, $out['result'] ?? null], [200, true]);
check('removed in my mask only', [mine($db, $myMask, $sys), mine($db, $maskB, $sys)['reason']], [null, 'other mask']);

$db->exec('DELETE FROM flares WHERE maskID IN (' . $db->quote($maskA) . ', ' . $db->quote($maskB) . ')');
@unlink($jar);
echo "$count checks, $failures failed\n";
exit($failures ? 1 : 0);
