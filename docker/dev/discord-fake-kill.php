<?php
// Dev only: hand a made-up killmail to the Discord notifications exactly as zkill_feed.worker.php does for a
// streamed kill (discord_on_killmail), so kill notifications can be tried without zKillboard.
//
//   docker compose -f docker-compose.dev.yml exec -T app php docker/dev/discord-fake-kill.php <systemID> <loss|kill|neutral> [corporationID]
//
// loss: the victim is in <corporationID>; kill: a <corporationID> pilot gets the final blow; neutral: neither.
// <corporationID> defaults to the dev login's corporation. Names of the made-up pilots are put into the name cache
// (the dev stack usually has no ESI name resolution running).
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../..');
require('config.php');
require_once('zkill/zkill.inc.php');
require_once('discord/discord.inc.php');
discord_log_sink(function ($m) { echo "[discord] $m\n"; });

$systemID = (int) ($argv[1] ?? 0);
$mode = $argv[2] ?? 'neutral';
$mysql = null;
include('db.inc.php');
$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$corp = (int) ($argv[3] ?? $mysql->query('SELECT corporationID FROM characters ORDER BY userID LIMIT 1')->fetchColumn());
if (!$systemID || !in_array($mode, ['loss', 'kill', 'neutral'], true)) { fwrite(STDERR, "usage: discord-fake-kill.php <systemID> <loss|kill|neutral> [corporationID]\n"); exit(1); }

$killID = 900000000 + random_int(0, 99999999);
$victim = ['character_id' => 2100000001, 'corporation_id' => $mode === 'loss' ? $corp : 98000101, 'ship_type_id' => 11377];
$attackers = [
    ['character_id' => 2100000002, 'corporation_id' => $mode === 'kill' ? $corp : 98000102, 'ship_type_id' => 17738, 'final_blow' => true],
    ['character_id' => 2100000003, 'corporation_id' => 98000102, 'ship_type_id' => 12011, 'final_blow' => false],
];
$names = [2100000001 => '@everyone Fake *Victim*', 2100000002 => 'Fake Hunter', 2100000003 => 'Fake Wingman', 98000101 => 'Victim Corp',
    98000102 => 'Hunter Corp', 11377 => 'Nemesis', 17738 => 'Machariel', 12011 => 'Eagle'];
$stmt = $mysql->prepare('INSERT INTO zkill_names (id, name, category, requestedAt, resolvedAt) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE name = VALUES(name), resolvedAt = VALUES(resolvedAt)');
foreach ($names as $id => $name) $stmt->execute([$id, $name, 'dev']);

$kill = ['killmail_id' => $killID, 'hash' => 'devhash', 'sequence_id' => 0,
    'zkb' => ['totalValue' => 254300000.5, 'npc' => false, 'solo' => false],
    'esi' => ['killmail_id' => $killID, 'killmail_time' => gmdate('Y-m-d\TH:i:s\Z', time() - 30), 'solar_system_id' => $systemID,
        'victim' => $victim, 'attackers' => $attackers]];
discord_kill_state($mysql, true);   // don't wait for the 60 s settings refresh
$queued = discord_on_killmail($mysql, $kill);
echo "kill $killID ($mode) in $systemID: queued $queued notification(s)\n";
