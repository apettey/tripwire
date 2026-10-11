<?php
// Fork-owned: tests for "Fight here" with fleet comps (fight/fight.inc.php) and its Discord message (discord/rally.php,
// discord/template.php, rally_discord.inc.php). No network; SQLite stands in for MySQL.
//   docker compose -f docker-compose.dev.yml exec -T app php fight/tests/fight_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../../discord/discord.inc.php');
require_once(__DIR__ . '/../../rally_discord.inc.php');

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
const ROLE = '<@&123456789012345678>';

// ---------- comps: validation ----------
[$c, $e] = fight_validate_comp(['name' => "  Armor \n HACs ", 'colour' => 'red', 'note' => ' Zealots ', 'mention' => ' ' . ROLE . '  @here '], []);
check('valid comp: cleaned, a new id', [$c['name'], $c['colour'], $c['note'], $c['mention'], (bool) preg_match('/^c[0-9a-f]{10}$/', $c['id']), $e],
    ['Armor HACs', 'red', 'Zealots', ROLE . ' @here', true, []]);
check('valid comp: no note, no mention', fight_validate_comp(['name' => 'X', 'colour' => 'blue'], [])[0]['note'] . '|' . fight_validate_comp(['name' => 'X', 'colour' => 'blue'], [])[0]['mention'], '|');
check('name required', fight_validate_comp(['name' => '   ', 'colour' => 'red'], [])[1], ['Give the comp a name']);
check('name: 40 characters ok', fight_validate_comp(['name' => str_repeat('é', 40), 'colour' => 'red'], [])[1], []);
check('name: 41 too long', fight_validate_comp(['name' => str_repeat('x', 41), 'colour' => 'red'], [])[1], ['The name can be at most 40 characters']);
check('name: not a string', fight_validate_comp(['name' => ['x'], 'colour' => 'red'], [])[1], ['Give the comp a name']);
check('colour from the palette only', fight_validate_comp(['name' => 'A', 'colour' => '#ff0000'], [])[1], ['Pick one of the colours']);
check('colour missing', fight_validate_comp(['name' => 'A'], [])[1], ['Pick one of the colours']);
check('note: 140 ok, 141 too long', [fight_validate_comp(['name' => 'A', 'colour' => 'red', 'note' => str_repeat('n', 140)], [])[1],
    fight_validate_comp(['name' => 'A', 'colour' => 'red', 'note' => str_repeat('n', 141)], [])[1]], [[], ['The note can be at most 140 characters']]);
foreach (['@armor', '<@&12>', ROLE . ' hi', '<#123456789012345678>', 'everyone'] as $bad) {
    check("mention refused: $bad", fight_validate_comp(['name' => 'A', 'colour' => 'red', 'mention' => $bad], [])[1],
        ['The Discord mention may only contain <@&roleID>, <@userID>, @here or @everyone']);
}
check('mention: user and everyone', fight_validate_comp(['name' => 'A', 'colour' => 'red', 'mention' => '<@!123456789012345678> @everyone'], [])[0]['mention'], '<@!123456789012345678> @everyone');
$armor = ['id' => 'c0123456789', 'name' => 'Armor HACs', 'colour' => 'red', 'note' => 'Zealots + Sacrileges', 'mention' => ROLE];
$shield = ['id' => 'cabcdefabcd', 'name' => 'Shield BS', 'colour' => 'blue', 'note' => '', 'mention' => ''];
check('name unique, ignoring case', fight_validate_comp(['name' => 'ARMOR hacs', 'colour' => 'red'], [$armor])[1], ['There is already a comp called "Armor HACs"']);
check('an edit keeps its id', fight_validate_comp(['id' => 'c0123456789', 'name' => 'Armor HACs', 'colour' => 'pink'], [$shield])[0]['id'], 'c0123456789');
check('an id already used by another comp is replaced', fight_validate_comp(['id' => 'cabcdefabcd', 'name' => 'New', 'colour' => 'pink'], [$shield])[0]['id'] !== 'cabcdefabcd', true);
check('a malformed id is replaced', fight_validate_comp(['id' => "x'><", 'name' => 'New', 'colour' => 'pink'], [])[0]['id'] !== "x'><", true);

// ---------- comps: stored list ----------
check('normalise: valid kept in order', fight_normalise_comps([$armor, $shield]), [$armor, $shield]);
check('normalise: invalid, duplicate ids and names dropped', fight_normalise_comps([$armor, ['id' => 'c0123456789', 'name' => 'Dup', 'colour' => 'red'],
    ['id' => 'c1111111111', 'name' => 'armor hacs', 'colour' => 'red'], ['id' => 'bad', 'name' => 'X', 'colour' => 'red'], ['id' => 'c2222222222', 'name' => 'Y', 'colour' => 'nope'], 'junk']), [$armor]);
$many = [];
for ($i = 0; $i < 25; $i++) $many[] = ['id' => 'c' . str_pad((string) $i, 10, '0', STR_PAD_LEFT), 'name' => "Comp $i", 'colour' => 'red', 'note' => '', 'mention' => ''];
check('normalise: at most 20', count(fight_normalise_comps($many)), FIGHT_MAX_COMPS);
check('normalise: not a list', [fight_normalise_comps(null), fight_normalise_comps('x')], [[], []]);
check('public comps: no mention for members', fight_public_comps([$armor]), [['id' => 'c0123456789', 'name' => 'Armor HACs', 'colour' => 'red', 'note' => 'Zealots + Sacrileges']]);
check('public comps: mention for the admins page', fight_public_comps([$armor], true)[0]['mention'], ROLE);
check('reorder', fight_reorder([$armor, $shield], ['cabcdefabcd', 'c0123456789']), [$shield, $armor]);
check('reorder: not a permutation', [fight_reorder([$armor, $shield], ['cabcdefabcd']), fight_reorder([$armor, $shield], ['cabcdefabcd', 'cabcdefabcd']),
    fight_reorder([$armor, $shield], ['cabcdefabcd', 'c9999999999']), fight_reorder([$armor], 'x')], [null, null, null, null]);
check('find', [fight_find_comp([$armor, $shield], 'cabcdefabcd'), fight_find_comp([$armor], 'nope')], [$shield, null]);

// Storage (SQLite: load / save round trip, no table = no comps)
$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->sqliteCreateFunction('UTC_TIMESTAMP', function () { return gmdate('Y-m-d H:i:s'); }, 0);
check('load: no table yet (sqlite raises HY000, not 42S02)', (function () use ($db) { try { return fight_comps_load($db, '98000001.2'); } catch (PDOException $e) { return 'error'; } })(), 'error');
$db->exec('CREATE TABLE fork_fight_comps (maskID TEXT PRIMARY KEY, comps TEXT, updatedBy TEXT, updatedAt TEXT)');
check('load: none', fight_comps_load($db, '98000001.2'), []);
$db->prepare('INSERT INTO fork_fight_comps VALUES (?, ?, ?, ?)')->execute(['98000001.2', json_encode([$armor, $shield, ['id' => 'x']]), 'A', '2026-10-11']);
check('load: normalised', fight_comps_load($db, '98000001.2'), [$armor, $shield]);
check('load: other mask', fight_comps_load($db, '98000002.2'), []);

// ---------- the fight point (fork_rally) ----------
check('row comp: none', fight_row_comp(['compName' => null]), null);
check('row comp: stored copy, unknown colour shows green', fight_row_comp(['compID' => 'c0123456789', 'compName' => 'Armor HACs', 'compColour' => 'evil', 'compNote' => null, 'compMention' => null]),
    ['id' => 'c0123456789', 'name' => 'Armor HACs', 'colour' => 'green', 'note' => '', 'mention' => '']);
$prev = ['systemID' => 31001880, 'comp' => $armor];
check('changes: other system', fight_rally_changes($prev, 31001881, $armor), true);
check('changes: same system and comp', fight_rally_changes($prev, 31001880, $armor), false);
check('changes: other comp', fight_rally_changes($prev, 31001880, $shield), true);
check('changes: comp removed from the fight', fight_rally_changes($prev, 31001880, null), true);
check('changes: comp edited by an admin since', fight_rally_changes($prev, 31001880, ['name' => 'Armor HACs v2'] + $armor), true);
check('changes: nothing before', fight_rally_changes(null, 31001880, null), true);
check('changes: no comp both times', fight_rally_changes(['systemID' => 31001880, 'comp' => null], 31001880, null), false);

$db->exec('CREATE TABLE fork_rally (maskID TEXT PRIMARY KEY, systemID INTEGER, setBy TEXT, setAt TEXT, compID TEXT, compName TEXT, compColour TEXT, compNote TEXT, compMention TEXT)');
check('read: none', fight_rally_read($db, '98000001.2'), null);
$db->prepare("INSERT INTO fork_rally VALUES (?, ?, ?, datetime('now', '-250 seconds'), ?, ?, ?, ?, ?)")
    ->execute(['98000001.2', 31001880, 'Chribba', 'c0123456789', 'Armor HACs', 'red', 'Zealots + Sacrileges', ROLE]);
$read = fight_rally_read($db, '98000001.2');
check('read: system, who, comp copy', [$read['systemID'], $read['setBy'], $read['comp']], [31001880, 'Chribba', $armor]);
check('read: age from the database clock', $read['age'] >= 249 && $read['age'] <= 260, true);
check('public: no mention', fight_rally_public($read)['comp'], ['id' => 'c0123456789', 'name' => 'Armor HACs', 'colour' => 'red', 'note' => 'Zealots + Sacrileges']);
check('public: none', fight_rally_public(null), null);

// Removed comp: the admins remove "Armor HACs"; the fight point keeps showing it as stored (name, colour, mention)
$db->prepare('UPDATE fork_fight_comps SET comps = ? WHERE maskID = ?')->execute([json_encode([$shield]), '98000001.2']);
check('removed comp: no longer in the list', fight_find_comp(fight_comps_load($db, '98000001.2'), 'c0123456789'), null);
check('removed comp: the fight still shows it', fight_rally_read($db, '98000001.2')['comp'], $armor);
check('removed comp: the Discord message still names it', discord_rally_context(['action' => 'set', 'template' => '{comp}', 'ping' => '', 'mask' => 'Corp', 'time' => 1] + ['kind' => 'rally'],
    discord_rally_current($db, '98000001.2'))['comp'], 'Armor HACs');

// ---------- Discord: Mask Admin type ----------
$tpl = discord_default_templates();
check('default text', $tpl['rally'], "{pings} Fight here: **{labelSystem}** ({class}){withComp} — set by *{who}*\n{map}");
$base = ['kind' => 'rally', 'template' => $tpl['rally'], 'templateClear' => $tpl['rallyClear'], 'ping' => '@here', 'mask' => 'Corp', 'time' => 2000];
$label = function () { return 'AB'; };
$ctx = discord_rally_context(['action' => 'set'] + $base, ['systemID' => 31001880, 'setBy' => 'Chribba', 'comp' => $armor], $label);
$p = discord_payload($ctx);
check('message with comp and its mention (the approved text)', $p['content'], ROLE . " @here Fight here: **AB · J152820** (C5) — comp: Armor HACs — set by *Chribba*\n<" . discord_app_url() . "?system=J152820>");
check('allowed mentions: the type ping and the comp mention, from admin config only', $p['allowed_mentions'], ['parse' => ['everyone'], 'roles' => ['123456789012345678']]);
$p = discord_payload(discord_rally_context(['action' => 'set'] + $base, ['systemID' => 31001880, 'setBy' => 'Chribba', 'comp' => null], $label));
check('message without comp', $p['content'], "@here Fight here: **AB · J152820** (C5) — set by *Chribba*\n<" . discord_app_url() . "?system=J152820>");
check('without comp: only the type ping', $p['allowed_mentions'], ['parse' => ['everyone']]);
check('pings: comp mention first, each once', [discord_rally_pings('@here ' . ROLE, ROLE), discord_rally_pings('', ''), discord_rally_pings('@here', 'bogus')], [ROLE . ' @here', '', '@here']);
$hostile = ['name' => "@everyone **x** <@&999999999999999999> [l](https://e.example)", 'note' => "@here ~~n~~\n<@1>", 'mention' => ''] + $armor;
$p = discord_payload(discord_rally_context(['action' => 'set', 'ping' => '', 'template' => '{pings} {comp} | {compNote} |{withComp}'] + $base, ['systemID' => 31001880, 'setBy' => 'A', 'comp' => $hostile]));
check('comp name and note escaped: no ping, no markdown, no link', [strpos($p['content'], '@everyone'), strpos($p['content'], '<@&'), strpos($p['content'], '**x'),
    strpos($p['content'], '](http'), strpos($p['content'], '@here'), $p['allowed_mentions']], [false, false, false, false, false, ['parse' => []]]);
check('comp name escaped (exact)', $p['content'],
    "@{$zw}everyone \\*\\*x\\*\\* \\<@{$zw}&999999999999999999\\> \\[l\\]\\(https\\://e.example\\) | @{$zw}here \\~\\~n\\~\\~ \\<@{$zw}1\\> | — comp: @{$zw}everyone \\*\\*x\\*\\* \\<@{$zw}&999999999999999999\\> \\[l\\]\\(https\\://e.example\\)");
check('placeholders', array_intersect(['comp', 'compNote', 'withComp'], array_keys(discord_placeholders()['rally'])), ['comp', 'compNote', 'withComp']);

// Moved after 30 s: the old message is struck through with where it moved and the comp
$live = ['webhookID' => 5, 'messageID' => '123', 'content' => ROLE . " @here Fight here: **AB · J152820** (C5) — comp: Armor HACs — set by *Chribba*\n<https://x/>", 'postedAt' => 1000];
$plan = discord_rally_plan(discord_rally_context(['action' => 'set', 'time' => 1100] + $base, ['systemID' => 31000003, 'setBy' => 'B', 'comp' => $shield], $label), $live, 1100);
check('moved: struck old message, where to and the new comp, nobody pinged', $plan['strike']['payload'],
    ['content' => "~~Fight here: **AB · J152820** (C5) — comp: Armor HACs — set by *Chribba*~~\nMoved to **AB · " . discord_system(31000003)[0] . "** (Shield BS) by *B* at <t:1100:t>", 'allowed_mentions' => ['parse' => []]]);
check('moved: the new message pings the new comp (no mention: the type ping only)', $plan['payload']['allowed_mentions'], ['parse' => ['everyone']]);
$plan = discord_rally_plan(discord_rally_context(['action' => 'set', 'time' => 1010] + $base, ['systemID' => 31001880, 'setBy' => 'B', 'comp' => $shield], $label), $live, 1010);
check('comp changed within 30 s, no new mention (role dropped): the message is edited, nobody pinged',
    [$plan['op'], $plan['payload']['allowed_mentions'], strpos($plan['payload']['content'], 'comp: Shield BS') !== false, $plan['systemID']], ['edit', ['parse' => []], true, 31001880]);
// "Fight here (no comp)", then "Armor HACs" seconds later: its role must be pinged, and edits never notify, so a new
// message is posted (with the pings) and the old one is struck through; the same system, so "Changed to"
$noComp = ['webhookID' => 5, 'messageID' => '124', 'content' => "@here Fight here: **AB · J152820** (C5) — set by *Chribba*\n<https://x/>", 'postedAt' => 1000, 'systemID' => 31001880];
$plan = discord_rally_plan(discord_rally_context(['action' => 'set', 'time' => 1010] + $base, ['systemID' => 31001880, 'setBy' => 'Chribba', 'comp' => $armor], $label), $noComp, 1010);
check('comp with a new role within 30 s: posted with the pings, not edited', [$plan['op'], $plan['payload']['allowed_mentions'], $plan['strike']['messageID']],
    ['post', ['parse' => ['everyone'], 'roles' => ['123456789012345678']], '124']);
check('... the old message: struck, "Changed to" (same system)', $plan['strike']['payload'],
    ['content' => "~~Fight here: **AB · J152820** (C5) — set by *Chribba*~~\nChanged to **AB · J152820** (Armor HACs) by *Chribba* at <t:1010:t>", 'allowed_mentions' => ['parse' => []]]);
check('new mentions: only what the live text lacks', [discord_rally_new_mentions(['parse' => ['everyone'], 'roles' => ['123456789012345678']], $noComp['content']),
    discord_rally_new_mentions(['parse' => ['everyone'], 'roles' => ['123456789012345678']], $live['content']), discord_rally_new_mentions(['parse' => []], ''),
    discord_rally_new_mentions(['parse' => ['everyone'], 'users' => ['223456789012345678']], 'x')], [[ROLE], [], [], ['@everyone/@here', '<@223456789012345678>']]);
// Same mentions within the window (same comp, another system): still an edit
$plan = discord_rally_plan(discord_rally_context(['action' => 'set', 'time' => 1010] + $base, ['systemID' => 31000003, 'setBy' => 'B', 'comp' => $armor], $label), $live + ['systemID' => 31001880], 1010);
check('same mentions within 30 s: edited', [$plan['op'], $plan['payload']['allowed_mentions']], ['edit', ['parse' => []]]);
// Only the comp changed after the window: "Changed to"; the old message from before this version (no system): "Moved to"
$plan = discord_rally_plan(discord_rally_context(['action' => 'set', 'time' => 1100] + $base, ['systemID' => 31001880, 'setBy' => 'B', 'comp' => $shield], $label), $live + ['systemID' => 31001880], 1100);
check('comp changed after 30 s on the same system: "Changed to"', strstr($plan['strike']['payload']['content'], "\n"), "\nChanged to **AB · J152820** (Shield BS) by *B* at <t:1100:t>");
$plan = discord_rally_plan(discord_rally_context(['action' => 'set', 'time' => 1100] + $base, ['systemID' => 31001880, 'setBy' => 'B', 'comp' => null], $label), $live + ['systemID' => 31001880], 1100);
check('comp removed after 30 s on the same system: "(no comp)"', strstr($plan['strike']['payload']['content'], "\n"), "\nChanged to **AB · J152820** (no comp) by *B* at <t:1100:t>");
$plan = discord_rally_plan(discord_rally_context(['action' => 'set', 'time' => 1100] + $base, ['systemID' => 31001880, 'setBy' => 'B', 'comp' => $shield], $label), $live, 1100);
check('live message without a system (older row): "Moved to"', strpos($plan['strike']['payload']['content'], "\nMoved to **AB · J152820** (Shield BS)") !== false, true);

// The live message keeps its system (SQLite; an older table gets the column on its first write)
$lm = new PDO('sqlite::memory:');
$lm->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$lm->exec('CREATE TABLE discord_rally_message (maskID TEXT PRIMARY KEY, webhookID INTEGER, messageID TEXT, content TEXT, postedAt TEXT)');
discord_rally_remember($lm, '98000001.2', 5, '42', 'text', 1000, 31001880);
check('remember: system stored (column added)', [discord_rally_last($lm, '98000001.2')['systemID'], discord_rally_last($lm, '98000001.2')['messageID']], [31001880, '42']);
discord_rally_update($lm, '98000001.2', '42', 'edited', 31000003);
check('live edit: text and system updated', [discord_rally_last($lm, '98000001.2')['systemID'], discord_rally_last($lm, '98000001.2')['content']], [31000003, 'edited']);
$cleared = discord_payload(['previous' => $live['content']] + discord_rally_context(['action' => 'clear', 'who' => 'C', 'time' => 7] + $base, null));
check('cleared: struck, the comp mention gone', $cleared, ['content' => "~~Fight here: **AB · J152820** (C5) — comp: Armor HACs — set by *Chribba*~~\nCleared by *C* at <t:7:t>", 'allowed_mentions' => ['parse' => []]]);

// Saved texts that are an earlier default read as today's default; edited texts stay
$v117 = "{pings} Tripwire rally point from *{who}*: **{labelSystem}** ({class}, {region})\n{map}";
$v115 = "{pings} Tripwire rally point from *{who}*: **{system}** ({class}, {region})\n{map}";
check('upgrade: 1.17 default (chain label) -> Fight here default', discord_template_upgrade('rally', 'template', $v117), $tpl['rally']);
check('upgrade: 1.15 default -> Fight here default', discord_template_upgrade('rally', 'template', str_replace("\n", "\r\n", $v115) . ' '), $tpl['rally']);
check('upgrade: edited text kept', discord_template_upgrade('rally', 'template', $v117 . ' @here'), $v117 . ' @here');
[$mig] = discord_settings_normalise(['types' => ['rally' => ['template' => $v117]]], discord_settings_defaults());
check('upgrade: on load', $mig['types']['rally']['template'], $tpl['rally']);
check('upgrade: queued rows with the old default render the new text', discord_payload(discord_rally_context(['action' => 'set', 'template' => $v117] + $base,
    ['systemID' => 31001880, 'setBy' => 'C', 'comp' => $armor], $label))['content'], ROLE . " @here Fight here: **AB · J152820** (C5) — comp: Armor HACs — set by *C*\n<" . discord_app_url() . "?system=J152820>");
check('custom old-style text still gets the comp ping', discord_payload(discord_rally_context(['action' => 'set', 'template' => '{pings} Rally {system}'] + $base,
    ['systemID' => 31001880, 'setBy' => 'C', 'comp' => $armor]))['content'], ROLE . ' @here Rally J152820');

// ---------- Discord: legacy DISCORD_WEB_HOOK path (fixed texts, no pings) ----------
check('legacy: with comp', rally_discord_payload('set', 'Chribba', 'J163701 (C5, E-R00025)', 'J163701', null, 'AB', 'Armor HACs'),
    ['content' => 'Fight here: **AB · J163701 (C5, E-R00025)** — comp: Armor HACs — set by *Chribba*', 'allowed_mentions' => ['parse' => []]]);
check('legacy: hostile comp cleaned', rally_discord_payload('set', 'A', 'J1', 'J1', null, '', "@here **x** <https://e.example>")['content'],
    "Fight here: **J1** — comp: @{$zw}here \\*\\*x\\*\\* https\\://e.example — set by *A*");
check('legacy: moved with comp', rally_discord_end_payload('Fight here: **J1** — set by *A*', 'moved', 'B', 5, 'J2', 'AB', 'Shield BS')['content'],
    "~~Fight here: **J1** — set by *A*~~\nMoved to **AB · J2** (Shield BS) by *B* at <t:5:t>");
check('legacy: only the comp changed', rally_discord_end_payload('Fight here: **J2** — set by *A*', 'changed', 'B', 5, 'J2', 'AB', 'Shield BS')['content'],
    "~~Fight here: **J2** — set by *A*~~\nChanged to **AB · J2** (Shield BS) by *B* at <t:5:t>");
check('legacy: comp removed', rally_discord_end_payload('X', 'changed', 'B', 5, 'J2', '', '')['content'], "~~X~~\nChanged to **J2** (no comp) by *B* at <t:5:t>");

echo $failures ? "$failures of $count checks FAILED\n" : "$count checks passed\n";
exit($failures ? 1 : 0);
