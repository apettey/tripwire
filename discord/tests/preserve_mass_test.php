<?php
// Fork-owned: tests for the "Preserve mass" Discord type (discord/preserve_mass.php): settings, the change decided on
// the server, the message (template, escaping, mentions), the sender's plan (post / edit / strike / revive / skip),
// chain scope, debounce (superseded rows) and the sender's bookkeeping against SQLite. No network: Discord is faked.
//   docker compose -f docker-compose.dev.yml exec -T app php discord/tests/preserve_mass_test.php
// End to end against the dev stack's worker and discord-mock: php tests/preserve_mass_discord_flow_test.php
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

// --- settings ---
$d = discord_settings_defaults(98000001)['types']['preserveMass'];
check('settings: off by default, default texts, chain only', [$d['enabled'], $d['webhookID'], $d['template'], $d['templateClear'], $d['ping'], $d['chainOnly']],
    [false, 0, $tpl['preserveMass'], $tpl['preserveMassClear'], '', true]);
[$s, $err] = discord_settings_normalise(['types' => ['preserveMass' => ['enabled' => true, 'webhookID' => 5, 'ping' => '<@&111111111111111111>',
    'template' => "{who}: {connection}\r\n", 'templateClear' => '', 'chainOnly' => false]]], discord_settings_defaults(), [5]);
check('settings: kept', [$s['types']['preserveMass']['enabled'], $s['types']['preserveMass']['webhookID'], $s['types']['preserveMass']['ping'],
    $s['types']['preserveMass']['template'], $s['types']['preserveMass']['templateClear'], $s['types']['preserveMass']['chainOnly'], $err],
    [true, 5, '<@&111111111111111111>', '{who}: {connection}', $tpl['preserveMassClear'], false, []]);
check('settings: fields', array_keys($s['types']['preserveMass']), ['enabled', 'webhookID', 'template', 'templateClear', 'ping', 'enabledAt', 'chainOnly']);
check('settings: chainOnly from strings', [discord_settings_normalise(['types' => ['preserveMass' => ['chainOnly' => 'true']]], discord_settings_defaults())[0]['types']['preserveMass']['chainOnly'],
    discord_settings_normalise(['types' => ['preserveMass' => ['chainOnly' => '0']]], discord_settings_defaults())[0]['types']['preserveMass']['chainOnly']], [true, false]);
check('settings: enabling needs a webhook', discord_settings_normalise(['types' => ['preserveMass' => ['enabled' => true]]], discord_settings_defaults())[0]['types']['preserveMass']['enabled'], false);
check('settings: bad ping refused', discord_settings_normalise(['types' => ['preserveMass' => ['ping' => '@here hi']]], discord_settings_defaults())[1],
    ['preserveMass: ping may only contain <@&roleID>, <@userID>, @here or @everyone']);
check('settings: stamped like the other types', discord_settings_stamp($s, discord_settings_defaults(), 4000)['types']['preserveMass']['enabledAt'], 4000);
check('type: only when on with a webhook', [discord_preserve_type($s) !== null, discord_preserve_type(discord_settings_defaults())], [true, null]);
check('placeholders', array_keys(discord_placeholders()['preserveMass']), ['pings', 'mask', 'connection', 'from', 'to', 'hole', 'class', 'details', 'sig',
    'mass', 'life', 'who', 'reason', 'withReason', 'map', 'time', 'mark']);
check('a kind of its own', in_array('preserveMass', DISCORD_KINDS, true), true);

// --- what changed (decided by the server from the stored flag before / after the request) ---
$f = function ($who, $reason = '') { return ['wormholeID' => 1, 'setBy' => $who, 'setAt' => 1, 'reason' => $reason]; };
check('change: marked', discord_preserve_change(null, $f('A')), 'set');
check('change: cleared', discord_preserve_change($f('A'), null), 'clear');
check('change: clear of nothing', discord_preserve_change(null, null), null);
check('change: same pilot and reason again (only the time moved)', discord_preserve_change($f('A', 'x'), $f('A', 'x') + ['setAt' => 9]), null);
check('change: another reason', discord_preserve_change($f('A', 'x'), $f('A', 'y')), 'set');
check('change: another pilot', discord_preserve_change($f('A', 'x'), $f('B', 'x')), 'set');

// --- the two ends of a hole ---
$hole = ['wormholeID' => 7, 'type' => 'H296', 'parent' => 'secondary', 'life' => 'critical', 'mass' => 'destab', 'a' => J163701, 'b' => J152820, 'aSig' => 'abc123', 'bSig' => 'XYZ789'];
$labels = function ($l) { return function ($id) use ($l) { return $l[$id] ?? ''; }; };
$ends = discord_preserve_ends($hole, $labels([J163701 => 'AB']));
check('ends: near = the labelled end, an end without a label is farthest', [$ends['near']['system'], $ends['near']['label'], $ends['far']['system'], $ends['far']['label']],
    ['J163701', 'AB', 'J152820', '']);
check('ends: the type was scanned on the far side: K162 from here; far class; near sig', [$ends['hole'], $ends['far']['class'], $ends['sig'], $ends['mass'], $ends['life']],
    ['K162', 'C5', 'ABC-123', 'destab', 'critical']);
check('ends: shorter label first', discord_preserve_ends($hole, $labels([J163701 => 'ABC', J152820 => 'AB']))['near']['system'], 'J152820');
check('ends: seen from the typed side', discord_preserve_ends($hole, $labels([J152820 => 'A', J163701 => 'AB']))['hole'], 'H296');
check('ends: home is always near', discord_preserve_ends($hole, $labels([J163701 => 'A']), J152820)['near']['system'], 'J152820');
check('ends: no labels, no home: the first signature', discord_preserve_ends($hole)['near']['system'], 'J163701');
check('ends: unknown type', discord_preserve_ends(['type' => '????', 'parent' => 'initial'] + $hole)['hole'], '');
check('ends: no parent known', discord_preserve_ends(['parent' => ''] + $hole)['hole'], '');
check('ends: unknown far side (generic class)', [discord_preserve_ends(['b' => 7] + $hole)['far']['system'], discord_preserve_ends(['b' => 7] + $hole)['far']['class'],
    discord_preserve_ends(['b' => 11] + $hole)['far']['system'], discord_preserve_ends(['b' => 99] + $hole)['far']['system']], ['Class-5', 'C5', 'Unknown', 'Unknown']);

// --- data queued by public/preserve_mass.php ---
$type = ['enabledAt' => 1000] + $s['types']['preserveMass'];
$data = discord_preserve_data(['chainOnly' => true] + $type, J163701, 'Corp', 42, 'set', 'Kytus Bos', $ends, 2000);
check('data', array_diff_key($data, ['ends' => 1]), ['kind' => 'preserveMass', 'wormholeID' => 42, 'action' => 'set', 'who' => 'Kytus Bos',
    'template' => '{who}: {connection}', 'templateClear' => $tpl['preserveMassClear'], 'ping' => '<@&111111111111111111>', 'chainOnly' => true,
    'homeSystemID' => J163701, 'mask' => 'Corp', 'time' => 2000, 'enabledAt' => 1000]);
check('data: the hole kept', $data['ends'], $ends);
check('data: before the type was turned on', discord_preserve_data($type, 0, 'Corp', 42, 'set', 'x', null, 999), null);
check('data: unknown action is a set', discord_preserve_data($type, 0, 'Corp', 42, 'bogus', 'x', null, 2000)['action'], 'set');

// --- message context ---
$base = ['wormholeID' => 42, 'template' => $tpl['preserveMass'], 'templateClear' => $tpl['preserveMassClear'], 'ping' => '@here', 'mask' => 'Corp', 'time' => 1760123280];
$flag = ['setBy' => 'Kytus Bos', 'reason' => 'home static'];
$ctx = discord_preserve_context(['action' => 'set', 'who' => 'Late'] + $base, $flag, $ends);
check('context: the flag as stored when sent', [$ctx['cleared'], $ctx['who'], $ctx['reason'], $ctx['inChain']], [false, 'Kytus Bos', 'home static', true]);
check('context: in the chain (either end)', discord_preserve_context(['action' => 'set'] + $base, $flag, $ends, [J152820 => true])['inChain'], true);
check('context: not in the chain', discord_preserve_context(['action' => 'set'] + $base, $flag, $ends, [30000142 => true])['inChain'], false);
check('context: no home = empty chain = nothing new', discord_preserve_context(['action' => 'set'] + $base, $flag, $ends, [])['inChain'], false);
check('context: cleared by this row', [discord_preserve_context(['action' => 'clear', 'who' => 'Aashai'] + $base, null, $ends)['cleared'],
    discord_preserve_context(['action' => 'clear', 'who' => 'Aashai'] + $base, null, $ends)['who']], [true, 'Aashai']);
check('context: a set whose flag is gone was cleared by someone else', discord_preserve_context(['action' => 'set', 'who' => 'Kytus'] + $base, null, $ends)['who'], 'someone');
check('context: unreadable flag: a clear is a clear, a set cannot be shown', [discord_preserve_context(['action' => 'clear', 'who' => 'C'] + $base, false, $ends)['cleared'],
    discord_preserve_context(['action' => 'set'] + $base, false, $ends)], [true, null]);
check('context: the hole is gone: the kept ends', discord_preserve_context(['action' => 'set', 'ends' => $ends] + $base, $flag, null)['ends'], $ends);
check('context: no setBy', discord_preserve_context(['action' => 'set'] + $base, ['setBy' => '', 'reason' => ''], $ends)['who'], 'someone');

// --- messages ---
$live = "@here Preserve mass on **AB · J163701 ↔ J152820** (K162, C5) by *Kytus Bos*: home static\n<{$app}?system=J163701>";
$p = discord_payload($ctx);
check('message: default text', $p, ['username' => 'Tripwire', 'content' => $live, 'allowed_mentions' => ['parse' => ['everyone']]]);
check('message: without a reason', discord_payload(discord_preserve_context(['action' => 'set', 'ping' => ''] + $base, ['setBy' => 'A', 'reason' => ''], $ends))['content'],
    "Preserve mass on **AB · J163701 ↔ J152820** (K162, C5) by *A*\n<{$app}?system=J163701>");
check('message: hole unknown', discord_payload(discord_preserve_context(['action' => 'set', 'ping' => '', 'template' => '{connection} ({details})'] + $base, $flag, null))['content'],
    'a wormhole (?)');
check('message: placeholders', discord_payload(discord_preserve_context(['action' => 'set', 'template' => '{from}|{to}|{hole}|{class}|{sig}|{mass}|{life}|{reason}|{mask}'] + $base, $flag, $ends))['content'],
    'AB · J163701|J152820|K162|C5|ABC\\-123|destabilized|EOL|home static|Corp');
$hostile = discord_payload(discord_preserve_context(['action' => 'set'] + $base, ['setBy' => "@everyone <@&999999999999999999> *x*", 'reason' => "<@333333333333333333> **b** [l](https://e.example)\n@here"],
    discord_preserve_ends($hole, $labels([J163701 => '@everyone ~~AB~~']))));
check('message: names, reason and labels cannot ping, format or link', [strpos($hostile['content'], '@everyone'), preg_match('/<@[&!]?\d/', $hostile['content']), strpos($hostile['content'], '**b'),
    strpos($hostile['content'], '](https'), strpos($hostile['content'], '~~AB'), $hostile['allowed_mentions']], [false, 0, false, false, false, ['parse' => ['everyone']]]);
check('message: mentions only from the admin\'s text and ping field', discord_payload(discord_preserve_context(['action' => 'set', 'ping' => '<@&111111111111111111>',
    'template' => '{pings} <@222222222222222222> {who}'] + $base, $flag, $ends))['allowed_mentions'], ['parse' => [], 'roles' => ['111111111111111111'], 'users' => ['222222222222222222']]);
check('message: an empty text falls back to the default', discord_payload(discord_preserve_context(['action' => 'set', 'template' => '{pings}', 'ping' => ''] + $base, $flag, $ends))['content'],
    "Preserve mass on **AB · J163701 ↔ J152820** (K162, C5) by *Kytus Bos*: home static\n<{$app}?system=J163701>");

$clearCtx = discord_preserve_context(['action' => 'clear', 'who' => 'Aashai Modor'] + $base, null, $ends);
$struck = '~~Preserve mass on **AB · J163701 ↔ J152820** (K162, C5) by *Kytus Bos*: home static~~';
check('cleared: struck through, who and when, nobody pinged', discord_payload(['previous' => $live] + $clearCtx),
    ['content' => "$struck\nCleared by *Aashai Modor* at <t:1760123280:t>", 'allowed_mentions' => ['parse' => []]]);
check('cleared: a text without {mark} still strikes the message; its pings are dropped', discord_payload(['previous' => $live, 'templateClear' => '{pings} @here Gone, said {who} <@&111111111111111111>'] + $clearCtx)['content'],
    "$struck\nGone, said Aashai Modor");
check('cleared: {mark} where the admin puts it', discord_payload(['previous' => '@here Mark *A*', 'templateClear' => 'Over. {mark} ({who})'] + $clearCtx)['content'], 'Over. ~~Mark *A*~~ (Aashai Modor)');
check('cleared: only {mark} is the default', discord_payload(['previous' => 'M', 'templateClear' => '{mark}'] + $clearCtx)['content'], "~~M~~\nCleared by *Aashai Modor* at <t:1760123280:t>");
check('cleared: a hostile name cannot ping', discord_payload(['previous' => 'M'] + discord_preserve_context(['action' => 'clear', 'who' => '@here <@&111111111111111111>'] + $base, null, $ends))['content'],
    "~~M~~\nCleared by *@\u{200B}here \\<@\u{200B}&111111111111111111\\>* at <t:1760123280:t>");
$long = discord_payload(['previous' => str_repeat('x', 1990) . "\nsecond"] + $clearCtx);
check('cleared: a long text is cut, the cleared line stays', [mb_strlen($long['content']) <= DISCORD_CONTENT_MAX, str_ends_with($long['content'], "Cleared by *Aashai Modor* at <t:1760123280:t>")], [true, true]);
check('changed: the old message', discord_payload(['previous' => $live, 'changed' => true] + discord_preserve_context(['action' => 'set'] + $base, ['setBy' => 'Aashai Modor', 'reason' => ''], $ends)),
    ['content' => "$struck\nChanged by *Aashai Modor* at <t:1760123280:t>", 'allowed_mentions' => ['parse' => []]]);
check('earlier default texts: none yet', discord_template_upgrade('preserveMass', 'template', 'x'), 'x');

// --- the sender's plan (pure) ---
$set = discord_preserve_context(['action' => 'set'] + $base, $flag, $ends);
$liveMsg = ['webhookID' => 5, 'messageID' => '123', 'content' => '@here old mark', 'postedAt' => 1000, 'clearedAt' => 0];
$plan = discord_preserve_plan($set, null, 1100);
check('plan: no message: posted with its pings', [$plan['op'], $plan['payload']['allowed_mentions'], $plan['strike']], ['post', ['parse' => ['everyone']], null]);
check('plan: not in the chain: nothing new', discord_preserve_plan(['inChain' => false] + $set, null, 1100), ['op' => 'skip', 'why' => 'not in the chain']);
$plan = discord_preserve_plan($set, $liveMsg, 1029);
check('plan: a change within 30 s edits, pinging nobody', [$plan['op'], $plan['state'], isset($plan['payload']['username']), $plan['payload']['allowed_mentions'], $plan['payload']['content']],
    ['edit', 'live', false, ['parse' => []], $live]);
check('plan: ... also outside the chain (it is our message)', discord_preserve_plan(['inChain' => false] + $set, $liveMsg, 1029)['op'], 'edit');
check('plan: the message already shows it', discord_preserve_plan($set, ['content' => $live] + $liveMsg, 1010), ['op' => 'skip', 'why' => 'the message already shows this mark']);
check('plan: ... also after the window (no repost of the same mark)', discord_preserve_plan($set, ['content' => $live] + $liveMsg, 99999)['op'], 'skip');
$plan = discord_preserve_plan($set, $liveMsg, 1030);
check('plan: a change after 30 s posts, the old message says it was changed', [$plan['op'], $plan['strike']['messageID'], $plan['strike']['payload']],
    ['post', '123', ['content' => "~~old mark~~\nChanged by *Kytus Bos* at <t:1760123280:t>", 'allowed_mentions' => ['parse' => []]]]);
check('plan: a change that pings someone new is a new message', discord_preserve_plan(['ping' => '<@&111111111111111111>'] + $set, $liveMsg, 1005)['op'], 'post');
check('plan: clock skew posts', discord_preserve_plan($set, ['postedAt' => 1200] + $liveMsg, 1100)['op'], 'post');
check('plan: a clear without a message sends nothing', discord_preserve_plan($clearCtx, null, 5000), ['op' => 'skip', 'why' => 'no preserve mass message to edit']);
$plan = discord_preserve_plan($clearCtx, $liveMsg, 99999);
check('plan: a clear at any time strikes the message', [$plan['op'], $plan['state'], $plan['payload']],
    ['edit', 'cleared', ['content' => "~~old mark~~\nCleared by *Aashai Modor* at <t:1760123280:t>", 'allowed_mentions' => ['parse' => []]]]);
$struckMsg = ['clearedAt' => 2000] + $liveMsg;
check('plan: a clear of a struck message sends nothing', discord_preserve_plan($clearCtx, $struckMsg, 2005), ['op' => 'skip', 'why' => 'the message is already struck through']);
$plan = discord_preserve_plan($set, $struckMsg, 2029);
check('plan: marked again within 30 s of the clear: the message comes back (an edit)', [$plan['op'], $plan['state'], $plan['payload']['content'], $plan['payload']['allowed_mentions']],
    ['edit', 'revived', $live, ['parse' => []]]);
check('plan: ... even outside the chain', discord_preserve_plan(['inChain' => false] + $set, $struckMsg, 2010)['op'], 'edit');
$plan = discord_preserve_plan($set, $struckMsg, 2030);
check('plan: marked again later: a new message', [$plan['op'], $plan['strike']], ['post', null]);
check('plan: ... not in the chain: nothing', discord_preserve_plan(['inChain' => false] + $set, $struckMsg, 2030)['op'], 'skip');

// --- the sender's side, against SQLite: remember / edit / strike / revive / repost / skipped / superseded / prune ---
$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->sqliteCreateFunction('UTC_TIMESTAMP', function () { return gmdate('Y-m-d H:i:s'); }, 0);
$db->exec('CREATE TABLE discord_preserve_message (maskID TEXT, wormholeID INTEGER, webhookID INTEGER, messageID TEXT, content TEXT, postedAt TEXT, clearedAt TEXT, PRIMARY KEY (maskID, wormholeID))');
$db->exec("CREATE TABLE discord_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, maskID TEXT, webhookID INTEGER, kind TEXT, priority INTEGER, data TEXT, status TEXT,
    attempts INTEGER DEFAULT 0, nextAttemptAt TEXT, createdAt TEXT, sentAt TEXT, lastError TEXT DEFAULT '')");
$token = str_repeat('Ab_-9', 14);
$url = "https://discord.com/api/webhooks/123456789012345678/$token";
$mask = '98000001.2';
$row = ['id' => 1, 'maskID' => $mask, 'webhookID' => 5, 'kind' => 'preserveMass'];
$ok = ['result' => 'sent', 'delay' => 0, 'error' => ''];
$set = discord_preserve_context(['action' => 'set'] + $base, $flag, $ends);
$req = discord_preserve_request($db, $row, $url, $set, 1000);
check('send: first mark posts', [$req['method'], $req['url'], $req['payload']['username']], ['POST', discord_webhook_send_url($url), 'Tripwire']);
discord_preserve_after_send($db, $row, $req, 200, '{"id":"1111111111"}', $ok, 1000);
check('send: posted message remembered with its text', discord_preserve_last($db, $mask, 42),
    ['webhookID' => 5, 'messageID' => '1111111111', 'content' => $live, 'postedAt' => 1000, 'clearedAt' => 0]);
check('send: other holes have their own message', discord_preserve_last($db, $mask, 43), null);
$changed = discord_preserve_context(['action' => 'set'] + $base, ['setBy' => 'Kytus Bos', 'reason' => 'fleet out'], $ends);
$req = discord_preserve_request($db, $row, $url, $changed, 1020);
check('send: a change in the window edits it', [$req['method'], $req['url']], ['PATCH', discord_webhook_edit_url($url, '1111111111')]);
discord_preserve_after_send($db, $row, $req, 200, '{"id":"1111111111"}', $ok, 1020);
check('send: an edit keeps the window of the post and the new text', [discord_preserve_last($db, $mask, 42)['postedAt'], strpos(discord_preserve_last($db, $mask, 42)['content'], 'fleet out') > 0], [1000, true]);
check('send: another channel posts', discord_preserve_request($db, ['webhookID' => 6] + $row, $url, $set, 1010)['method'], 'POST');
check('send: a clear for another channel sends nothing', discord_preserve_request($db, ['webhookID' => 6] + $row, $url, $clearCtx, 1010), ['skip' => 'no preserve mass message to edit']);
check('send: a clear after the type was turned on again sends nothing', discord_preserve_request($db, $row, $url, ['enabledAt' => 1001] + $clearCtx, 1010), ['skip' => 'no preserve mass message to edit']);
$req = discord_preserve_request($db, $row, $url, $clearCtx, 5000);
check('send: a clear strikes it', [$req['method'], strpos($req['payload']['content'], '~~') === 0], ['PATCH', true]);
discord_preserve_after_send($db, $row, $req, 200, '{"id":"1111111111"}', $ok, 5000);
check('send: struck, remembered', discord_preserve_last($db, $mask, 42)['clearedAt'], 5000);
check('send: a second clear sends nothing', discord_preserve_request($db, $row, $url, $clearCtx, 5001), ['skip' => 'the message is already struck through']);
$req = discord_preserve_request($db, $row, $url, $set, 5010);
check('send: marked again soon: the struck message comes back', [$req['method'], $req['plan']['state'], $req['payload']['content']], ['PATCH', 'revived', $live]);
discord_preserve_after_send($db, $row, $req, 200, '{"id":"1111111111"}', $ok, 5010);
check('send: ... live again, with a new window', [discord_preserve_last($db, $mask, 42)['clearedAt'], discord_preserve_last($db, $mask, 42)['postedAt']], [0, 5010]);
$req = discord_preserve_request($db, $row, $url, $changed, 6000);
check('send: changed later: a new message', $req['method'], 'POST');
discord_preserve_after_send($db, $row, $req, 200, '{"id":"2222222222"}', $ok, 6000);
$strike = $db->query("SELECT webhookID, kind, data FROM discord_outbox WHERE kind = 'preserveMassEdit'")->fetch(PDO::FETCH_ASSOC);
check('send: ... and the old one is queued to say it was changed', [(int) $strike['webhookID'], json_decode($strike['data'], true)['messageID'], strpos(json_decode($strike['data'], true)['payload']['content'], 'Changed by *Kytus Bos*') > 0],
    [5, '1111111111', true]);
$editRow = ['kind' => 'preserveMassEdit'] + $row;
$req = discord_preserve_request($db, $editRow, $url, json_decode($strike['data'], true), 6001);
check('send: the strike row edits the old message', [$req['method'], $req['url']], ['PATCH', discord_webhook_edit_url($url, '1111111111')]);
check('send: the strike row of a message deleted in Discord is skipped', discord_preserve_after_send($db, $editRow, $req, 404, '{"message":"Unknown Message","code":10008}', ['result' => 'broken'], 6001)['result'], 'skipped');
check('send: the new message is the live one', discord_preserve_last($db, $mask, 42)['messageID'], '2222222222');
$req = discord_preserve_request($db, $row, $url, $set, 6010);
check('send: edit of a deleted message reposts, the webhook is not broken', [discord_preserve_after_send($db, $row, $req, 404, '{"message":"Unknown Message","code":10008}', ['result' => 'broken'], 6011)['result'],
    discord_preserve_last($db, $mask, 42)], ['repost', null]);
check('send: a deleted webhook is still broken', discord_preserve_after_send($db, $row, $req, 404, '{"message":"Unknown Webhook","code":10015}', ['result' => 'broken'], 6011)['result'], 'broken');
discord_preserve_remember($db, $mask, 42, 5, '3333', '@here x', 7000);
$req = discord_preserve_request($db, $row, $url, $clearCtx, 9000);
check('send: a clear of a deleted message is skipped, nothing posted', [$req['method'], discord_preserve_after_send($db, $row, $req, 404, '{"message":"Unknown Message","code":10008}', ['result' => 'broken'], 9000)['result'],
    discord_preserve_last($db, $mask, 42)], ['PATCH', 'skipped', null]);

// Debounce: a row is skipped when a newer row of the same hole is queued
$db->exec('DELETE FROM discord_outbox');
$q = function ($wormholeID, $status = 'queued', $mask = '98000001.2') use ($db) {
    $db->prepare("INSERT INTO discord_outbox (maskID, webhookID, kind, data, status) VALUES (?, 5, 'preserveMass', ?, ?)")->execute([$mask, json_encode(['wormholeID' => $wormholeID]), $status]);
    return ['id' => (int) $db->lastInsertId(), 'maskID' => $mask, 'data' => json_encode(['wormholeID' => $wormholeID])];
};
$first = $q(42);
check('debounce: alone: sent', discord_preserve_superseded($db, $first), false);
$q(43);
check('debounce: a newer row of another hole does not count', discord_preserve_superseded($db, $first), false);
$q(42, 'queued', '98000002.2');
check('debounce: ... nor of another mask', discord_preserve_superseded($db, $first), false);
$q(42, 'sent');
check('debounce: ... nor one already sent', discord_preserve_superseded($db, $first), false);
$last = $q(42);
check('debounce: a newer row of the same hole replaces it', [discord_preserve_superseded($db, $first), discord_preserve_superseded($db, $last)], [true, false]);

// Prune and webhook changes
$db->exec('DELETE FROM discord_preserve_message');
discord_preserve_remember($db, $mask, 1, 5, '1', 'a', 100000);   // live, recent
discord_preserve_remember($db, $mask, 2, 5, '2', 'b', 100000);   // struck long ago
$db->exec("UPDATE discord_preserve_message SET clearedAt = '" . gmdate('Y-m-d H:i:s', 100000) . "' WHERE wormholeID = 2");
discord_preserve_remember($db, $mask, 3, 6, '3', 'c', 100000 - 8 * 86400);   // posted 8 days ago
check('prune', [discord_preserve_prune($db, 100000 + 2 * 86400), $db->query('SELECT wormholeID FROM discord_preserve_message')->fetchAll(PDO::FETCH_COLUMN)], [2, [1]]);
discord_preserve_forget_webhook($db, 5);
check('a replaced webhook URL forgets its messages', discord_preserve_last($db, $mask, 1), null);

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
