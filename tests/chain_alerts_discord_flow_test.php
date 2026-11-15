<?php
// Fork-owned: the "New hole in the chain" and "Home static <1h / EOL" Discord types end to end against the dev stack: holes
// in the dev corporation mask, the running Discord worker (discord_notify.worker.php, restart it first so it has the new
// code: kill its php process, supervisord starts it again) and the Discord mock (docker/dev/discord-mock.php). Prints the
// channel (the mock's GET /channel) and checks it. The mask's Discord settings are snapshotted and put back, the holes
// removed at the end. The worker polls every 15 s, so the run takes about a minute.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/chain_alerts_discord_flow_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../discord/discord.inc.php');

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

$stmt = $db->prepare('SELECT * FROM discord_settings WHERE maskID = ?');
$stmt->execute([$mask]);
$savedSettings = $stmt->fetchAll(PDO::FETCH_ASSOC);
$stmt = $db->prepare('SELECT admin FROM characters WHERE characterID = ?');
$stmt->execute([$me['characterID']]);
$savedAdmin = (int) $stmt->fetchColumn();
$webhookRow = 0;
$sigIDs = [];
register_shutdown_function(function () use ($db, $mask, $me, $savedAdmin, &$savedSettings, &$webhookRow, &$sigIDs) {
    $db->prepare('UPDATE characters SET admin = ? WHERE characterID = ?')->execute([$savedAdmin, $me['characterID']]);
    foreach ($sigIDs as $id) $db->prepare('DELETE FROM signatures WHERE id = ?')->execute([$id]);   // their wormholes go with them (FK)
    $db->prepare('DELETE FROM discord_settings WHERE maskID = ?')->execute([$mask]);
    foreach ($savedSettings as $row) $db->prepare('INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, ?, ?)')->execute([$row['maskID'], $row['settings'], $row['updatedBy'], $row['updatedAt']]);
    $db->prepare("DELETE FROM discord_sent WHERE maskID = ? AND kind IN ('chole', 'choleBase', 'hstatic')")->execute([$mask]);
    if ($webhookRow) {
        $db->prepare('DELETE FROM discord_outbox WHERE webhookID = ?')->execute([$webhookRow]);
        $db->prepare('DELETE FROM discord_webhooks WHERE id = ?')->execute([$webhookRow]);
    }
    echo "(dev mask put back as it was)\n";
});
$db->prepare('UPDATE characters SET admin = 1 WHERE characterID = ?')->execute([$me['characterID']]);

$HOME = 31000880;       // J160650 (C3), static U210 to low-sec
$J152820 = 31001880;
$FLOSESWIN = 30002082;
$sig = $db->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeTime, lifeLeft, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, modifiedTime, maskID)
    VALUES (?, ?, 'wormhole', NULL, ?, ?, 57600, 1, 'Flow Test', 1, 'Flow Test', NOW(), ?)");
$wh = $db->prepare("INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (?, ?, ?, ?, ?, 'stable', ?)");
$hole = function ($a, $aSig, $b, $bSig, $type, $parent, $life = 'stable', $left = 50000) use ($db, $sig, $wh, $mask, &$sigIDs) {
    $t = date('Y-m-d H:i:s', time() - 3600);
    $l = date('Y-m-d H:i:s', time() + $left);
    $sig->execute([$aSig, $a, $t, $l, $mask]); $x = $sigIDs[] = (int) $db->lastInsertId();
    $sig->execute([$bSig, $b, $t, $l, $mask]); $y = $sigIDs[] = (int) $db->lastInsertId();
    $wh->execute([$x, $y, $type, $parent, $life, $mask]);
};

// Before the type is on: the static (stable for now) and a K162 from J152820
$hole($HOME, 'fts001', 30002537, 'fts002', 'U210', 'initial', 'stable');
$hole($HOME, 'fts003', $J152820, 'fts004', 'H296', 'secondary');

$hookID = '1200000000000094000';
$token = str_repeat('chalrtTk_', 8);
$db->prepare("INSERT INTO discord_webhooks (maskID, name, url, urlHint, status, createdAt, updatedAt) VALUES (?, 'chain-alerts-test', ?, '', 'ok', UTC_TIMESTAMP(), UTC_TIMESTAMP())")
    ->execute([$mask, discord_seal("https://discord.com/api/webhooks/$hookID/$token")]);
$webhookRow = (int) $db->lastInsertId();
$settings = discord_settings_defaults((int) $me['corporationID']);
$settings['homeSystemID'] = $HOME;
$settings['types']['chainHole'] = ['enabled' => true, 'webhookID' => $webhookRow, 'ping' => '@here', 'enabledAt' => time(), 'homeOnly' => false] + $settings['types']['chainHole'];
$settings['types']['homeStatic'] = ['enabled' => true, 'webhookID' => $webhookRow, 'ping' => '', 'enabledAt' => time() - 60] + $settings['types']['homeStatic'];   // a minute ago: <1h is reached after it
$db->prepare("INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, 'chain-alerts-test', UTC_TIMESTAMP())")->execute([$mask, json_encode($settings)]);
mock('/reset');

echo "waiting for the worker's first poll (the baseline: nothing is posted)...\n";
for ($i = 0; $i < 40; $i++) {
    sleep(1);
    $stmt = $db->prepare("SELECT COUNT(*) FROM discord_sent WHERE maskID = ? AND kind = 'choleBase'");
    $stmt->execute([$mask]);
    if ((int) $stmt->fetchColumn() > 0) break;
}
check('baseline recorded', $i < 40, true);
check('baseline: nothing posted for holes already on the map', mock('/channel') ?: [], []);

// Afterwards: a K162 opens in home, another hole from J152820 to low-sec, and the static goes <1h
$hole($HOME, 'fts005', 6, 'fts006', '????', 'secondary');
$hole($J152820, 'fts007', $FLOSESWIN, 'fts008', '????', 'secondary');
$db->prepare("UPDATE wormholes w INNER JOIN signatures a ON a.id = w.initialID SET w.life = 'critical' WHERE a.signatureID = 'fts001' AND w.maskID = ?")->execute([$mask]);
$db->prepare("UPDATE signatures SET lifeLeft = ? WHERE signatureID IN ('fts001', 'fts002') AND maskID = ?")->execute([date('Y-m-d H:i:s', time() + 3599), $mask]);   // just went <1h (as picking <1h in the sig list does)

echo "waiting for the worker (polls every 15 s)...\n";
$posted = [];
for ($i = 0; $i < 60 && count($posted) < 3; $i++) {
    sleep(1);
    $posted = mock('/channel') ?: [];
}
sleep(20);   // a second poll must not post them again
$posted = mock('/channel') ?: [];
echo "\n### channel\n";
foreach ($posted as $m) echo '- ' . $m['content'] . (!empty($m['pinged']['parse']) ? '  [pinged]' : '') . "\n";
check('three messages: two new holes and the static, each once', count($posted), 3);
$texts = implode("\n", array_map(function ($m) { return $m['content']; }, $posted));
check('new hole in home', strpos($texts, 'New hole in home: **FTS\\-005** K162 in **J160650** to an unknown system, mapped by *Flow Test*') !== false, true);
check('new hole in the chain', preg_match('/New hole in the chain: \*\*FTS\\\\-007\*\* K162 in \*\*(\S+ · )?J152820\*\* to Floseswin \(LS\)/', $texts) === 1, true);
check('the static <1h', preg_match('/Home static \*\*U210\*\* \(FTS\\\\-001\) in \*\*J160650\*\* is \*\*<1h\*\*: about 59 minutes left/', $texts) === 1, true);
check('the new holes ping @here', count(array_filter($posted, function ($m) { return !empty($m['pinged']['parse']); })), 2);

fwrite(STDOUT, ($failures ? 'FAILED' : 'OK') . ": $count checks, $failures failures\n");
exit($failures ? 1 : 0);
