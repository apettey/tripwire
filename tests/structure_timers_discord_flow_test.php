<?php
// Fork-owned: the "Structure timers" Discord type end to end against the dev stack: a structure with a timer in the dev
// corporation mask's Structures data, the running Discord worker (discord_notify.worker.php, restart it first so it has
// the new code: kill its php process, supervisord starts it again) and the Discord mock (docker/dev/discord-mock.php).
// Prints the channel (the mock's GET /channel) and checks it. The mask's Discord settings and structures are snapshotted
// and put back at the end. The worker polls every 15 s, so the run takes about a minute.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/structure_timers_discord_flow_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../discord/discord.inc.php');
require_once(__DIR__ . '/../structures/structures.inc.php');

$mock = getenv('DISCORD_MOCK') ?: 'http://discord-mock:8080';
$user = getenv('DEV_USERNAME') ?: 'dev';
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
structures_schema($db);

$stmt = $db->prepare('SELECT * FROM discord_settings WHERE maskID = ?');
$stmt->execute([$mask]);
$savedSettings = $stmt->fetchAll(PDO::FETCH_ASSOC);
$stmt = $db->prepare('SELECT admin FROM characters WHERE characterID = ?');
$stmt->execute([$me['characterID']]);
$savedAdmin = (int) $stmt->fetchColumn();
$webhookRow = 0;
$structureIDs = [];
register_shutdown_function(function () use ($db, $mask, $me, $savedAdmin, &$savedSettings, &$webhookRow, &$structureIDs) {
    $db->prepare('UPDATE characters SET admin = ? WHERE characterID = ?')->execute([$savedAdmin, $me['characterID']]);
    foreach ($structureIDs as $id) $db->prepare('DELETE FROM fork_structures WHERE id = ?')->execute([$id]);
    $db->prepare('DELETE FROM discord_settings WHERE maskID = ?')->execute([$mask]);
    foreach ($savedSettings as $row) $db->prepare('INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, ?, ?)')->execute([$row['maskID'], $row['settings'], $row['updatedBy'], $row['updatedAt']]);
    $db->prepare("DELETE FROM discord_sent WHERE maskID = ? AND kind = 'stimer'")->execute([$mask]);
    if ($webhookRow) {
        $db->prepare('DELETE FROM discord_outbox WHERE webhookID = ?')->execute([$webhookRow]);
        $db->prepare('DELETE FROM discord_webhooks WHERE id = ?')->execute([$webhookRow]);
    }
    echo "(dev mask put back as it was)\n";
});
$db->prepare('UPDATE characters SET admin = 1 WHERE characterID = ?')->execute([$me['characterID']]);

$J152820 = 31001880;
$now = time();
$insert = function ($name, $owner, $endsIn) use ($db, $mask, $J152820, $now, &$structureIDs) {
    $at = gmdate('Y-m-d H:i:s', $now + $endsIn);
    $old = gmdate('Y-m-d H:i:s', $now - 86400);
    $db->prepare("INSERT INTO fork_structures (maskID, systemID, typeID, typeName, kind, name, ownerText, state, timerKind, timerAt, timerSetBy, timerSetAt, note, firstSeenAt, lastSeenAt, updatedAt)
        VALUES (?, ?, 35833, 'Fortizar', 'upwell', ?, ?, 'reinforced', 'hull', ?, 'Flow Test', ?, 'bring dreads', ?, ?, ?)")
        ->execute([$mask, $J152820, $name, $owner, $at, $old, $old, $old, $old]);
    return $structureIDs[] = (int) $db->lastInsertId();
};

$hookID = '1200000000000093000';
$token = str_repeat('stimerTk_', 8);
$db->prepare("INSERT INTO discord_webhooks (maskID, name, url, urlHint, status, createdAt, updatedAt) VALUES (?, 'stimer-test', ?, '', 'ok', UTC_TIMESTAMP(), UTC_TIMESTAMP())")
    ->execute([$mask, discord_seal("https://discord.com/api/webhooks/$hookID/$token")]);
$webhookRow = (int) $db->lastInsertId();
$settings = discord_settings_defaults((int) $me['corporationID']);
$settings['homeSystemID'] = $J152820;
$settings['types']['structureTimer'] = ['enabled' => true, 'webhookID' => $webhookRow, 'ping' => '@here', 'enabledAt' => $now - 100000] + $settings['types']['structureTimer'];
$db->prepare("INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, 'stimer-test', UTC_TIMESTAMP())")->execute([$mask, json_encode($settings)]);
mock('/reset');

// A hull timer 14 minutes away (15 m reminder due now), one 3 days away (nothing), one that ended 10 minutes ago (nothing)
$insert('J152820 - Fort Knox', 'Hostile Haulers', 14 * 60);
$insert('J152820 - Far Away', 'Later Corp', 3 * 86400);
$insert('J152820 - Long Gone', 'Old Corp', -600);

echo "waiting for the worker (polls every 15 s)...\n";
$posted = [];
for ($i = 0; $i < 90 && !$posted; $i++) {
    sleep(1);
    $posted = mock('/channel') ?: [];
}
sleep(20);   // a second poll must not post it again
$posted = mock('/channel') ?: [];
echo "\n### channel\n";
foreach ($posted as $m) echo '- ' . $m['content'] . (!empty($m['pinged']['parse']) ? '  [pinged]' : '') . "\n";
check('one message: the 15 m reminder of the timer that is 14 minutes away', count($posted), 1);
$content = $posted[0]['content'] ?? '';
check('message: text', [strpos($content, 'Hull timer in 15m') !== false, strpos($content, 'J152820 \\- Fort Knox') !== false, strpos($content, 'Hostile Haulers') !== false, strpos($content, 'Far Away') === false, strpos($content, 'Long Gone') === false],
    [true, true, true, true, true]);
check('message: pings @here', !empty($posted[0]['pinged']['parse']), true);

fwrite(STDOUT, ($failures ? 'FAILED' : 'OK') . ": $count checks, $failures failures\n");
exit($failures ? 1 : 0);
