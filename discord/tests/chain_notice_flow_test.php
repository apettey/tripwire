<?php
// Fork-owned: end-to-end "chain kills are paused" notice against the dev stack (needs its MySQL, the running Discord
// worker and the Discord mock, docker/dev/discord-mock.php). See discord/chain_notice.php.
//   docker compose -f docker-compose.dev.yml exec -T app php discord/tests/chain_notice_flow_test.php
// Uses masks 98000081.2 / 98000082.2 and webhook rows of its own; clears its rows and the mock first. Each "tick" is a
// discord_chain_notice_poll() like the worker's (the worker runs its own every 15 s too: the dedupe row makes that
// harmless), then waits until the worker has sent what was queued.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../discord.inc.php');

$mock = getenv('DISCORD_MOCK') ?: 'http://discord-mock:8080';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec("SET time_zone = '+00:00'");
discord_ensure_schema($db);

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

const CN_MASK = '98000081.2';    // chain kills on
const CN_OTHER = '98000082.2';   // chain kills off (corp losses on), no home: never a notice
const CN_CORP = 98000081;
const CN_HOOKS = ['a' => '1200000000000081001', 'b' => '1200000000000081002', 'c' => '1200000000000082001'];
$token = str_repeat('noHomeTest_', 6);

// Corporations with a Tripwire admin, three webhooks to the mock
$db->exec('DELETE FROM characters WHERE userID IN (990081, 990082)');
$db->exec('DELETE FROM accounts WHERE id IN (990081, 990082)');
foreach ([990081 => CN_CORP, 990082 => CN_CORP + 1] as $user => $corp) {
    $db->exec("INSERT INTO accounts (id, username, password) VALUES ($user, 'no-home-test-$user', 'x')");
    $db->exec("INSERT INTO characters (userID, characterID, characterName, corporationID, corporationName, admin) VALUES ($user, $user, 'No Home Admin', $corp, 'No Home Corp', 1)");
}
$rows = [];
foreach ([CN_MASK, CN_OTHER] as $mask) {
    foreach (['discord_webhooks', 'discord_settings', 'discord_sent', 'discord_outbox'] as $table) $db->prepare("DELETE FROM $table WHERE maskID = ?")->execute([$mask]);
}
foreach (CN_HOOKS as $key => $hookID) {
    $db->prepare("INSERT INTO discord_webhooks (maskID, name, url, urlHint, status, createdAt, updatedAt) VALUES (?, ?, ?, '', 'ok', UTC_TIMESTAMP(), UTC_TIMESTAMP())")
        ->execute([$key === 'c' ? CN_OTHER : CN_MASK, "#$key", discord_seal("https://discord.com/api/webhooks/$hookID/$token")]);
    $rows[$key] = (int) $db->lastInsertId();
}

/** Store a mask's settings: chain kills on/off to webhook $hook, home system $home */
function cn_settings($mask, $chainOn, $hook, $home, $corpLossHook = 0) {
    global $db;
    $s = discord_settings_defaults((int) $mask);
    $s['homeSystemID'] = $home;
    $s['types']['chainKill'] = ['enabled' => $chainOn, 'webhookID' => $hook, 'enabledAt' => $chainOn ? time() - 60 : 0] + $s['types']['chainKill'];
    if ($corpLossHook) $s['types']['corpLoss'] = ['enabled' => true, 'webhookID' => $corpLossHook, 'enabledAt' => time() - 60] + $s['types']['corpLoss'];
    $db->prepare("REPLACE INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, 'test', UTC_TIMESTAMP())")->execute([$mask, json_encode($s)]);
}

/** One worker pass (discord_notify.worker.php: dn_type_masks + discord_chain_notice_poll), then wait for the sender */
function cn_tick() {
    global $db;
    $ok = [];
    foreach ($db->query("SELECT id, maskID FROM discord_webhooks WHERE status IN ('ok', 'pending')")->fetchAll(PDO::FETCH_ASSOC) as $row) $ok[(int) $row['id']] = (string) $row['maskID'];
    $masks = array_filter(discord_active_settings($db), function ($s, $maskID) use ($ok) {
        $type = $s['types']['chainKill'];
        return $type['enabled'] && ($ok[$type['webhookID']] ?? null) === (string) $maskID;
    }, ARRAY_FILTER_USE_BOTH);
    discord_chain_notice_poll($db, $masks);
    for ($i = 0; $i < 100; $i++) {
        $n = (int) $db->query("SELECT COUNT(*) FROM discord_outbox WHERE maskID IN ('" . CN_MASK . "', '" . CN_OTHER . "') AND status = 'queued'")->fetchColumn();
        if ($n === 0) { usleep(300000); return; }
        usleep(200000);
    }
    fwrite(STDERR, "worker did not send within 20 s (is discord-notify running?)\n");
}

/** What a webhook's channel got, oldest first: [[content, allowed_mentions], ...] */
function cn_channel($key) {
    global $mock;
    $messages = json_decode((string) @file_get_contents("$mock/messages"), true) ?: [];
    $out = [];
    foreach (array_reverse($messages) as $m) {
        if ($m['webhook'] === CN_HOOKS[$key] && $m['status'] === 200) $out[] = [$m['body']['content'] ?? '', $m['body']['allowed_mentions'] ?? null];
    }
    return $out;
}

function cn_contents($key) { return array_map(function ($m) { return $m[0]; }, cn_channel($key)); }

function cn_episodes() {
    global $db;
    return $db->query("SELECT CONCAT(maskID, ' ', ref) FROM discord_sent WHERE kind = 'nohome' AND maskID IN ('" . CN_MASK . "', '" . CN_OTHER . "') ORDER BY 1")->fetchAll(PDO::FETCH_COLUMN);
}

@file_get_contents("$mock/reset");
$paused = 'Chain kills are paused: no home system is set for the **Corp** mask. An admin can set it in Tripwire > Mask Admin > Discord.';
$resumed = 'Chain kills resumed for the **Corp** mask (home: J160650).';
$home = 31000880;   // J160650

// 1. Chain kills on, no home: one notice; the other mask (chain kills off) gets nothing
cn_settings(CN_MASK, true, $rows['a'], 0);
cn_settings(CN_OTHER, false, 0, 0, $rows['c']);
cn_tick();
check('no home: one notice', cn_contents('a'), [$paused]);
check('no home: nobody pinged', cn_channel('a')[0][1] ?? null, ['parse' => []]);
check('no home: the episode is recorded', cn_episodes(), [CN_MASK . ' wh:' . $rows['a']]);
$status = discord_chain_notice_status($db, CN_MASK);
check('no home: Mask Admin sees it was posted', [$status['status'] ?? null, (bool) preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/', $status['at'] ?? '')], ['sent', true]);
check('chain kills off: no notice, no episode', [cn_contents('c'), discord_chain_notice_status($db, CN_OTHER)], [[], null]);

// 2. More ticks: no repeat
cn_tick(); cn_tick(); cn_tick();
check('repeated ticks: no repeat', cn_contents('a'), [$paused]);

// 3. Home set: the episode ends, one "resumed" message
cn_settings(CN_MASK, true, $rows['a'], $home);
cn_tick();
check('home set: resumed message', cn_contents('a'), [$paused, $resumed]);
check('home set: resumed pings nobody', cn_channel('a')[1][1] ?? null, ['parse' => []]);
check('home set: episode over', [cn_episodes(), discord_chain_notice_status($db, CN_MASK)], [[], null]);
cn_tick();
check('home set: nothing more', cn_contents('a'), [$paused, $resumed]);

// 4. Home removed again: a new notice, once
cn_settings(CN_MASK, true, $rows['a'], 0);
cn_tick(); cn_tick();
check('home removed again: a new notice', cn_contents('a'), [$paused, $resumed, $paused]);

// 5. Chain kills turned off while paused: the episode ends without a message
cn_settings(CN_MASK, false, $rows['a'], 0, $rows['a']);
cn_tick();
check('chain kills off: nothing posted, episode over', [cn_contents('a'), cn_episodes()], [[$paused, $resumed, $paused], []]);

// 6. On again without a home, to another channel: a notice there; moving it ends the old episode silently
cn_settings(CN_MASK, true, $rows['a'], 0);
cn_tick();
cn_settings(CN_MASK, true, $rows['b'], 0);
cn_tick(); cn_tick();
check('other channel: notice there, nothing more on the first', [cn_contents('a'), cn_contents('b'), cn_episodes()],
    [[$paused, $resumed, $paused, $paused], [$paused], [CN_MASK . ' wh:' . $rows['b']]]);

// 7. A long episode is not pruned (a weekly repeat would be noise), other old dedupe rows are
$db->exec("UPDATE discord_sent SET createdAt = UTC_TIMESTAMP() - INTERVAL 30 DAY WHERE maskID = '" . CN_MASK . "'");
$db->prepare("INSERT INTO discord_sent (maskID, kind, ref, createdAt) VALUES (?, 'kill:chainKill', '1', UTC_TIMESTAMP() - INTERVAL 30 DAY)")->execute([CN_MASK]);
discord_outbox_prune($db);
check('prune: episode kept, old kill dedupe gone', $db->query("SELECT kind FROM discord_sent WHERE maskID = '" . CN_MASK . "' ORDER BY kind")->fetchAll(PDO::FETCH_COLUMN), ['nohome']);
cn_tick();
check('prune: still no repeat after a month', cn_contents('b'), [$paused]);
$db->exec("DELETE FROM discord_outbox WHERE maskID = '" . CN_MASK . "'");   // sent rows are pruned after 7 days
check('prune: Mask Admin falls back to the episode start once the message row is gone', discord_chain_notice_status($db, CN_MASK)['status'] ?? null, 'old');

// 8. The mask can no longer send (its corporation lost its last admin): the episode ends quietly
$db->exec('UPDATE characters SET admin = 0 WHERE userID = 990081');
cn_tick();
check('no admin left: episode over, nothing posted', [cn_episodes(), cn_contents('b')], [[], [$paused]]);

// Clean up
foreach ([CN_MASK, CN_OTHER] as $mask) {
    foreach (['discord_webhooks', 'discord_settings', 'discord_sent', 'discord_outbox'] as $table) $db->prepare("DELETE FROM $table WHERE maskID = ?")->execute([$mask]);
}
$db->exec('DELETE FROM characters WHERE userID IN (990081, 990082)');
$db->exec('DELETE FROM accounts WHERE id IN (990081, 990082)');

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
