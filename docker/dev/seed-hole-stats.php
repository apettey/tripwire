<?php
// Local dev only: fills Hole statistics (fork_hole_log) with a year of made-up holes for screenshots and trying it out.
//
//   docker compose -f docker-compose.dev.yml exec -T app php /opt/app/docker/dev/seed-hole-stats.php [mask] [homeSystemID]
//
// mask: default the corporation mask of the dev character (docker/dev-seed.sh); homeSystemID: default J163701 (C5, static
// H296). Sets the mask's home (Mask Admin > Discord > Home system), replaces that home's rows with ~900 holes (static rolls
// to random C5 systems, some never followed; inbound K162s from a few favourite origins) and stamps the backfill as done.
// Deterministic (fixed random seed). Never run against production data.
//
//   docker compose -f docker-compose.dev.yml exec -T app php /opt/app/docker/dev/seed-hole-stats.php --clear [mask]
//
// removes the seeded holes and the Discord settings row the seed made: the Discord flow tests in tests/ expect the dev
// mask to have none, so run it before docker/dev/run-php-tests.sh.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }
require_once(__DIR__ . '/../../holestats/holestats.inc.php');

$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$clear = in_array('--clear', $argv, true);
$args = array_values(array_filter(array_slice($argv, 1), function ($a) { return $a !== '--clear'; }));
$mask = $args[0] ?? null;
if (!$mask) {
    $corp = $db->query("SELECT corporationID FROM characters c JOIN accounts a ON a.id = c.userID WHERE a.username = 'dev' LIMIT 1")->fetchColumn();
    if (!$corp) { fwrite(STDERR, "No dev character: run docker/dev-seed.sh first, or pass a mask\n"); exit(1); }
    $mask = $corp . '.2';
}
$home = (int) ($args[1] ?? 31002012);
if (!holestats_mask_ok($mask)) { fwrite(STDERR, "Not a mask id: $mask\n"); exit(1); }

if ($clear) {
    holestats_run($db, function () use ($db, $mask) {
        $db->prepare('DELETE FROM fork_hole_log WHERE maskID = ?')->execute([$mask]);
        $db->prepare('DELETE FROM fork_hole_log_backfill WHERE maskID = ?')->execute([$mask]);
    });
    // the home goes again: the row if the seed made it, else only homeSystemID in it
    try {
        $stmt = $db->prepare('SELECT settings, updatedBy FROM discord_settings WHERE maskID = ?');
        $stmt->execute([$mask]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $settings = json_decode((string) $row['settings'], true) ?: [];
            unset($settings['homeSystemID']);
            if ($row['updatedBy'] === 'seed-hole-stats' && !$settings) {
                $db->prepare('DELETE FROM discord_settings WHERE maskID = ?')->execute([$mask]);
            } else {
                $db->prepare('UPDATE discord_settings SET settings = ? WHERE maskID = ?')->execute([json_encode((object) $settings), $mask]);
            }
        }
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') throw $e;
    }
    echo "Cleared the seeded holes of mask $mask\n";
    exit(0);
}

// The mask's home: merged into its Discord settings (created if needed)
$db->exec("CREATE TABLE IF NOT EXISTS `discord_settings` (`maskID` decimal(12,1) NOT NULL, `settings` mediumtext NOT NULL, `updatedBy` varchar(100) NOT NULL DEFAULT '',
    `updatedAt` datetime NOT NULL, PRIMARY KEY (`maskID`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
$stmt = $db->prepare('SELECT settings FROM discord_settings WHERE maskID = ?');
$stmt->execute([$mask]);
$settings = json_decode((string) $stmt->fetchColumn(), true) ?: [];
$settings['homeSystemID'] = $home;
$db->prepare('INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE settings = VALUES(settings)')
    ->execute([$mask, json_encode($settings), 'seed-hole-stats']);

$data = holestats_game_data();
$statics = array_map('strtoupper', $data['systems'][$home]['statics'] ?? []);
if (!$statics) { fwrite(STDERR, "$home has no static\n"); exit(1); }
$pool = function ($space) use ($data) {
    $ids = [];
    foreach ($data['systems'] as $id => $s) if ($id >= 30000000 && $id < 32000000 && holestats_space($id, $data) === $space && $id !== 30100000) $ids[] = $id;
    return $ids;
};
$byType = [];
foreach ($data['wormholes'] as $type => $w) if ($w['leadsTo'] === holestats_space($home, $data)) $byType[$type] = $w['from'];

mt_srand(20261125);
$pick = function (array $list) { return $list[mt_rand(0, count($list) - 1)]; };
$sig = function () { return chr(mt_rand(97, 122)) . chr(mt_rand(97, 122)) . chr(mt_rand(97, 122)) . sprintf('%03d', mt_rand(0, 999)); };
holestats_run($db, function () use ($db, $mask, $home) {
    $db->prepare('DELETE FROM fork_hole_log WHERE maskID = ? AND homeSystemID = ?')->execute([$mask, $home]);
});
$ins = $db->prepare('INSERT INTO fork_hole_log (maskID, homeSystemID, wormholeID, homeSig, homeType, farSystemID, farSig, farType, firstSeen, lastUpdated, source, guessed)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
$now = time();
$start = $now - 365 * 86400;
$liveFrom = $now - 40 * 86400;   // older rows look backfilled
$rows = 0;
$add = function ($t, $homeType, $far, $farType) use ($ins, $mask, $home, $sig, $liveFrom, &$rows) {
    $at = gmdate('Y-m-d H:i:s', $t);
    $backfill = $t < $liveFrom;
    $ins->execute([$mask, $home, $sig(), $homeType, $far, $far ? $sig() : '', $farType, $at, gmdate('Y-m-d H:i:s', $t + mt_rand(600, 20000)),
        $backfill ? 'backfill' : 'live', $backfill && mt_rand(0, 9) === 0 ? 1 : 0]);
    $rows++;
};
// Static rolls: more in the busy months, to random systems of the static's class, some never followed
foreach ($statics as $static) {
    $dest = $pool($data['wormholes'][$static]['leadsTo'] ?? '');
    for ($t = $start; $t < $now; $t += mt_rand(4, 22) * 3600) {
        $far = $dest && mt_rand(0, 99) < 82 ? $pick($dest) : 0;
        $add($t, $static, $far, 'K162');
    }
}
// Inbound K162s: a few origins keep coming back
$favourites = [];
foreach (array_slice(array_keys($byType), 0, 6) as $type) {
    $from = $pool($byType[$type][0]);
    if ($from) $favourites[] = [$type, $pick($from)];
}
for ($t = $start; $t < $now; $t += mt_rand(10, 60) * 3600) {
    $r = mt_rand(0, 99);
    if ($r < 25 && $favourites) { [$type, $far] = $pick($favourites); $add($t, 'K162', $far, $type); continue; }
    $type = $pick(array_keys($byType));
    $from = $pool($byType[$type][mt_rand(0, count($byType[$type]) - 1)]);
    $known = mt_rand(0, 99);
    $add($t, 'K162', $known < 60 && $from ? $pick($from) : 0, $known < 80 ? $type : '');
}
// Holes whose type nobody set
for ($t = $start; $t < $now; $t += mt_rand(48, 160) * 3600) $add($t, '', 0, '');

$db->prepare('INSERT INTO fork_hole_log_backfill (maskID, homeSystemID, doneAt, `rows`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE doneAt = VALUES(doneAt), `rows` = VALUES(`rows`)')
    ->execute([$mask, $home, gmdate('Y-m-d H:i:s', $liveFrom), $rows]);
echo "Seeded $rows holes for mask $mask, home $home (statics " . implode(', ', $statics) . ")\n";
