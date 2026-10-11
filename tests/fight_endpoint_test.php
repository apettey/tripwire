<?php
// Fork-owned: "Fight here" end to end against the dev stack (needs its MySQL, nginx/PHP in the app container, the
// dev login from docker/dev-seed.sh, the running Discord worker and the Discord mock, docker/dev/discord-mock.php).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/fight_endpoint_test.php
// 1. public/fight.php: reading the comps, the admin checks (non-admin 403), CSRF / X-Requested-With / Origin / JSON,
//    validation, reorder, remove.
// 2. public/rally.php: setting the fight point with a comp (looked up on the server), unknown comps, a removed comp
//    staying on the fight.
// 3. Discord: the "Fight here" type of the dev corp mask posting to the mock: set with a comp (comp + mention), moved
//    within 30 s (the message edited), cleared (struck through). Prints the captured payloads.
// Logs in as the dev user (DEV_USERNAME / DEV_PASSWORD, as docker/dev-seed.sh); flips its characters.admin flag for the
// non-admin checks. Everything it changes on the dev corp mask (admin flag, comps, fight point, live Discord messages,
// Discord settings) is snapshotted first and put back when it ends; its own webhook and outbox rows are deleted.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../discord/discord.inc.php');

$base = getenv('FIGHT_BASE') ?: 'http://127.0.0.1';
$mock = getenv('DISCORD_MOCK') ?: 'http://discord-mock:8080';
$user = getenv('DEV_USERNAME') ?: 'dev';
$password = getenv('DEV_PASSWORD') ?: 'dev-password';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

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

/** One HTTP request with a cookie jar: [status, decoded JSON body] */
function http($method, $path, $jar, $body = null, array $headers = []) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar,
        CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$status, json_decode((string) $text, true)];
}
function login($jar) {
    global $user, $password;
    @unlink($jar);
    [$status, $out] = http('POST', 'login.php', $jar, http_build_query(['mode' => 'login', 'username' => $user, 'password' => $password]));
    if (($out['result'] ?? '') !== 'success') { fwrite(STDERR, "login failed (run docker/dev-seed.sh first)\n"); exit(1); }
    return $out['session'];
}
function fight_post($jar, $csrf, array $data, array $extra = []) {
    $headers = array_merge(['Content-Type: application/json', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf], $extra);
    return http('POST', 'fight.php', $jar, json_encode($data), $headers);
}
function rally_post($jar, array $data) {
    return http('POST', 'rally.php', $jar, http_build_query($data), ['X-Requested-With: XMLHttpRequest']);
}

$jar = sys_get_temp_dir() . '/fight-admin.cookies';
$jarMember = sys_get_temp_dir() . '/fight-member.cookies';
$stmt = $db->prepare('SELECT c.characterID, c.corporationID FROM accounts a INNER JOIN characters c ON c.userID = a.id WHERE a.username = ?');
$stmt->execute([$user]);
$me = $stmt->fetch(PDO::FETCH_ASSOC);
$mask = $me['corporationID'] . '.2';
fight_ensure_schema($db);
fight_rally_ensure_table($db);
discord_ensure_schema($db);

// Snapshot everything this test changes for the dev mask, put back when it ends (also after a failure): the admin flag,
// the comps, the fight point, the live Discord messages and the Discord settings. Its own webhook and the outbox rows
// queued for it are deleted.
$stmt = $db->prepare('SELECT admin FROM characters WHERE characterID = ?');
$stmt->execute([$me['characterID']]);
$savedAdmin = (int) $stmt->fetchColumn();
$snapshotTables = ['fork_fight_comps', 'fork_rally', 'discord_rally_message', 'fork_rally_discord_message', 'discord_settings'];
$snapshot = [];
foreach ($snapshotTables as $table) {
    try {
        $stmt = $db->prepare("SELECT * FROM $table WHERE maskID = ?");
        $stmt->execute([$mask]);
        $snapshot[$table] = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $e) { /* table not created yet */ }
}
$webhookRow = 0;
register_shutdown_function(function () use ($db, $mask, $me, $savedAdmin, &$snapshot, &$webhookRow) {
    $db->prepare('UPDATE characters SET admin = ? WHERE characterID = ?')->execute([$savedAdmin, $me['characterID']]);
    foreach ($snapshot as $table => $rows) {
        $db->prepare("DELETE FROM $table WHERE maskID = ?")->execute([$mask]);
        foreach ($rows as $row) {
            $columns = array_keys($row);
            $db->prepare("INSERT INTO $table (" . implode(', ', $columns) . ') VALUES (' . implode(', ', array_fill(0, count($columns), '?')) . ')')
                ->execute(array_values($row));
        }
    }
    if ($webhookRow) {
        $db->prepare('DELETE FROM discord_outbox WHERE webhookID = ?')->execute([$webhookRow]);
        $db->prepare('DELETE FROM discord_webhooks WHERE id = ?')->execute([$webhookRow]);
    }
    echo "(dev mask put back as it was)\n";
});

$db->prepare('UPDATE characters SET admin = 1 WHERE characterID = ?')->execute([$me['characterID']]);
$db->prepare('DELETE FROM fork_fight_comps WHERE maskID = ?')->execute([$mask]);
$db->prepare('DELETE FROM fork_rally WHERE maskID = ?')->execute([$mask]);

// ---------- 1. fight.php as an admin ----------
$session = login($jar);
check('logged in on the corp mask', (string) $session['mask'], $mask);
[$status, $state] = http('GET', 'fight.php?mode=get', $jar);
check('admin: can edit, gets a CSRF token, the palette and limits', [$status, $state['available'], $state['canEdit'], strlen($state['csrf'] ?? ''), array_keys($state['palette']), $state['limits']],
    [200, true, true, 64, ['green', 'red', 'orange', 'yellow', 'blue', 'purple', 'pink', 'cyan', 'white'], ['comps' => 20, 'name' => 40, 'note' => 140]]);
$csrf = $state['csrf'];
$armor = ['name' => 'Armor HACs', 'colour' => 'red', 'note' => 'Zealots + Sacrileges, links in fleet', 'mention' => '<@&123456789012345678>'];

check('no CSRF token: 403', fight_post($jar, '', ['mode' => 'comp-save', 'comp' => $armor])[0], 403);
check('wrong CSRF token: 403', fight_post($jar, str_repeat('0', 64), ['mode' => 'comp-save', 'comp' => $armor])[0], 403);
check('no X-Requested-With: 400', http('POST', 'fight.php', $jar, json_encode(['mode' => 'comp-save', 'comp' => $armor]), ['Content-Type: application/json', 'X-CSRF-Token: ' . $csrf])[0], 400);
check('a form post (not JSON): 415', http('POST', 'fight.php', $jar, 'mode=comp-save', ['Content-Type: application/x-www-form-urlencoded', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf])[0], 415);
check('another origin: 403', fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => $armor], ['Origin: https://evil.example'])[0], 403);
check('unknown mode: 400', fight_post($jar, $csrf, ['mode' => 'drop-table'])[0], 400);
check('PUT: 405', http('PUT', 'fight.php', $jar)[0], 405);
check('nothing saved by refused requests', http('GET', 'fight.php', $jar)[1]['comps'], []);

[$status, $out] = fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => $armor], ['Origin: http://127.0.0.1']);
$armorID = $out['id'] ?? '';
check('add a comp (same origin)', [$status, count($out['comps']), $out['comps'][0]['name'], $out['comps'][0]['mention'], (bool) preg_match('/^c[0-9a-f]{10}$/', $armorID)], [200, 1, 'Armor HACs', '<@&123456789012345678>', true]);
[$status, $out] = fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => ['name' => 'Shield BS', 'colour' => 'blue']]);
$shieldID = $out['id'] ?? '';
check('add a second comp', [$status, array_column($out['comps'], 'name')], [200, ['Armor HACs', 'Shield BS']]);
[$status, $out] = fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => ['name' => 'x', 'colour' => '#123456', 'note' => str_repeat('n', 141), 'mention' => '@armor']]);
check('validation: colour, note, mention', [$status, $out['errors']], [400, ['Pick one of the colours', 'The note can be at most 140 characters', 'The Discord mention may only contain <@&roleID>, <@userID>, @here or @everyone']]);
check('validation: name too long', fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => ['name' => str_repeat('n', 41), 'colour' => 'red']])[1]['error'], 'The name can be at most 40 characters');
check('validation: duplicate name', fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => ['name' => 'shield bs', 'colour' => 'red']])[1]['error'], 'There is already a comp called "Shield BS"');
check('edit a removed comp: 404', fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => ['id' => 'c9999999999', 'name' => 'Ghost', 'colour' => 'red']])[0], 404);
[$status, $out] = fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => ['id' => $shieldID, 'name' => 'Shield Battleships', 'colour' => 'cyan']]);
check('edit keeps the id and place', [$status, $out['id'], array_column($out['comps'], 'name'), $out['comps'][1]['colour']], [200, $shieldID, ['Armor HACs', 'Shield Battleships'], 'cyan']);
[$status, $out] = fight_post($jar, $csrf, ['mode' => 'comp-order', 'ids' => [$shieldID, $armorID]]);
check('reorder', [$status, array_column($out['comps'], 'name')], [200, ['Shield Battleships', 'Armor HACs']]);
check('reorder with a stale list: 409', fight_post($jar, $csrf, ['mode' => 'comp-order', 'ids' => [$armorID]])[0], 409);
for ($i = 3; $i <= 20; $i++) fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => ['name' => "Comp $i", 'colour' => 'white']]);
[$status, $out] = fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => ['name' => 'Comp 21', 'colour' => 'white']]);
check('at most 20 comps', [$status, $out['error']], [400, 'At most 20 fleet comps per mask']);
foreach (http('GET', 'fight.php', $jar)[1]['comps'] as $c) {
    if (strpos($c['name'], 'Comp ') === 0) fight_post($jar, $csrf, ['mode' => 'comp-delete', 'id' => $c['id']]);
}
check('remove', array_column(http('GET', 'fight.php', $jar)[1]['comps'], 'name'), ['Shield Battleships', 'Armor HACs']);
check('remove an unknown comp: 404', fight_post($jar, $csrf, ['mode' => 'comp-delete', 'id' => 'c9999999999'])[0], 404);

// ---------- 2. rally.php (the fight point) with comps ----------
[$status, $out] = http('GET', 'rally.php', $jar);
check('rally.php: everyone gets the comps, without mentions', [$status, $out['comps'][1]['name'], array_key_exists('mention', $out['comps'][1]), $out['rally']], [200, 'Armor HACs', false, null]);
[$status, $out] = rally_post($jar, ['mode' => 'set', 'systemID' => 31001880, 'compID' => $armorID]);
check('set with a comp', [$status, $out['rally']['systemID'], $out['rally']['comp'], $out['rally']['age'] <= 2, array_key_exists('mention', $out['rally']['comp'])],
    [200, 31001880, ['id' => $armorID, 'name' => 'Armor HACs', 'colour' => 'red', 'note' => 'Zealots + Sacrileges, links in fleet'], true, false]);
check('set with an unknown comp: 400, nothing changed', [rally_post($jar, ['mode' => 'set', 'systemID' => 31000005, 'compID' => 'c9999999999'])[0], http('GET', 'rally.php', $jar)[1]['rally']['systemID']], [400, 31001880]);
check('the browser cannot name its own comp', rally_post($jar, ['mode' => 'set', 'systemID' => 31001880, 'compID' => $armorID, 'compName' => 'Hacked', 'compColour' => 'evil'])[1]['rally']['comp']['name'], 'Armor HACs');
check('a change without X-Requested-With: 400', http('POST', 'rally.php', $jar, 'mode=clear')[0], 400);
// The admins remove the comp: the fight point keeps it until it is cleared or moved
fight_post($jar, $csrf, ['mode' => 'comp-delete', 'id' => $armorID]);
[$status, $out] = http('GET', 'rally.php', $jar);
check('removed comp: gone from the list, still on the fight', [array_column($out['comps'], 'name'), $out['rally']['comp']['name'], $out['rally']['comp']['colour']], [['Shield Battleships'], 'Armor HACs', 'red']);
check('removed comp: moving the fight without a comp drops it', rally_post($jar, ['mode' => 'set', 'systemID' => 31000005])[1]['rally']['comp'], null);
check('clear', rally_post($jar, ['mode' => 'clear'])[1]['rally'], null);

// ---------- 1b. a member who is not an admin ----------
$db->prepare('UPDATE characters SET admin = 0 WHERE characterID = ?')->execute([$me['characterID']]);
login($jarMember);
[$status, $out] = http('GET', 'fight.php?mode=get', $jarMember);
check('member: reads the comps, no CSRF token, no mentions', [$status, $out['canEdit'], isset($out['csrf']), array_column($out['comps'], 'name'), array_key_exists('mention', $out['comps'][0])],
    [200, false, false, ['Shield Battleships'], false]);
check('member: a change is refused (403), even with the admin\'s token', fight_post($jarMember, $csrf, ['mode' => 'comp-save', 'comp' => ['name' => 'Mine', 'colour' => 'red']]), [403, ['error' => 'Only your corporation\'s Tripwire admins can change the fleet comps']]);
check('member: Mask Admin > Discord refused too', http('GET', 'discord.php?mode=get', $jarMember)[0], 403);
check('member: can still set the fight point with a comp', rally_post($jarMember, ['mode' => 'set', 'systemID' => 31001880, 'compID' => $shieldID])[1]['rally']['comp']['name'], 'Shield Battleships');
rally_post($jarMember, ['mode' => 'clear']);
$db->prepare('UPDATE characters SET admin = 1 WHERE characterID = ?')->execute([$me['characterID']]);

// ---------- 3. Discord: set with a comp, move within 30 s, clear ----------
// The mask's "Fight here" type on a webhook to the mock (DISCORD_API_BASE), pinging @here; Armor HACs pings a role
[, $armorOut] = fight_post($jar, $csrf, ['mode' => 'comp-save', 'comp' => $armor]);
$armorID = $armorOut['id'];
$hookID = '1200000000000081000';
$token = str_repeat('fightTest_', 7);
$db->prepare("DELETE FROM discord_webhooks WHERE maskID = ? AND name = 'fight-test'")->execute([$mask]);
$db->prepare("INSERT INTO discord_webhooks (maskID, name, url, urlHint, status, createdAt, updatedAt) VALUES (?, 'fight-test', ?, '', 'ok', UTC_TIMESTAMP(), UTC_TIMESTAMP())")
    ->execute([$mask, discord_seal("https://discord.com/api/webhooks/$hookID/$token")]);
$webhookRow = (int) $db->lastInsertId();
$settings = discord_settings_defaults((int) $me['corporationID']);
// Stored with the 1.17 default text: it must read as today's default
$settings['types']['rally'] = ['enabled' => true, 'webhookID' => $webhookRow, 'ping' => '@here', 'enabledAt' => time() - 60,
    'template' => "{pings} Tripwire rally point from *{who}*: **{labelSystem}** ({class}, {region})\n{map}"] + $settings['types']['rally'];
$db->prepare("INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, 'fight-test', UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE settings = VALUES(settings)")->execute([$mask, json_encode($settings)]);
$db->prepare('DELETE FROM discord_rally_message WHERE maskID = ?')->execute([$mask]);
@file_get_contents("$mock/reset");

function outbox_last() {
    global $db, $mask;
    $stmt = $db->prepare('SELECT COALESCE(MAX(id), 0) FROM discord_outbox WHERE maskID = ?');
    $stmt->execute([$mask]);
    return (int) $stmt->fetchColumn();
}
/** Wait until rally.php has queued the change (it does so after answering) and the worker has sent everything */
function flush_outbox($after) {
    global $db, $mask;
    for ($i = 0; $i < 100; $i++) {
        $stmt = $db->prepare("SELECT COUNT(*) FROM discord_outbox WHERE maskID = ? AND status = 'queued'");
        $stmt->execute([$mask]);
        if (outbox_last() > $after && (int) $stmt->fetchColumn() === 0) { usleep(300000); return; }
        usleep(200000);
    }
    fwrite(STDERR, "worker did not send within 20 s (is discord-notify running?)\n");
}
function mock_requests() {
    global $mock, $hookID;
    $all = json_decode((string) @file_get_contents("$mock/messages"), true) ?: [];
    return array_values(array_reverse(array_filter($all, function ($m) use ($hookID) { return $m['webhook'] === $hookID; })));
}

$last = outbox_last();
[$status, $out] = rally_post($jar, ['mode' => 'set', 'systemID' => 31001880, 'compID' => $armorID, 'discord' => '1']);
check('discord: the mask posts', [$status, $out['discord']], [200, true]);
flush_outbox($last);
$last = outbox_last();
rally_post($jar, ['mode' => 'set', 'systemID' => 31002012, 'compID' => $shieldID, 'discord' => '1']);   // moved within 30 s, other comp
flush_outbox($last);
$last = outbox_last();
rally_post($jar, ['mode' => 'clear', 'discord' => '1']);
flush_outbox($last);
$requests = mock_requests();
$appUrl = discord_app_url();
$j1 = discord_system(31001880)[0];
$j2 = discord_system(31002012)[0];
$c1 = discord_system_class(31001880);
$c2 = discord_system_class(31002012);
check('discord: one post, two edits', array_column($requests, 'method'), ['POST', 'PATCH', 'PATCH']);
check('discord: the post names the comp and pings its role and @here', [$requests[0]['body']['content'] ?? null, $requests[0]['body']['allowed_mentions'] ?? null],
    ["<@&123456789012345678> @here Fight here: **$j1** ($c1) — comp: Armor HACs — set by *" . $session['characterName'] . "*\n<{$appUrl}?system=$j1>",
     ['parse' => ['everyone'], 'roles' => ['123456789012345678']]]);
check('discord: moved within 30 s edits the message with the new comp, nobody pinged', [$requests[1]['message'] === $requests[0]['message'],
    $requests[1]['body']['content'] ?? null, $requests[1]['body']['allowed_mentions'] ?? null],
    [true, "@here Fight here: **$j2** ($c2) — comp: Shield Battleships — set by *" . $session['characterName'] . "*\n<{$appUrl}?system=$j2>", ['parse' => []]]);
check('discord: clear strikes the message through', [$requests[2]['message'] === $requests[0]['message'],
    preg_replace('/<t:\d+:t>/', '<t:…:t>', $requests[2]['body']['content'] ?? ''), $requests[2]['body']['allowed_mentions'] ?? null],
    [true, "~~Fight here: **$j2** ($c2) — comp: Shield Battleships — set by *" . $session['characterName'] . "*~~\nCleared by *" . $session['characterName'] . '* at <t:…:t>', ['parse' => []]]);
// "Fight here (no comp)", then Armor HACs a few seconds later: its role is pinged by a new message (an edit wouldn't
// notify), and the first message is struck through with "Changed to" (same system)
$last = outbox_last();
rally_post($jar, ['mode' => 'set', 'systemID' => 31001880, 'discord' => '1']);
flush_outbox($last);
$last = outbox_last();
rally_post($jar, ['mode' => 'set', 'systemID' => 31001880, 'compID' => $armorID, 'discord' => '1']);
flush_outbox($last);
for ($i = 0; $i < 50 && count(mock_requests()) < 6; $i++) usleep(200000);   // the strike is queued after the post
$requests = mock_requests();
check('discord: no comp, then a comp with a role within 30 s: post, post, strike', array_column(array_slice($requests, 3), 'method'), ['POST', 'POST', 'PATCH']);
check('discord: the second post pings the role', $requests[4]['body']['allowed_mentions'] ?? null, ['parse' => ['everyone'], 'roles' => ['123456789012345678']]);
check('discord: the first message is struck "Changed to"', [$requests[5]['message'] === $requests[3]['message'],
    preg_replace('/<t:\d+:t>/', '<t:…:t>', $requests[5]['body']['content'] ?? '')],
    [true, "~~Fight here: **$j1** ($c1) — set by *" . $session['characterName'] . "*~~\nChanged to **$j1** (Armor HACs) by *" . $session['characterName'] . '* at <t:…:t>']);
rally_post($jar, ['mode' => 'clear']);

echo "\n### Captured Discord requests (discord-mock)\n";
foreach ($requests as $r) echo $r['method'] . ' /api/webhooks/' . $r['webhook'] . '/…' . ($r['method'] === 'PATCH' ? '/messages/' . $r['message'] : '?' . $r['query']) . "\n"
    . json_encode($r['body'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";

// The dev mask is put back by the shutdown function registered at the start
@unlink($jar);
@unlink($jarMember);

echo $failures ? "\n$failures of $count checks FAILED\n" : "\n$count checks passed\n";
exit($failures ? 1 : 0);
