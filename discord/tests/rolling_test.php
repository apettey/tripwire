<?php
// Fork-owned: tests for the "Rolling" Discord type (discord/rolling.php): settings, the change decided on the server,
// the message (template, EVE time, escaping, mentions), the done / hole-gone texts, the sender's plan, chain scope,
// debounce (superseded rows) and the sender's bookkeeping against SQLite. No network: Discord is faked.
//   docker compose -f docker-compose.dev.yml exec -T app php discord/tests/rolling_test.php
// End to end against the dev stack's worker and discord-mock: php tests/rolling_discord_flow_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../discord.inc.php');

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
discord_log_sink(function ($m) { });

$tpl = discord_default_templates();
$app = discord_app_url();
const J163701 = 31002012;
const J152820 = 31001880;
$started = gmmktime(19, 8, 0, 10, 10, 2026);   // 19:08 EVE
$now = gmmktime(19, 31, 0, 10, 10, 2026);      // 19:31 EVE

// --- settings ---
check('default texts: only the hole, its system and the EVE time', [$tpl['rolling'], $tpl['rollingClear']],
    ['{pings} Rolling **{name}** in **{system}** — {time} EVE', "{mark}\n{outcome} at {time} EVE"]);
$d = discord_settings_defaults(98000001)['types']['rolling'];
check('settings: off by default, default texts, chain only', [$d['enabled'], $d['webhookID'], $d['template'], $d['templateClear'], $d['ping'], $d['chainOnly']],
    [false, 0, $tpl['rolling'], $tpl['rollingClear'], '', true]);
[$s, $err] = discord_settings_normalise(['types' => ['rolling' => ['enabled' => true, 'webhookID' => 5, 'ping' => '<@&111111111111111111>',
    'template' => "{who}: {name}\r\n", 'templateClear' => '', 'chainOnly' => false]]], discord_settings_defaults(), [5]);
check('settings: kept', [$s['types']['rolling']['enabled'], $s['types']['rolling']['webhookID'], $s['types']['rolling']['ping'],
    $s['types']['rolling']['template'], $s['types']['rolling']['templateClear'], $s['types']['rolling']['chainOnly'], $err],
    [true, 5, '<@&111111111111111111>', '{who}: {name}', $tpl['rollingClear'], false, []]);
check('settings: fields', array_keys($s['types']['rolling']), ['enabled', 'webhookID', 'template', 'templateClear', 'ping', 'enabledAt', 'chainOnly']);
check('settings: chainOnly from strings', discord_settings_normalise(['types' => ['rolling' => ['chainOnly' => '0']]], discord_settings_defaults())[0]['types']['rolling']['chainOnly'], false);
check('settings: enabling needs a webhook', discord_settings_normalise(['types' => ['rolling' => ['enabled' => true]]], discord_settings_defaults())[0]['types']['rolling']['enabled'], false);
check('settings: unknown webhook refused', discord_settings_normalise(['types' => ['rolling' => ['enabled' => true, 'webhookID' => 9]]], discord_settings_defaults(), [5])[1],
    ['rolling: unknown webhook', 'rolling: pick a webhook to enable it']);
check('settings: bad ping refused', discord_settings_normalise(['types' => ['rolling' => ['ping' => '@here hi']]], discord_settings_defaults())[1],
    ['rolling: ping may only contain <@&roleID>, <@userID>, @here or @everyone']);
check('settings: stamped like the other types', discord_settings_stamp($s, discord_settings_defaults(), 4000)['types']['rolling']['enabledAt'], 4000);
check('settings: independent of preserve mass', $s['types']['preserveMass']['enabled'], false);
check('type: only when on with a webhook', [discord_rolling_type($s) !== null, discord_rolling_type(discord_settings_defaults())], [true, null]);
check('placeholders', array_keys(discord_placeholders()['rolling']), ['pings', 'mask', 'name', 'system', 'to', 'class', 'sig', 'connection', 'who', 'note',
    'withNote', 'map', 'time', 'outcome', 'mark']);
check('a kind of its own, before structureTimer', DISCORD_KINDS[count(DISCORD_KINDS) - 2], 'rolling');

// --- what changed ---
$f = function ($who, $note = '') { return ['wormholeID' => 1, 'setByID' => 1, 'setBy' => $who, 'setAt' => 1, 'note' => $note]; };
check('change: marked', discord_rolling_change(null, $f('A')), 'set');
check('change: cleared (done)', discord_rolling_change($f('A'), null), 'clear');
check('change: clear of nothing', discord_rolling_change(null, null), null);
check('change: same pilot and note again', discord_rolling_change($f('A', 'x'), ['setAt' => 9] + $f('A', 'x')), null);
check('change: another note', discord_rolling_change($f('A', 'x'), $f('A', 'y')), 'set');
check('change: another pilot', discord_rolling_change($f('A', 'x'), $f('B', 'x')), 'set');

// --- data queued by public/rolling.php ---
$hole = ['wormholeID' => 7, 'type' => 'H296', 'parent' => 'initial', 'life' => 'stable', 'mass' => 'destab', 'a' => J163701, 'b' => J152820, 'aSig' => 'abc123', 'bSig' => 'XYZ789'];
$labels = function ($l) { return function ($id) use ($l) { return $l[$id] ?? ''; }; };
// Home J163701 (no label), the hole "A" leads to J152820
$ends = discord_preserve_ends($hole, $labels([J152820 => 'A']), J163701);
$type = ['enabledAt' => 1000] + $s['types']['rolling'];
$data = discord_rolling_data(['chainOnly' => true] + $type, J163701, 'Corp', 42, 'set', 'Kytus Bos', $ends, false, 2000);
check('data', array_diff_key($data, ['ends' => 1]), ['kind' => 'rolling', 'wormholeID' => 42, 'action' => 'set', 'who' => 'Kytus Bos', 'gone' => false, 'rolled' => false,
    'template' => '{who}: {name}', 'templateClear' => $tpl['rollingClear'], 'ping' => '<@&111111111111111111>', 'chainOnly' => true,
    'homeSystemID' => J163701, 'mask' => 'Corp', 'time' => 2000, 'enabledAt' => 1000]);
check('data: the hole kept', $data['ends'], $ends);
check('data: before the type was turned on', discord_rolling_data($type, 0, 'Corp', 42, 'set', 'x', null, false, 999), null);
check('data: the worker\'s clear of a gone hole', discord_rolling_data($type, 0, 'Corp', 42, 'clear', DISCORD_ROLLING_GONE_WHO, null, true, 2000)['gone'], true);

// --- context ---
$base = ['wormholeID' => 42, 'template' => $tpl['rolling'], 'templateClear' => $tpl['rollingClear'], 'ping' => '@here', 'mask' => 'Corp', 'time' => $now];
$flag = ['setBy' => 'Kytus Bos', 'note' => 'closing it', 'setAt' => $started];
$ctx = discord_rolling_context(['action' => 'set', 'who' => 'Late'] + $base, $flag, $ends);
check('context: the flag as stored when sent', [$ctx['cleared'], $ctx['who'], $ctx['note'], $ctx['setAt'], $ctx['inChain']], [false, 'Kytus Bos', 'closing it', $started, true]);
check('context: in the chain', discord_rolling_context(['action' => 'set'] + $base, $flag, $ends, [J152820 => true])['inChain'], true);
check('context: not in the chain', discord_rolling_context(['action' => 'set'] + $base, $flag, $ends, [30000142 => true])['inChain'], false);
$done = discord_rolling_context(['action' => 'clear', 'who' => 'Aashai'] + $base, null, $ends);
check('context: done by this row, the hole still there', [$done['cleared'], $done['gone'], $done['who']], [true, false, 'Aashai']);
check('context: the hole is gone now: collapsed', discord_rolling_context(['action' => 'clear', 'who' => 'Aashai', 'ends' => $ends] + $base, null, null)['gone'], true);
check('context: the worker\'s clear', discord_rolling_context(['action' => 'clear', 'gone' => true, 'who' => DISCORD_ROLLING_GONE_WHO] + $base, null, $ends)['gone'], true);
check('context: unreadable flag: a clear is a clear, a set cannot be shown', [discord_rolling_context(['action' => 'clear', 'who' => 'C'] + $base, false, $ends)['cleared'],
    discord_rolling_context(['action' => 'set'] + $base, false, $ends)], [true, null]);

// --- messages ---
$live = '@here Rolling **A** in **J163701** — 19:08 EVE';
$p = discord_payload($ctx);
check('message: default text: hole name, system, EVE time when rolling started', $p, ['username' => 'Tripwire', 'content' => $live, 'allowed_mentions' => ['parse' => ['everyone']]]);
check('message: no label: the signature ID', discord_payload(discord_rolling_context(['action' => 'set', 'ping' => ''] + $base, $flag, discord_preserve_ends($hole, null, J163701)))['content'],
    'Rolling **ABC\\-123** in **J163701** — 19:08 EVE');
check('message: hole unknown', discord_payload(discord_rolling_context(['action' => 'set', 'ping' => '', 'template' => '{name} {system} {connection}'] + $base, $flag, null))['content'],
    '? ? a wormhole');
check('message: placeholders', discord_payload(discord_rolling_context(['action' => 'set', 'template' => '{to}|{class}|{sig}|{connection}|{who}|{note}|{withNote}|{mask}|{map}'] + $base, $flag, $ends))['content'],
    "J152820|C5|ABC\\-123|J163701 ↔ A · J152820|Kytus Bos|closing it|: closing it|Corp|<{$app}?system=J163701>");
$hostile = discord_payload(discord_rolling_context(['action' => 'set', 'template' => '{pings} {name} {who} {withNote}'] + $base, ['setBy' => '@everyone *x*', 'note' => "<@333333333333333333> **b** [l](https://e.example)", 'setAt' => $started],
    discord_preserve_ends($hole, $labels([J152820 => '@everyone ~~A~~']), J163701)));
check('message: names, notes and labels cannot ping, format or link', [strpos($hostile['content'], '@everyone'), preg_match('/<@[&!]?\d/', $hostile['content']),
    strpos($hostile['content'], '**b'), strpos($hostile['content'], '](https'), strpos($hostile['content'], '~~A'), $hostile['allowed_mentions']],
    [false, 0, false, false, false, ['parse' => ['everyone']]]);
check('message: mentions only from the admin\'s text and ping field', discord_payload(discord_rolling_context(['action' => 'set', 'ping' => '<@&111111111111111111>',
    'template' => '{pings} <@222222222222222222> {who}'] + $base, $flag, $ends))['allowed_mentions'], ['parse' => [], 'roles' => ['111111111111111111'], 'users' => ['222222222222222222']]);
check('message: an empty text falls back to the default', discord_payload(discord_rolling_context(['action' => 'set', 'template' => '{pings}', 'ping' => ''] + $base, $flag, $ends))['content'],
    'Rolling **A** in **J163701** — 19:08 EVE');

$struck = '~~Rolling **A** in **J163701** — 19:08 EVE~~';
check('done: struck through + "Done at" the EVE time it was cleared, nobody pinged', discord_payload(['previous' => $live] + $done),
    ['content' => "$struck\nDone at 19:31 EVE", 'allowed_mentions' => ['parse' => []]]);
$gone = discord_payload(['previous' => $live] + discord_rolling_context(['action' => 'clear', 'gone' => true, 'who' => DISCORD_ROLLING_GONE_WHO] + $base, null, null));
check('gone: struck through + "Hole closed at", nobody pinged', $gone, ['content' => "$struck\nHole closed at 19:31 EVE", 'allowed_mentions' => ['parse' => []]]);
// Rolled (closed): "Stop rolling > Rolled (closed)" only; a hole that vanished while flagged is "Hole closed ... (rolling by X)"
$rolledData = discord_rolling_data($type, 0, 'Corp', 42, 'clear', 'Aashai', null, false, 2000, true);
check('data: rolled', [$rolledData['rolled'], $data['rolled'], discord_rolling_data($type, 0, 'Corp', 42, 'clear', 'Aashai', null, true, 2000)['rolled']], [true, false, false]);
$rolledByUser = discord_rolling_context(['action' => 'clear', 'who' => 'Aashai', 'rolled' => true] + $base, null, $ends);
check('context: rolled', [$rolledByUser['cleared'], $rolledByUser['rolled'], $done['rolled']], [true, true, false]);
check('rolled: struck through + "Rolled by" who at the EVE time, nobody pinged', discord_payload(['previous' => $live] + $rolledByUser),
    ['content' => "$struck\nRolled by Aashai at 19:31 EVE", 'allowed_mentions' => ['parse' => []]]);
$rolledGone = discord_rolling_context(['action' => 'clear', 'gone' => true, 'who' => 'Kytus Bos'] + $base, null, null);
check('gone: a vanished hole names who was rolling it, not "Rolled"', discord_payload(['previous' => $live] + $rolledGone)['content'], "$struck\nHole closed at 19:31 EVE (rolling by Kytus Bos)");
$rolledUnknown = discord_rolling_context(['action' => 'clear', 'gone' => true, 'who' => DISCORD_ROLLING_GONE_WHO] + $base, null, null);
check('gone: nobody known: no "rolling by"', discord_payload(['previous' => $live] + $rolledUnknown)['content'], "$struck\nHole closed at 19:31 EVE");
check('rolled: the name cannot ping or format', discord_payload(['previous' => $live] + discord_rolling_context(['action' => 'clear', 'rolled' => true, 'who' => '@everyone **x**'] + $base, null, $ends))['content'],
    "$struck\nRolled by @\u{200B}everyone \\*\\*x\\*\\* at 19:31 EVE");
check('rolled: a plain clear is still Done', discord_payload(['previous' => $live] + $done)['content'], "$struck\nDone at 19:31 EVE");
check('done: a custom text sees who (the gone who too)', [discord_payload(['previous' => 'M', 'templateClear' => '{mark} {outcome} ({who})'] + $done)['content'],
    discord_payload(['previous' => 'M', 'templateClear' => '{outcome} ({who})'] + discord_rolling_context(['action' => 'clear', 'gone' => true, 'who' => DISCORD_ROLLING_GONE_WHO] + $base, null, null))['content']],
    ['~~M~~ Done (Aashai)', "~~M~~\nHole closed (Tripwire \\(the hole is gone from the map\\))"]);
check('done: a text without {mark} still strikes the message; its pings are dropped', discord_payload(['previous' => $live, 'templateClear' => '{pings} @here {outcome} <@&111111111111111111>'] + $done)['content'],
    "$struck\nDone");
check('done: only {mark} is the default', discord_payload(['previous' => 'M', 'templateClear' => '{mark}'] + $done)['content'], "~~M~~\nDone at 19:31 EVE");
$long = discord_payload(['previous' => str_repeat('x', 1990) . "\nsecond"] + $done);
check('done: a long text is cut, the done line stays', [mb_strlen($long['content']) <= DISCORD_CONTENT_MAX, str_ends_with($long['content'], 'Done at 19:31 EVE')], [true, true]);
check('changed: the old message', discord_payload(['previous' => $live, 'changed' => true] + discord_rolling_context(['action' => 'set'] + $base, ['setBy' => 'Aashai Modor', 'note' => '', 'setAt' => $now - 60], $ends)),
    ['content' => "$struck\nChanged by *Aashai Modor* at 19:31 EVE", 'allowed_mentions' => ['parse' => []]]);

// --- the sender's plan (preserve mass's, with these messages) ---
$set = $ctx;
$liveMsg = ['webhookID' => 5, 'messageID' => '123', 'content' => '@here old', 'postedAt' => 1000, 'clearedAt' => 0];
$plan = discord_rolling_plan($set, null, 1100);
check('plan: no message: posted with its pings', [$plan['op'], $plan['payload']['content'], $plan['strike']], ['post', $live, null]);
check('plan: not in the chain: nothing new', discord_rolling_plan(['inChain' => false] + $set, null, 1100), ['op' => 'skip', 'why' => 'not in the chain']);
$plan = discord_rolling_plan($set, $liveMsg, 1029);
check('plan: a change within 30 s edits, pinging nobody', [$plan['op'], $plan['state'], $plan['payload']['allowed_mentions'], $plan['payload']['content']], ['edit', 'live', ['parse' => []], $live]);
$plan = discord_rolling_plan($set, $liveMsg, 1030);
check('plan: a change after 30 s posts, the old one says it was changed', [$plan['op'], $plan['strike']['payload']['content']], ['post', "~~old~~\nChanged by *Kytus Bos* at 19:31 EVE"]);
check('plan: done without a message sends nothing', discord_rolling_plan($done, null, 5000)['op'], 'skip');
$plan = discord_rolling_plan($done, $liveMsg, 99999);
check('plan: done strikes the message', [$plan['op'], $plan['state'], $plan['payload']['content']], ['edit', 'cleared', "~~old~~\nDone at 19:31 EVE"]);
check('plan: marked again within 30 s of done: the message comes back', discord_rolling_plan($set, ['clearedAt' => 2000] + $liveMsg, 2010)['state'], 'revived');

// --- the sender's side, against SQLite ---
$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->sqliteCreateFunction('UTC_TIMESTAMP', function () { return gmdate('Y-m-d H:i:s'); }, 0);
$db->exec('CREATE TABLE discord_rolling_message (maskID TEXT, wormholeID INTEGER, webhookID INTEGER, messageID TEXT, content TEXT, postedAt TEXT, clearedAt TEXT, PRIMARY KEY (maskID, wormholeID))');
$db->exec('CREATE TABLE discord_preserve_message (maskID TEXT, wormholeID INTEGER, webhookID INTEGER, messageID TEXT, content TEXT, postedAt TEXT, clearedAt TEXT, PRIMARY KEY (maskID, wormholeID))');
$db->exec("CREATE TABLE discord_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, maskID TEXT, webhookID INTEGER, kind TEXT, priority INTEGER, data TEXT, status TEXT,
    attempts INTEGER DEFAULT 0, nextAttemptAt TEXT, createdAt TEXT, sentAt TEXT, lastError TEXT DEFAULT '')");
$token = str_repeat('Ab_-9', 14);
$url = "https://discord.com/api/webhooks/123456789012345678/$token";
$mask = '98000001.2';
$row = ['id' => 1, 'maskID' => $mask, 'webhookID' => 5, 'kind' => 'rolling'];
$ok = ['result' => 'sent', 'delay' => 0, 'error' => ''];
$req = discord_rolling_request($db, $row, $url, $set, 1000);
check('send: first mark posts', [$req['method'], $req['url']], ['POST', discord_webhook_send_url($url)]);
discord_rolling_after_send($db, $row, $req, 200, '{"id":"1111111111"}', $ok, 1000);
check('send: remembered in its own table', [discord_rolling_last($db, $mask, 42)['messageID'], discord_preserve_last($db, $mask, 42)], ['1111111111', null]);
check('send: a change nobody would see in the message (another note) sends nothing', discord_rolling_request($db, $row, $url, discord_rolling_context(['action' => 'set'] + $base, ['note' => 'x'] + $flag, $ends), 1010),
    ['skip' => 'the message already shows this mark']);
$req = discord_rolling_request($db, $row, $url, discord_rolling_context(['action' => 'set'] + $base, ['setBy' => 'Other', 'setAt' => $started + 60] + $flag, $ends), 1020);
check('send: a change in the window (re-marked a minute later) edits it', [$req['method'], $req['url']], ['PATCH', discord_webhook_edit_url($url, '1111111111')]);
discord_rolling_after_send($db, $row, $req, 200, '{"id":"1111111111"}', $ok, 1020);
$req = discord_rolling_request($db, $row, $url, $done, 5000);
discord_rolling_after_send($db, $row, $req, 200, '{"id":"1111111111"}', $ok, 5000);
check('send: done strikes it', [$req['method'], discord_rolling_last($db, $mask, 42)['clearedAt']], ['PATCH', 5000]);
check('send: a second clear sends nothing', isset(discord_rolling_request($db, $row, $url, $done, 5001)['skip']), true);
discord_rolling_remember($db, $mask, 42, 5, '2222', '@here x', 6000);
$req = discord_rolling_request($db, $row, $url, discord_rolling_context(['action' => 'set'] + $base, ['setBy' => 'Other'] + $flag, $ends), 7000);
discord_rolling_after_send($db, $row, $req, 200, '{"id":"3333"}', $ok, 7000);
$strike = $db->query("SELECT kind, data FROM discord_outbox WHERE kind = 'rollingEdit'")->fetch(PDO::FETCH_ASSOC);
check('send: changed later: new message, the old one queued to say so', [discord_rolling_last($db, $mask, 42)['messageID'], json_decode($strike['data'], true)['messageID']], ['3333', '2222']);
$editRow = ['kind' => 'rollingEdit'] + $row;
$req = discord_rolling_request($db, $editRow, $url, json_decode($strike['data'], true), 7001);
check('send: the strike row edits the old message', [$req['method'], $req['url']], ['PATCH', discord_webhook_edit_url($url, '2222')]);
check('send: ... deleted in Discord: skipped', discord_rolling_after_send($db, $editRow, $req, 404, '{"code":10008}', ['result' => 'broken'], 7001)['result'], 'skipped');
$req = discord_rolling_request($db, $row, $url, discord_rolling_context(['action' => 'set'] + $base, ['setBy' => 'Third', 'setAt' => $started + 600] + $flag, $ends), 7010);
check('send: edit of a deleted message reposts', [discord_rolling_after_send($db, $row, $req, 404, '{"code":10008}', ['result' => 'broken'], 7011)['result'], discord_rolling_last($db, $mask, 42)], ['repost', null]);

// Debounce
$db->exec('DELETE FROM discord_outbox');
$q = function ($wormholeID, $kind = 'rolling') use ($db, $mask) {
    $db->prepare("INSERT INTO discord_outbox (maskID, webhookID, kind, data, status) VALUES (?, 5, ?, ?, 'queued')")->execute([$mask, $kind, json_encode(['wormholeID' => $wormholeID])]);
    return ['id' => (int) $db->lastInsertId(), 'maskID' => $mask, 'data' => json_encode(['wormholeID' => $wormholeID])];
};
$first = $q(42);
$q(42, 'preserveMass');
check('debounce: a preserve mass row of the same hole does not count', discord_rolling_superseded($db, $first), false);
$last = $q(42);
check('debounce: a newer rolling row of the same hole replaces it', [discord_rolling_superseded($db, $first), discord_rolling_superseded($db, $last)], [true, false]);

// Prune, webhook changes, holes gone
$db->exec('DELETE FROM discord_rolling_message');
discord_rolling_remember($db, $mask, 1, 5, '1', 'a', 100000);
discord_rolling_remember($db, $mask, 2, 5, '2', 'b', 100000);
$db->exec("UPDATE discord_rolling_message SET clearedAt = '" . gmdate('Y-m-d H:i:s', 100000) . "' WHERE wormholeID = 2");
discord_rolling_remember($db, $mask, 3, 6, '3', 'c', 100000 - 8 * 86400);
check('prune', [discord_rolling_prune($db, 100000 + 2 * 86400), $db->query('SELECT wormholeID FROM discord_rolling_message')->fetchAll(PDO::FETCH_COLUMN)], [2, [1]]);
discord_rolling_forget_webhook($db, 5);
check('a replaced webhook URL forgets its messages', discord_rolling_last($db, $mask, 1), null);
$db->exec('CREATE TABLE wormholes (id INTEGER PRIMARY KEY, maskID TEXT)');
$db->exec("INSERT INTO wormholes (id, maskID) VALUES (1, '98000001.2'), (4, '98000002.2')");
foreach ([1, 2, 3, 4] as $wh) discord_rolling_remember($db, $mask, $wh, 5, (string) $wh, 'm', 100000);
$db->exec('UPDATE discord_rolling_message SET clearedAt = postedAt WHERE wormholeID = 3');
check('gone: live messages whose hole is gone (or now in another mask)', discord_rolling_gone($db), [[$mask, 2], [$mask, 4]]);

// Who started a hole that is gone (fork_rolling keeps the row until the mask's flags next change)
check('setter: no table: unknown', discord_rolling_setter($db, $mask, 2), '');
$db->exec('CREATE TABLE fork_rolling (maskID TEXT, wormholeID INTEGER, setBy TEXT)');
$db->exec("INSERT INTO fork_rolling VALUES ('$mask', 2, ' Kytus Bos '), ('$mask', 4, NULL)");
check('setter: the pilot who flagged it', [discord_rolling_setter($db, $mask, 2), discord_rolling_setter($db, $mask, 4), discord_rolling_setter($db, $mask, 9)], ['Kytus Bos', '', '']);

// Unreadable at send time: a mark waits, a clear is still a clear
$broken = new PDO('sqlite::memory:');
$broken->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$prow = ['id' => 1, 'maskID' => $mask, 'webhookID' => 5, 'kind' => 'rolling', 'age' => 0];
check('unreadable: a mark waits', discord_row_context($broken, $prow + ['data' => json_encode(['action' => 'set', 'chainOnly' => true, 'homeSystemID' => J163701] + $base)]), null);
$cleared = discord_row_context($broken, $prow + ['data' => json_encode(['action' => 'clear', 'who' => 'A', 'ends' => $ends] + $base)]);
check('unreadable: a clear is sent as done (not collapsed: unknown)', [$cleared['cleared'], $cleared['gone'], $cleared['who'], $cleared['ends']], [true, false, 'A', $ends]);

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
