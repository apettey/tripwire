<?php
// Fork-owned: end-to-end rally point sequences against the dev stack (needs its MySQL, the running Discord worker and
// the Discord mock, docker/dev/discord-mock.php). Both paths: Mask Admin > Discord (queued, sent by the worker) and
// upstream's DISCORD_WEB_HOOK (posted directly, rally_discord.inc.php). Prints what the channel shows after each
// sequence (the mock's GET /channel) and checks it.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/rally_discord_flow_test.php
// Uses masks 98000071.2 / 98000072.2 and webhook rows of its own; clears its rows first. "After 30 s" is simulated by
// moving the stored post time of the last rally message back.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../discord/discord.inc.php');
require_once(__DIR__ . '/../rally_discord.inc.php');

$checkMode = !in_array('--print', $argv, true);   // --print: only show the channels (e.g. against an older version)
$mock = getenv('DISCORD_MOCK') ?: 'http://discord-mock:8080';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec("SET time_zone = '+00:00'");
discord_ensure_schema($db);
$db->exec('CREATE TABLE IF NOT EXISTS fork_rally (maskID decimal(12,1) NOT NULL, systemID int NOT NULL, setBy varchar(100) DEFAULT NULL,
    setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (maskID))');

$failures = 0;
$count = 0;
function check($name, $actual, $expected) {
    global $failures, $count, $checkMode;
    if (!$checkMode) return;
    $count++;
    if ($actual !== $expected) {
        $failures++;
        fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
    }
}

const FLOW_MASK = '98000071.2';
const FLOW_LEGACY_MASK = '98000072.2';
const FLOW_CORP = 98000071;
$hookID = '1200000000000071000';
$token = str_repeat('flowTest_', 8);
$legacyHook = "$mock/api/webhooks/1200000000000072000/$token";

// A corporation with a Tripwire admin, a webhook to the mock, the rally type on (pinging @here)
$db->exec("DELETE FROM characters WHERE userID = 990071");
$db->exec("DELETE FROM accounts WHERE id = 990071");
$db->exec("INSERT INTO accounts (id, username, password) VALUES (990071, 'rally-flow-test', 'x')");
$db->exec("INSERT INTO characters (userID, characterID, characterName, corporationID, corporationName, admin) VALUES (990071, 990071, 'Flow Admin', " . FLOW_CORP . ", 'Flow Corp', 1)");
$db->prepare('DELETE FROM discord_webhooks WHERE maskID = ?')->execute([FLOW_MASK]);
$db->prepare("INSERT INTO discord_webhooks (maskID, name, url, urlHint, status, createdAt, updatedAt) VALUES (?, 'flow', ?, '', 'ok', UTC_TIMESTAMP(), UTC_TIMESTAMP())")
    ->execute([FLOW_MASK, discord_seal("https://discord.com/api/webhooks/$hookID/$token")]);
$webhookRow = (int) $db->lastInsertId();
$settings = discord_settings_defaults(FLOW_CORP);
$settings['types']['rally'] = ['enabled' => true, 'webhookID' => $webhookRow, 'ping' => '@here', 'enabledAt' => time() - 3600] + $settings['types']['rally'];
$db->prepare('DELETE FROM discord_settings WHERE maskID = ?')->execute([FLOW_MASK]);
$db->prepare("INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, 'flow', UTC_TIMESTAMP())")->execute([FLOW_MASK, json_encode($settings)]);

function flow_http($url) {
    $body = @file_get_contents($url);
    return $body === false ? null : json_decode($body, true);
}

/** Forget everything about both masks and the mock's channel */
function flow_reset() {
    global $db, $mock;
    foreach ([FLOW_MASK, FLOW_LEGACY_MASK] as $mask) {
        foreach (['fork_rally', 'discord_rally', 'discord_rally_message', 'fork_rally_discord', 'fork_rally_discord_message'] as $table) {
            try { $db->prepare("DELETE FROM $table WHERE maskID = ?")->execute([$mask]); } catch (PDOException $e) { /* table of another version */ }
        }
        $db->prepare('DELETE FROM discord_outbox WHERE maskID = ?')->execute([$mask]);
    }
    flow_http("$mock/reset");
}

/** A rally change, as public/rally.php makes it ($legacy: posted directly to the DISCORD_WEB_HOOK webhook) */
function flow_change($legacy, $mode, $who, $systemID = 0) {
    global $db, $legacyHook;
    $mask = $legacy ? FLOW_LEGACY_MASK : FLOW_MASK;
    $stmt = $db->prepare('SELECT systemID, setBy FROM fork_rally WHERE maskID = ?');
    $stmt->execute([$mask]);
    $previous = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    if ($mode === 'set') {
        $db->prepare('REPLACE INTO fork_rally (maskID, systemID, setBy) VALUES (?, ?, ?)')->execute([$mask, $systemID, $who]);
    } else {
        $db->prepare('DELETE FROM fork_rally WHERE maskID = ?')->execute([$mask]);
    }
    $previousSystemID = $mode === 'clear' && $previous ? (int) $previous['systemID'] : 0;
    if ($legacy) return rally_discord_notify($db, $mask, $legacyHook, $mode, $who, $previousSystemID);
    return discord_rally_enqueue($db, $mask, discord_rally_target($db, $mask), $mode, $who, $previousSystemID);
}

/** Wait until the worker has handled every queued message of the mask */
function flow_flush() {
    global $db;
    for ($i = 0; $i < 100; $i++) {
        $stmt = $db->prepare("SELECT COUNT(*) FROM discord_outbox WHERE maskID = ? AND status = 'queued'");
        $stmt->execute([FLOW_MASK]);
        if ((int) $stmt->fetchColumn() === 0) { usleep(300000); return; }
        usleep(200000);
    }
    fwrite(STDERR, "worker did not send within 20 s (is discord-notify running?)\n");
}

/** Pretend the last rally message was posted $seconds ago */
function flow_age($seconds) {
    global $db;
    foreach (['discord_rally', 'discord_rally_message', 'fork_rally_discord', 'fork_rally_discord_message'] as $table) {
        try { $db->exec("UPDATE $table SET postedAt = postedAt - INTERVAL " . (int) $seconds . ' SECOND'); } catch (PDOException $e) { /* other version */ }
    }
}

/** The channel: [[content, pinged on post (true/false), edited], ...], oldest first; times shown as <t:…> */
function flow_channel($title) {
    global $mock;
    $messages = flow_http("$mock/channel") ?: [];
    echo "\n### $title\n";
    $out = [];
    foreach ($messages as $m) {
        $pinged = !empty($m['pinged']['parse']) || !empty($m['pinged']['roles']) || !empty($m['pinged']['users']);
        $content = preg_replace('/<t:\d+:t>/', '<t:…:t>', $m['content']);
        echo '- ' . str_replace("\n", "\n  ", $content) . ($m['edited'] ? '  (edited)' : '') . ($pinged ? '  [pinged]' : '') . "\n";
        $out[] = [$content, $pinged, $m['edited']];
        if ($m['edited'] && isset($m['editAllowedMentions'])) check("$title: an edit never pings", $m['editAllowedMentions'], ['parse' => []]);
    }
    return $out;
}

function flow_system($name) { foreach (range(31000001, 31002604) as $id) { $s = discord_system($id); if ($s && $s[0] === $name) return $id; } return 0; }
$sysA = flow_system('J163701');
$sysB = flow_system('J152820');
$appUrl = discord_app_url();
$liveA = "@here Tripwire rally point from *Kytus Bos*: **J163701** (C5, E\\-R00025)\n<{$appUrl}?system=J163701>";
$struckA = '~~Tripwire rally point from *Kytus Bos*: **J163701** (C5, E\\-R00025)~~';
$liveB = "@here Tripwire rally point from *Aashai Modor*: **J152820** (C5, E\\-R00024)\n<{$appUrl}?system=J152820>";
$struckB = '~~Tripwire rally point from *Aashai Modor*: **J152820** (C5, E\\-R00024)~~';

// ---------- Mask Admin > Discord (outbox, worker) ----------
echo "## Mask Admin > Discord (outbox)\n";

flow_reset();
flow_change(false, 'set', 'Commander Tyrael', $sysA); flow_flush();
flow_change(false, 'clear', 'Commander Tyrael'); flow_flush();
check('outbox: set, clear within 30 s', flow_channel('set, clear within 30 s'),
    [[str_replace('Kytus Bos', 'Commander Tyrael', $struckA) . "\nCleared by *Commander Tyrael* at <t:…:t>", true, true]]);

flow_reset();
flow_change(false, 'set', 'Kytus Bos', $sysA); flow_flush();
flow_age(3300);
flow_change(false, 'clear', 'Aashai Modor'); flow_flush();
check('outbox: set, clear after 30 s', flow_channel('set, clear after 30 s (55 min)'), [[$struckA . "\nCleared by *Aashai Modor* at <t:…:t>", true, true]]);

flow_reset();
flow_change(false, 'set', 'Kytus Bos', $sysA); flow_flush();
flow_change(false, 'set', 'Aashai Modor', $sysB); flow_flush();
check('outbox: set, move within 30 s', flow_channel('set, move within 30 s'), [[$liveB, true, true]]);

flow_reset();
flow_change(false, 'set', 'Kytus Bos', $sysA); flow_flush();
flow_age(60);
flow_change(false, 'set', 'Aashai Modor', $sysB); flow_flush();
check('outbox: set, move after 30 s', flow_channel('set, move after 30 s'),
    [[$struckA . "\nMoved to **J152820** by *Aashai Modor* at <t:…:t>", true, true], [$liveB, true, false]]);
flow_change(false, 'clear', 'Kytus Bos'); flow_flush();
check('outbox: ... then clear', flow_channel('... then clear'),
    [[$struckA . "\nMoved to **J152820** by *Aashai Modor* at <t:…:t>", true, true], [$struckB . "\nCleared by *Kytus Bos* at <t:…:t>", true, true]]);

flow_reset();
flow_change(false, 'clear', 'Aashai Modor'); flow_flush();
$db->beginTransaction();   // both queued before the worker sees either: the set is dropped, the clear has nothing to edit
flow_change(false, 'set', 'Kytus Bos', $sysA);
flow_change(false, 'clear', 'Aashai Modor');
$db->commit();
flow_flush();
check('outbox: clear with no message to edit posts nothing', flow_channel('clear with no rally message (never posted)'), []);

flow_reset();
flow_change(false, 'set', 'Kytus Bos', $sysA); flow_flush();
$channel = flow_http("$mock/channel");
flow_http("$mock/delete/" . $channel[0]['id']);
flow_age(60);
flow_change(false, 'clear', 'Aashai Modor'); flow_flush();
$requests = flow_http("$mock/messages");
check('outbox: clear after the message was deleted in Discord: one edit tried, nothing posted', array_map(function ($r) { return $r['method'] . ' ' . $r['status']; }, $requests), ['PATCH 404', 'POST 200']);

flow_reset();
flow_change(false, 'set', 'Commander Tyrael', $sysA); flow_flush();
flow_change(false, 'clear', 'Commander Tyrael'); flow_flush();
flow_change(false, 'set', 'Kytus Bos', $sysA); flow_flush();
flow_age(3300);
flow_change(false, 'clear', 'Aashai Modor'); flow_flush();
check('outbox: the production sequence', flow_channel('production sequence: Tyrael set + clear in 30 s, Kytus set, Aashai clear 55 min later'), [
    [str_replace('Kytus Bos', 'Commander Tyrael', $struckA) . "\nCleared by *Commander Tyrael* at <t:…:t>", true, true],
    [$struckA . "\nCleared by *Aashai Modor* at <t:…:t>", true, true]]);

// ---------- DISCORD_WEB_HOOK (legacy, posted directly; no pings, fixed texts) ----------
echo "\n## DISCORD_WEB_HOOK (legacy)\n";
// Legacy texts: the system's class and region inside the bold, no pings (no link: the CLI has no EVE_SSO_REDIRECT)
$legacyLive = function ($who, $where) { return "Tripwire rally point from *$who*: **$where**"; };
$plain = function ($text) {
    return strtr($text, ["@here " => '', '**J163701** (C5, E\\-R00025)' => '**J163701 (C5, E-R00025)**', '**J152820** (C5, E\\-R00024)' => '**J152820 (C5, E-R00024)**']);
};
$liveB = $legacyLive('Aashai Modor', 'J152820 (C5, E-R00024)');

flow_reset();
flow_change(true, 'set', 'Commander Tyrael', $sysA);
flow_change(true, 'clear', 'Commander Tyrael');
check('legacy: set, clear within 30 s', flow_channel('legacy: set, clear within 30 s'),
    [[$plain(str_replace('Kytus Bos', 'Commander Tyrael', $struckA)) . "\nCleared by *Commander Tyrael* at <t:…:t>", false, true]]);

flow_reset();
flow_change(true, 'set', 'Kytus Bos', $sysA);
flow_age(3300);
flow_change(true, 'clear', 'Aashai Modor');
check('legacy: set, clear after 30 s', flow_channel('legacy: set, clear after 30 s'), [[$plain($struckA) . "\nCleared by *Aashai Modor* at <t:…:t>", false, true]]);

flow_reset();
flow_change(true, 'set', 'Kytus Bos', $sysA);
flow_change(true, 'set', 'Aashai Modor', $sysB);
check('legacy: set, move within 30 s', flow_channel('legacy: set, move within 30 s'), [[$plain($liveB), false, true]]);

flow_reset();
flow_change(true, 'set', 'Kytus Bos', $sysA);
flow_age(60);
flow_change(true, 'set', 'Aashai Modor', $sysB);
check('legacy: set, move after 30 s', flow_channel('legacy: set, move after 30 s'),
    [[$plain($struckA) . "\nMoved to **J152820** by *Aashai Modor* at <t:…:t>", false, true], [$plain($liveB), false, false]]);

// A move whose new post fails (Discord down: the mock's ...0500 webhook answers 500 twice) keeps the old message
// tracked, so the clear still ends it
flow_reset();
flow_change(true, 'set', 'Kytus Bos', $sysA);
flow_age(60);
$goodHook = $legacyHook;
$legacyHook = "$mock/api/webhooks/1200000000000070500/$token";
check('legacy: a failed post is reported', flow_change(true, 'set', 'Aashai Modor', $sysB), 'failed');
$legacyHook = $goodHook;
flow_change(true, 'clear', 'Aashai Modor');
check('legacy: after a failed post the old message is still ended', flow_channel('legacy: move whose post failed, then clear'),
    [[$plain($struckA) . "\nCleared by *Aashai Modor* at <t:…:t>", false, true]]);

flow_reset();
flow_change(true, 'clear', 'Aashai Modor');
check('legacy: clear with no message posts nothing', flow_channel('legacy: clear with no rally message'), []);

flow_reset();
flow_change(true, 'set', 'Kytus Bos', $sysA);
$channel = flow_http("$mock/channel");
flow_http("$mock/delete/" . $channel[0]['id']);
flow_age(60);
flow_change(true, 'clear', 'Aashai Modor');
check('legacy: clear after the message was deleted: one edit tried, nothing posted',
    array_map(function ($r) { return $r['method'] . ' ' . $r['status']; }, flow_http("$mock/messages")), ['PATCH 404', 'POST 200']);

flow_reset();
$db->prepare('DELETE FROM discord_webhooks WHERE id = ?')->execute([$webhookRow]);
$db->prepare('DELETE FROM discord_settings WHERE maskID = ?')->execute([FLOW_MASK]);
$db->exec("DELETE FROM characters WHERE userID = 990071");
$db->exec("DELETE FROM accounts WHERE id = 990071");

if ($checkMode) {
    echo "\n" . ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
    exit($failures ? 1 : 0);
}
