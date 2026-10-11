<?php
// Fork-owned: the "Preserve mass" Discord type end to end against the dev stack: public/preserve_mass.php over HTTP
// (dev login from docker/dev-seed.sh, nginx/PHP in the app container), the outbox, the running Discord worker and the
// Discord mock (docker/dev/discord-mock.php). Prints the channel (the mock's GET /channel) after each sequence and checks it.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/preserve_mass_discord_flow_test.php
// Works on the dev user's corporation mask: its own two wormholes (J163701 home <-> J152820 in the chain, and
// J115405 <-> J105246 outside it) and its own webhook; the mask's Discord settings, preserve mass flags and live preserve
// mass messages are snapshotted first and put back at the end. "After 30 s" is simulated by moving the stored post time
// of the message back. Each change waits for the 10 s debounce, so the whole run takes a few minutes.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../discord/discord.inc.php');
require_once(__DIR__ . '/../preserve_mass.inc.php');

$base = getenv('FLOW_BASE') ?: 'http://127.0.0.1';
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
function mock($path) {
    global $mock;
    $body = @file_get_contents($mock . $path);
    return $body === false ? null : json_decode($body, true);
}

$stmt = $db->prepare('SELECT c.characterID, c.characterName, c.corporationID FROM accounts a INNER JOIN characters c ON c.userID = a.id WHERE a.username = ?');
$stmt->execute([$user]);
$me = $stmt->fetch(PDO::FETCH_ASSOC);
if (!$me) { fwrite(STDERR, "no dev user (run docker/dev-seed.sh first)\n"); exit(1); }
$mask = $me['corporationID'] . '.2';
discord_ensure_schema($db);
preserve_mass_ensure_table($db);

// Snapshot what this test changes, put back at the end (also after a failure)
$stmt = $db->prepare('SELECT admin FROM characters WHERE characterID = ?');
$stmt->execute([$me['characterID']]);
$savedAdmin = (int) $stmt->fetchColumn();
$snapshot = [];
foreach (['discord_settings', 'fork_preserve_mass', 'discord_preserve_message'] as $table) {
    $stmt = $db->prepare("SELECT * FROM $table WHERE maskID = ?");
    $stmt->execute([$mask]);
    $snapshot[$table] = $stmt->fetchAll(PDO::FETCH_ASSOC);
}
$webhookRow = 0;
$created = ['signatures' => [], 'wormholes' => []];
register_shutdown_function(function () use ($db, $mask, $me, $savedAdmin, &$snapshot, &$webhookRow, &$created) {
    $db->prepare('UPDATE characters SET admin = ? WHERE characterID = ?')->execute([$savedAdmin, $me['characterID']]);
    foreach ($created['wormholes'] as $id) $db->prepare('DELETE FROM wormholes WHERE id = ?')->execute([$id]);
    foreach ($created['signatures'] as $id) $db->prepare('DELETE FROM signatures WHERE id = ?')->execute([$id]);
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

/** A wormhole of the dev mask: the H296 scanned in $b (K162 seen from $a); never expires (lifeLength 0) */
function hole($a, $b) {
    global $db, $mask, $created;
    $ids = [];
    foreach ([$a, $b] as $i => $systemID) {
        $db->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, maskID)
            VALUES (?, ?, 'wormhole', '', 0, 1, 'flow', 1, 'flow', ?)")->execute([$i ? 'pmf002' : 'pmf001', $systemID, $mask]);
        $ids[] = $created['signatures'][] = (int) $db->lastInsertId();
    }
    $db->prepare("INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (?, ?, 'H296', 'secondary', 'stable', 'stable', ?)")
        ->execute([$ids[0], $ids[1], $mask]);
    return $created['wormholes'][] = (int) $db->lastInsertId();
}
$J163701 = 31002012; $J152820 = 31001880; $J115405 = 31000005 + 0; $J105246 = 0;
foreach (range(31000001, 31002604) as $id) { $s = discord_system($id); if ($s && $s[0] === 'J115405') $J115405 = $id; if ($s && $s[0] === 'J105246') $J105246 = $id; }
$inChain = hole($J163701, $J152820);
$outside = hole($J115405, $J105246);

// The mask's "Preserve mass" type on a webhook to the mock, pinging @here, home J163701, only the chain
$hookID = '1200000000000091000';
$token = str_repeat('preserveT_', 7);
$db->prepare("INSERT INTO discord_webhooks (maskID, name, url, urlHint, status, createdAt, updatedAt) VALUES (?, 'preserve-test', ?, '', 'ok', UTC_TIMESTAMP(), UTC_TIMESTAMP())")
    ->execute([$mask, discord_seal("https://discord.com/api/webhooks/$hookID/$token")]);
$webhookRow = (int) $db->lastInsertId();
$settings = discord_settings_defaults((int) $me['corporationID']);
$settings['homeSystemID'] = $J163701;
$settings['types']['preserveMass'] = ['enabled' => true, 'webhookID' => $webhookRow, 'ping' => '@here', 'enabledAt' => time() - 60] + $settings['types']['preserveMass'];
$db->prepare("INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, 'preserve-test', UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE settings = VALUES(settings)")->execute([$mask, json_encode($settings)]);

$jar = sys_get_temp_dir() . '/preserve-flow.cookies';
@unlink($jar);
[, $login] = http('POST', 'login.php', $jar, http_build_query(['mode' => 'login', 'username' => $user, 'password' => $password]));
if (($login['result'] ?? '') !== 'success') { fwrite(STDERR, "login failed (run docker/dev-seed.sh first)\n"); exit(1); }
check('logged in on the corp mask', (string) $login['session']['mask'], $mask);

function pm_mark($wormholeID, $reason = '') { global $jar; return http('POST', 'preserve_mass.php', $jar, http_build_query(['mode' => 'set', 'wormholeID' => $wormholeID, 'reason' => $reason]), ['X-Requested-With: XMLHttpRequest']); }
function pm_unmark($wormholeID) { global $jar; return http('POST', 'preserve_mass.php', $jar, http_build_query(['mode' => 'clear', 'wormholeID' => $wormholeID]), ['X-Requested-With: XMLHttpRequest']); }
function queued() {
    global $db, $mask;
    $stmt = $db->prepare("SELECT COUNT(*) FROM discord_outbox WHERE maskID = ? AND status = 'queued' AND kind LIKE 'preserveMass%'");
    $stmt->execute([$mask]);
    return (int) $stmt->fetchColumn();
}
/** Wait for what a change queues (after the endpoint's response, up to 2 s); the number of queued rows */
function pm_queued_soon() {
    for ($i = 0; $i < 20 && queued() === 0; $i++) usleep(100000);
    return queued();
}
/** Wait until the worker has handled every queued preserve mass message of the mask (each waits 10 s) */
function pm_flush() {
    pm_queued_soon();
    for ($i = 0; $i < 150; $i++) {
        if (queued() === 0) { usleep(300000); return; }
        usleep(200000);
    }
    fwrite(STDERR, "worker did not send within 30 s (is discord-notify running?)\n");
}
function reset_all() {
    global $db, $mask, $inChain, $outside;
    foreach ([$inChain, $outside] as $id) preserve_mass_clear($db, $mask, $id);
    $db->prepare('DELETE FROM discord_preserve_message WHERE maskID = ?')->execute([$mask]);
    $db->prepare("DELETE FROM discord_outbox WHERE maskID = ? AND kind LIKE 'preserveMass%'")->execute([$mask]);
    mock('/reset');
}
/** Pretend the hole's message was posted / struck $seconds ago */
function age($seconds) {
    global $db, $mask;
    $db->prepare('UPDATE discord_preserve_message SET postedAt = postedAt - INTERVAL ' . (int) $seconds . ' SECOND, clearedAt = clearedAt - INTERVAL ' . (int) $seconds . ' SECOND WHERE maskID = ?')->execute([$mask]);
}
/** The channel: [[content, pinged when posted, edited], ...], oldest first; times shown as <t:…> */
function channel($title) {
    $out = [];
    echo "\n### $title\n";
    foreach (mock('/channel') ?: [] as $m) {
        $pinged = !empty($m['pinged']['parse']) || !empty($m['pinged']['roles']) || !empty($m['pinged']['users']);
        $content = preg_replace('/<t:\d+:t>/', '<t:…:t>', $m['content']);
        echo '- ' . str_replace("\n", "\n  ", $content) . ($m['edited'] ? '  (edited)' : '') . ($pinged ? '  [pinged]' : '') . "\n";
        $out[] = [$content, $pinged, $m['edited']];
        if ($m['edited'] && isset($m['editAllowedMentions'])) check("$title: an edit never pings", $m['editAllowedMentions'], ['parse' => []]);
    }
    return $out;
}

$who = $me['characterName'];
$app = discord_app_url();
$live = function ($reason, $by = null) use ($who, $app) {
    return "@here Preserve mass on **J163701 ↔ J152820** (K162, C5) by *" . ($by ?? $who) . '*' . ($reason !== '' ? ": $reason" : '') . "\n<{$app}?system=J163701>";
};
$struck = function ($reason, $by = null) use ($who) {
    return '~~Preserve mass on **J163701 ↔ J152820** (K162, C5) by *' . ($by ?? $who) . '*' . ($reason !== '' ? ": $reason" : '') . '~~';
};

reset_all();
[$status, $out] = pm_mark($inChain, 'home static');
check('mark: the endpoint answers at once', [$status, $out['result'], count($out['flags'])], [200, true, 1]);
check('mark: queued on the server, waiting for the debounce', pm_queued_soon(), 1);
$stmt = $db->prepare("SELECT TIMESTAMPDIFF(SECOND, createdAt, nextAttemptAt) FROM discord_outbox WHERE maskID = ? AND kind = 'preserveMass' AND status = 'queued'");
$stmt->execute([$mask]);
check('mark: due 10 s after it was queued, from the insert on', (int) $stmt->fetchColumn(), DISCORD_PRESERVE_DELAY);
pm_flush();
check('mark: posted with the pings', channel('mark'), [[$live('home static'), true, false]]);
pm_mark($inChain, 'home static');
pm_flush();
check('the same mark again: nothing new (the server sees no change)', [count(mock('/messages')), channel('same mark again')], [1, [[$live('home static'), true, false]]]);
pm_mark($inChain, 'fleet out');
pm_flush();
check('changed within 30 s: edited', channel('changed within 30 s'), [[$live('fleet out'), true, true]]);
pm_unmark($inChain);
pm_flush();
check('cleared: struck through', channel('cleared'), [[$struck('fleet out') . "\nCleared by *$who* at <t:…:t>", true, true]]);
pm_mark($inChain, 'fleet out');
pm_flush();
check('marked again within 30 s of the clear: the message comes back', channel('marked again soon'), [[$live('fleet out'), true, true]]);
age(60);
pm_mark($inChain, 'rolling the static');
pm_flush();
check('changed after 30 s: a new message, the old one says so', channel('changed after 30 s'),
    [[$struck('fleet out') . "\nChanged by *$who* at <t:…:t>", true, true], [$live('rolling the static'), true, false]]);
age(60);
pm_unmark($inChain);
pm_flush();
age(60);
pm_mark($inChain, '');
pm_flush();
check('cleared, then marked again later: struck, and a new message', channel('cleared, marked again later'), [
    [$struck('fleet out') . "\nChanged by *$who* at <t:…:t>", true, true],
    [$struck('rolling the static') . "\nCleared by *$who* at <t:…:t>", true, true],
    [$live(''), true, false]]);

// A marked hole that is deleted from the map (collapsed): the worker's prune pass strikes its message, once
reset_all();
$doomed = hole($J163701, $J152820);
pm_mark($doomed, 'closing it');
pm_flush();
$db->prepare('DELETE FROM wormholes WHERE id = ?')->execute([$doomed]);
$db->prepare('DELETE FROM discord_sent WHERE maskID = ? AND kind = ?')->execute([$mask, 'pmGone']);
check('hole gone: the prune pass queues one clear', [discord_preserve_clear_gone($db), discord_preserve_clear_gone($db)], [1, 0]);
pm_flush();
check('hole gone: struck through, nobody pinged', channel('hole gone from the map'),
    [['~~Preserve mass on **J163701 ↔ J152820** (K162, C5) by *' . $who . "*: closing it~~\nCleared by *Tripwire \\(the hole is gone from the map\\)* at <t:…:t>", true, true]]);
check('hole gone: not again on the next pass', discord_preserve_clear_gone($db), 0);
$db->prepare('DELETE FROM discord_sent WHERE maskID = ? AND kind = ?')->execute([$mask, 'pmGone']);
check('hole gone: ... even without the claim (the message is struck now)', discord_preserve_clear_gone($db), 0);

reset_all();
pm_mark($inChain, 'x');
pm_unmark($inChain);
pm_mark($inChain, 'y');
pm_unmark($inChain);
pm_flush();
check('toggled four times within the debounce: nothing posted', [channel('toggled quickly'), mock('/messages')], [[], []]);

reset_all();
pm_mark($outside, 'old chain');
pm_flush();
check('outside the chain: nothing posted', channel('a hole outside the chain'), []);
$settings['types']['preserveMass']['chainOnly'] = false;
$db->prepare('UPDATE discord_settings SET settings = ? WHERE maskID = ?')->execute([json_encode($settings), $mask]);
pm_unmark($outside);
pm_mark($outside, 'old chain');
pm_flush();
check('chain option off: posted', count(channel('chain option off')), 1);

reset_all();
$settings['types']['preserveMass']['enabled'] = false;
$db->prepare('UPDATE discord_settings SET settings = ? WHERE maskID = ?')->execute([json_encode($settings), $mask]);
pm_mark($inChain, 'z');
check('type off: nothing queued', pm_queued_soon(), 0);
reset_all();

echo ($failures ? "\n$failures of $count checks FAILED" : "\n$count checks passed") . "\n";
exit($failures ? 1 : 0);
