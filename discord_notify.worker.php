<?php
// Fork-owned: Discord notifications worker (see docker/README.md#discord-notifications).
//
// Long-running CLI process (supervisord [program:discord-notify]); the only process that calls Discord. It
//   - polls the chain maps for new k-space connections near the ping systems (discord/kspace.php) every 15 s,
//   - matches the watchlist filters against the chain connected to home of masks with that type on (discord/watchlist.php), every 15 s,
//   - posts one notice to the chain kill channel while chain kills are on without a home system (discord/chain_notice.php), every 15 s,
//   - sends the outbox (discord/dispatch.php): every second, at most 20 messages / 5 s per pass,
//   - prunes the outbox and dedupe tables every 10 minutes.
// Kill notifications are queued by zkill_feed.worker.php (discord_on_killmail), which sees every streamed killmail.
// A separate process keeps Discord's latency and outages away from the zKillboard stream, and keeps k-space
// notifications working with ZKILL_FEED_ENABLED=false. With several containers on one database, MySQL named locks
// ('discord-kspace', 'discord-dispatch', see discord_leader_lock) make sure only one of them polls and one sends.
//
//   php discord_notify.worker.php

if (php_sapi_name() !== 'cli') {
    http_response_code(404);
    exit();
}

register_shutdown_function(function () {
    $error = error_get_last();
    if ($error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) sleep(30);
});

chdir(__DIR__);
require('config.php');
if (is_file(__DIR__ . '/settings.php')) require_once(__DIR__ . '/settings.php');   // VERSION for the User-Agent
require_once(__DIR__ . '/zkill/zkill.inc.php');   // name cache only (zk_names_lookup); no zKillboard/ESI calls here
require_once(__DIR__ . '/discord/discord.inc.php');
date_default_timezone_set('UTC');

const DN_KSPACE_EVERY    = 15;
const DN_DISPATCH_EVERY  = 1;
const DN_PRUNE_EVERY     = 600;
const DN_HEARTBEAT_EVERY = 300;
const DN_BACKOFF_MAX     = 120;

function dn_log($message) {
    fwrite(STDOUT, '[discord-notify] ' . gmdate('Y-m-d H:i:s') . ' ' . $message . "\n");
}

function dn_connect() {
    $mysql = null;
    include(__DIR__ . '/db.inc.php');
    if (!($mysql instanceof PDO)) throw new RuntimeException('could not connect to the database');
    $mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $mysql->query('SELECT 1');
    discord_ensure_schema($mysql);
    zk_ensure_schema($mysql);
    watchlist_ensure_schema($mysql);
    $resealed = discord_reseal_plain($mysql);
    if ($resealed) dn_log("encrypted $resealed stored webhook URLs with DISCORD_SECRET_KEY");
    return $mysql;
}

/** Masks with k-space notifications on and a working webhook */
function dn_kspace_masks(PDO $db) {
    return dn_type_masks($db, 'kspace');
}

/** Masks with notification type $kind on and a working webhook */
function dn_type_masks(PDO $db, $kind) {
    $ok = [];
    foreach ($db->query("SELECT id, maskID FROM discord_webhooks WHERE status IN ('ok', 'pending')")->fetchAll(PDO::FETCH_ASSOC) as $row) $ok[(int) $row['id']] = (string) $row['maskID'];
    return array_filter(discord_active_settings($db), function ($s, $maskID) use ($ok, $kind) {
        $type = $s['types'][$kind];
        return $type['enabled'] && ($ok[$type['webhookID']] ?? null) === (string) $maskID;
    }, ARRAY_FILTER_USE_BOTH);
}

function dn_run() {
    dn_log('starting (Discord API: ' . discord_api_base() . ', webhook URLs ' . (discord_encryption_enabled() ? 'encrypted' : 'NOT encrypted: set DISCORD_SECRET_KEY') . ')');
    $db = null;
    $highWater = null;
    $lastKspace = 0;
    $lastDispatch = 0;
    $lastPrune = 0;
    $lastHeartbeat = time();
    $backoff = 0;
    $totals = ['sent' => 0, 'failed' => 0, 'kspace' => 0, 'watchlist' => 0];
    $leaders = ['kspace' => null, 'dispatch' => null];

    while (true) {
        try {
            if ($db === null) {
                $db = dn_connect();
                if ($highWater === null) $highWater = discord_kspace_start($db);
                dn_log("connected to the database; watching signature changes after $highWater");
            }
            $now = microtime(true);
            // Several containers on one database: only the lock holder polls / sends, the others stand by
            if ($now - $lastKspace >= DN_KSPACE_EVERY) {
                $lastKspace = $now;
                $leader = discord_leader_lock($db, 'discord-kspace');
                if ($leader !== $leaders['kspace']) dn_log($leader ? 'k-space poller: active' : 'k-space poller: standby (another process holds the lock)');
                $leaders['kspace'] = $leader;
                if ($leader) $totals['kspace'] += discord_kspace_poll($db, dn_kspace_masks($db), $highWater);
                else $highWater = discord_kspace_start($db);   // take over from about now (the poll re-reads an overlap)
                // Watchlist matches: same leader, same cadence (dedupe rows make a second poller harmless anyway)
                if ($leader) $totals['watchlist'] += discord_watchlist_poll($db, dn_type_masks($db, 'watchlist'));
                // Structure timer reminders (24 h / 1 h / 15 m / at the end): same leader, same cadence; the dedupe rows make a second poller harmless
                if ($leader) $totals['stimer'] = ($totals['stimer'] ?? 0) + discord_structure_timer_poll($db, dn_type_masks($db, 'structureTimer'));
                // Chain kills on without a home system: one notice to their channel (same leader, same cadence)
                if ($leader) discord_chain_notice_poll($db, dn_type_masks($db, 'chainKill'));
            }
            if ($now - $lastDispatch >= DN_DISPATCH_EVERY) {
                $lastDispatch = $now;
                $leader = discord_leader_lock($db, 'discord-dispatch');
                if ($leader !== $leaders['dispatch']) dn_log($leader ? 'sender: active' : 'sender: standby (another process holds the lock)');
                $leaders['dispatch'] = $leader;
                if ($leader) {
                    $counts = discord_dispatch($db, 20, 5.0);
                    $totals['sent'] += $counts['sent'];
                    $totals['failed'] += $counts['failed'] + $counts['broken'];
                }
            }
            if ($now - $lastPrune >= DN_PRUNE_EVERY) {
                $lastPrune = $now;
                [$expired, $deleted] = discord_outbox_prune($db);
                if ($expired || $deleted) dn_log("outbox: expired $expired, deleted $deleted old messages");
                // Preserve mass: strike the messages of holes gone from the map (once each), forget old messages
                $gone = discord_preserve_clear_gone($db);
                if ($gone) dn_log("preserve mass: queued $gone clears of holes gone from the map");
                discord_preserve_prune($db);
                // Rolling: the same (a rolled hole is gone from the map: "Hole collapsed")
                $gone = discord_rolling_clear_gone($db);
                if ($gone) dn_log("rolling: queued $gone clears of holes gone from the map");
                discord_rolling_prune($db);
            }
            if (time() - $lastHeartbeat >= DN_HEARTBEAT_EVERY) {
                $lastHeartbeat = time();
                $queued = (int) $db->query("SELECT COUNT(*) FROM discord_outbox WHERE status = 'queued'")->fetchColumn();
                dn_log("heartbeat: sent {$totals['sent']}, failed {$totals['failed']}, k-space queued {$totals['kspace']}, watchlist queued {$totals['watchlist']}, structure timers queued ".($totals['stimer'] ?? 0)." since start; $queued queued now");
            }
            $backoff = 0;
            usleep(250000);
        } catch (Throwable $error) {
            $backoff = $backoff ? min($backoff * 2, DN_BACKOFF_MAX) : 5;
            dn_log('error: ' . $error->getMessage() . "; retrying in {$backoff}s");
            if ($error instanceof PDOException) { $db = null; $leaders = ['kspace' => null, 'dispatch' => null]; }   // locks go with the connection
            sleep($backoff);
        }
    }
}

discord_log_sink('dn_log');
zk_log_sink('dn_log');
dn_run();
