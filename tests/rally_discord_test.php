<?php
// Fork-owned: tests for the pure parts of rally_discord.inc.php (no network; SQLite stands in for MySQL in the
// routing checks).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/rally_discord_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../discord/discord.inc.php');
require_once(__DIR__ . '/../rally_discord.inc.php');

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
$zw = "\u{200B}";

// --- rally_discord_clean: mentions, markdown, links, newlines, length ---
check('plain', rally_discord_clean('Chribba'), 'Chribba');
check('@everyone', rally_discord_clean('@everyone'), "@{$zw}everyone");
check('@here', rally_discord_clean('hi @here'), "hi @{$zw}here");
check('user mention', rally_discord_clean('<@123456>'), "@{$zw}123456");
check('role mention', rally_discord_clean('<@&42>'), "@{$zw}&42");
check('markdown', rally_discord_clean('*bold* _it_ ~~s~~ `c` ||spoiler||'), '\\*bold\\* \\_it\\_ \\~\\~s\\~\\~ \\`c\\` \\|\\|spoiler\\|\\|');
check('masked link', rally_discord_clean('[click](https://evil.example)'), '\\[click\\](https://evil.example)');
check('autolink brackets', rally_discord_clean('<https://evil.example>'), 'https://evil.example');
check('newlines', rally_discord_clean("a\nb\r\nc"), 'a b c');
check('backslash', rally_discord_clean('a\\b'), 'a\\\\b');
check('length', mb_strlen(rally_discord_clean(str_repeat('x', 300))), 100);
check('null', rally_discord_clean(null), '');
check('hyphen kept', rally_discord_clean('E-R00024'), 'E-R00024');

// --- rally_discord_system_label ---
check('wormhole', rally_discord_system_label(['name' => 'J152820', 'class' => 5, 'regionID' => 11000024], ['name' => 'E-R00024']), 'J152820 (C5, E-R00024)');
check('thera', rally_discord_system_label(['name' => 'Thera', 'class' => 12, 'regionID' => 11000031], ['name' => 'G-R00031']), 'Thera (Thera, G-R00031)');
check('high-sec', rally_discord_system_label(['name' => 'Jita', 'security' => 0.9459, 'regionID' => 10000002], ['name' => 'The Forge']), 'Jita (High-Sec, The Forge)');
check('0.45 rounds to high-sec', rally_discord_system_label(['name' => 'X', 'security' => 0.46], null), 'X (High-Sec)');
check('low-sec', rally_discord_system_label(['name' => 'Rancer', 'security' => 0.38], ['name' => 'Sinq Laison']), 'Rancer (Low-Sec, Sinq Laison)');
check('null-sec', rally_discord_system_label(['name' => 'HED-GP', 'security' => -0.39], ['name' => 'Catch']), 'HED-GP (Null-Sec, Catch)');
check('pochven', rally_discord_system_label(['name' => 'Niarja', 'security' => -1.0, 'regionID' => 10000070], ['name' => 'Pochven']), 'Niarja (Pochven, Pochven)');
check('unknown', rally_discord_system_label(null, null), null);

// --- rally_discord_payload ---
$set = rally_discord_payload('set', 'Chribba', 'J152820 (C5, E-R00024)', 'J152820', 'https://tw.example');
check('set content', $set['content'], "Tripwire rally point from *Chribba*: **J152820 (C5, E-R00024)**\n<https://tw.example/?system=J152820>");
check('no mentions allowed', $set['allowed_mentions'], ['parse' => []]);
check('set without url', rally_discord_payload('set', 'A', 'Jita (High-Sec, The Forge)', 'Jita', null)['content'], 'Tripwire rally point from *A*: **Jita (High-Sec, The Forge)**');
check('clear', rally_discord_payload('clear', 'Chribba')['content'], 'Tripwire rally point cleared by *Chribba*');
check('hostile name', rally_discord_payload('clear', "@everyone *x*\n<@1>")['content'], "Tripwire rally point cleared by *@{$zw}everyone \\*x\\* @{$zw}1*");
check('no name', rally_discord_payload('clear', null)['content'], 'Tripwire rally point cleared by *someone*');
check('json has allowed_mentions', json_encode($set['allowed_mentions']), '{"parse":[]}');

// --- rally_discord_decision (debounce, 30 s window) ---
check('first post', rally_discord_decision(null), 'post');
check('old post', rally_discord_decision(['messageID' => '1', 'age' => 31]), 'post');
check('window edge', rally_discord_decision(['messageID' => '1', 'age' => 30]), 'post');
check('recent with id edits', rally_discord_decision(['messageID' => '1', 'age' => 5]), 'edit');
check('recent without id posts', rally_discord_decision(['messageID' => null, 'age' => 5]), 'post');
check('clock skew posts', rally_discord_decision(['messageID' => '1', 'age' => -5]), 'post');
check('custom window', rally_discord_decision(['messageID' => '1', 'age' => 50], 60), 'edit');

// --- rally_discord_message_url ---
check('post url', rally_discord_message_url('https://discord.com/api/webhooks/1/abc'), 'https://discord.com/api/webhooks/1/abc?wait=true');
check('post url with thread', rally_discord_message_url('https://discord.com/api/webhooks/1/abc?thread_id=9'), 'https://discord.com/api/webhooks/1/abc?thread_id=9&wait=true');
check('edit url', rally_discord_message_url('https://discord.com/api/webhooks/1/abc', '777'), 'https://discord.com/api/webhooks/1/abc/messages/777');
check('edit url with thread', rally_discord_message_url('https://discord.com/api/webhooks/1/abc/?thread_id=9', '777'), 'https://discord.com/api/webhooks/1/abc/messages/777?thread_id=9');

// --- rally_discord_url_base: configuration only, never request input ---
check('base from redirect', rally_discord_url_base('https://tw.example/index.php?mode=sso', '/rally.php'), 'https://tw.example');
check('base with port', rally_discord_url_base('http://rallydiscord.localhost:8096/index.php?mode=sso', '/rally.php'), 'http://rallydiscord.localhost:8096');
check('base in a subdirectory', rally_discord_url_base('https://tw.example/index.php', '/tripwire/rally.php'), 'https://tw.example/tripwire');
check('no redirect', rally_discord_url_base(null, '/rally.php'), null);
check('bad scheme', rally_discord_url_base('javascript://x/', '/rally.php'), null);
check('hostile script path dropped', rally_discord_url_base('https://tw.example/', '/x>**PWNED**[a](https://evil.example)<a/rally.php'), 'https://tw.example');
// A hostile Host / REQUEST_URI has no effect: the base doesn't read them
$_SERVER['HTTP_HOST'] = 'evil.example'; $_SERVER['SERVER_NAME'] = 'evil.example';
$_SERVER['REQUEST_URI'] = '/rally.php?x=>**PWNED**[Tripwire](https://evil.example)<a/';
check('hostile request ignored', rally_discord_url_base('https://tw.example/index.php?mode=sso', '/rally.php'), 'https://tw.example');
// And the payload can't be broken out of even with a bad base
$hostile = rally_discord_payload('set', 'A', 'Jita', 'Jita', 'http://x/>**PWNED**[T](https://evil.example)< a');
check('hostile base neutralised', $hostile['content'], "Tripwire rally point from *A*: **Jita**\n<http://x/**PWNED**[T](https://evil.example)a/?system=Jita>");
check('hostile base single autolink', substr_count($hostile['content'], '<') + substr_count($hostile['content'], '>'), 2);

// --- rally_discord_redact ---
check('redact webhook', rally_discord_redact('file_get_contents(https://discord.com/api/webhooks/1/SECRET?wait=true): failed to open stream: HTTP 404'),
	'file_get_contents(<webhook> failed to open stream: HTTP 404');
check('redact nothing', rally_discord_redact('timeout'), 'timeout');

// --- rally_discord_unlock: releases every hold on this lock name only (fake PDO, no database) ---
class FakeLockStmt {
	public $db; public $sql; public $params = [];
	function bindValue($k, $v, $t = null) { $this->params[$k] = $v; }
	function execute() { $this->db->calls[] = [$this->sql, $this->params]; return true; }
	function fetchColumn() { return array_shift($this->db->results); }
}
class FakeLockDb {
	public $calls = []; public $results = [];
	function prepare($sql) { $s = new FakeLockStmt(); $s->db = $this; $s->sql = $sql; return $s; }
}
$db = new FakeLockDb();
$db->results = [1, 1, 0];	// held twice (re-entrant stale hold), then free
check('unlock releases all holds', rally_discord_unlock($db, 'rally_discord_1.2'), 2);
check('unlock only this name', array_unique(array_map(function($c) { return $c[0] . ' ' . $c[1][':name']; }, $db->calls)), ['SELECT RELEASE_LOCK(:name) rally_discord_1.2']);
$db = new FakeLockDb();
$db->results = [null];	// lock doesn't exist
check('unlock nothing held', rally_discord_unlock($db, 'rally_discord_1.2'), 0);
$db = new FakeLockDb();
$db->results = [1, 0, 1];	// stale hold released, then GET_LOCK succeeds
check('lock drops a stale hold first', rally_discord_lock($db, 'rally_discord_1.2', 20), true);
check('lock calls', array_map(function($c) { return $c[0]; }, $db->calls), ['SELECT RELEASE_LOCK(:name)', 'SELECT RELEASE_LOCK(:name)', 'SELECT GET_LOCK(:name, :timeout)']);
$db->results = [];	// the shutdown release registered by rally_discord_lock reads nothing: stops at once

// --- rally_discord_route: Mask Admin > Discord first, upstream's DISCORD_WEB_HOOK as the fallback ---
$legacy = array('98000001.2' => 'https://discord.com/api/webhooks/1/legacy', '196379789.1' => 'https://discord.com/api/webhooks/2/private');
$noTables = new PDO('sqlite::memory:');
$noTables->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
check('route: no discord tables, legacy hook', rally_discord_route($noTables, '98000001.2', $legacy), array('via' => 'legacy', 'hook' => 'https://discord.com/api/webhooks/1/legacy'));
check('route: no discord tables, no legacy hook', rally_discord_route($noTables, '98000002.2', $legacy), null);
$rdb = new PDO('sqlite::memory:');
$rdb->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$rdb->exec('CREATE TABLE discord_settings (maskID TEXT PRIMARY KEY, settings TEXT)');
$rdb->exec('CREATE TABLE masks (maskID TEXT PRIMARY KEY, ownerID INTEGER, ownerType INTEGER)');
$rdb->exec('CREATE TABLE characters (characterID INTEGER, corporationID INTEGER, admin INTEGER)');
$rdb->exec('INSERT INTO characters VALUES (1, 98000001, 1), (2, 98000002, 1)');
check('route: no settings, legacy hook (nothing regresses)', rally_discord_route($rdb, '98000001.2', $legacy)['via'], 'legacy');
check('route: legacy hook of a private mask', rally_discord_route($rdb, '196379789.1', $legacy)['via'], 'legacy');
$off = discord_settings_defaults();
$rdb->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(array('98000001.2', json_encode($off)));
check('route: type off, legacy hook still used', rally_discord_route($rdb, '98000001.2', $legacy)['via'], 'legacy');
$on = $off;
$on['types']['rally']['enabled'] = true;
$on['types']['rally']['webhookID'] = 7;
$rdb->prepare('UPDATE discord_settings SET settings = ? WHERE maskID = ?')->execute(array(json_encode($on), '98000001.2'));
$route = rally_discord_route($rdb, '98000001.2', $legacy);
check('route: type on wins over the legacy hook', array($route['via'], $route['type']['webhookID'], isset($route['hook'])), array('settings', 7, false));
$rdb->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(array('98000002.2', json_encode($on)));
check('route: type on without a legacy hook', rally_discord_route($rdb, '98000002.2', $legacy)['via'], 'settings');
$rdb->exec('UPDATE characters SET admin = 0 WHERE corporationID = 98000002');
check('route: corporation without a Tripwire admin', rally_discord_route($rdb, '98000002.2', $legacy), null);
$rdb->prepare('UPDATE discord_settings SET settings = ? WHERE maskID = ?')->execute(array('not json', '98000001.2'));
check('route: unreadable settings count as off', rally_discord_route($rdb, '98000001.2', $legacy)['via'], 'legacy');

echo ($count - $failures) . "/$count passed\n";
exit($failures ? 1 : 0);
