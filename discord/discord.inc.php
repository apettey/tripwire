<?php
// Fork-owned: Discord notifications (see docker/README.md#discord-notifications).
//
// Mask admins configure Discord webhooks (one webhook = one channel) and which notifications go where; the settings
// live in fork tables, one row per mask. Notifications are written to a durable outbox and sent by ONE process,
// discord_notify.worker.php, which owns Discord's rate limits. Nothing else calls Discord.
//
//   discord/schema.php      DDL (CREATE TABLE IF NOT EXISTS) for every discord_* table, reference copy in docker/sql/
//   discord/crypto.php      webhook URLs encrypted at rest with DISCORD_SECRET_KEY (when set)
//   discord/webhook.php     webhook URL validation, masking, the dev-only API base override
//   discord/template.php    message templates: placeholders, escaping of game data, allowed_mentions, embeds
//   discord/settings.php    per-mask settings: defaults, validation, loading
//   discord/routes.php      static system data + stargate graph (discord/gate_graph.php), safe-route BFS
//   discord/outbox.php      outbox + dedupe tables: enqueue, claim, prune
//   discord/kspace.php      type 1: new k-space systems near the ping systems (polls signatures/wormholes)
//   discord/kills.php       types 2-4: kills in the chain / by the corporation / losses, fed by zkill_feed.worker.php
//   discord/rally.php       type 5: the chain map's rally point, queued by public/rally.php; edits its last message
//   discord/dispatch.php    the sender: rate limits (429, X-RateLimit-*, global), retries, broken webhooks
// (The rally point's first version still posts directly to upstream's DISCORD_WEB_HOOK for masks without type 5,
// see rally_discord.inc.php.)
//
// Kills come from the pooled zKillboard integration (zkill/): zkill_feed.worker.php hands every live streamed
// killmail to discord_on_killmail(). This module never calls zKillboard or ESI.

require_once(__DIR__ . '/schema.php');
require_once(__DIR__ . '/crypto.php');
require_once(__DIR__ . '/webhook.php');
require_once(__DIR__ . '/template.php');
require_once(__DIR__ . '/settings.php');
require_once(__DIR__ . '/routes.php');
require_once(__DIR__ . '/outbox.php');
require_once(__DIR__ . '/kspace.php');
require_once(__DIR__ . '/kills.php');
require_once(__DIR__ . '/rally.php');
require_once(__DIR__ . '/dispatch.php');

/** String setting from a config.php constant or the environment ('' when unset) */
function discord_config($name) {
    $value = defined($name) ? constant($name) : getenv($name);
    return ($value === false || $value === null) ? '' : trim((string) $value);
}

/** Log sink for the module (the workers point it at their log; web requests use error_log) */
function discord_log($message) {
    $sink = discord_log_sink();
    if ($sink) $sink($message); else error_log('[discord] ' . $message);
}

function discord_log_sink(?callable $set = null) {
    static $sink = null;
    if ($set !== null) $sink = $set;
    return $sink;
}

/**
 * Leader lock (MySQL named lock, held by this connection until it closes): with several app containers on one
 * database only the holder of 'discord-dispatch' sends and only the holder of 'discord-kspace' polls, the others
 * wait as standby. Lock names are per server, so they are prefixed with the database name. Returns true while held.
 */
function discord_leader_lock(PDO $db, $name) {
    $full = "CONCAT(LEFT(DATABASE(), 40), '.', ?)";
    $stmt = $db->prepare("SELECT IS_USED_LOCK($full) = CONNECTION_ID()");
    $stmt->execute([$name]);
    if ((int) $stmt->fetchColumn() === 1) return true;
    $stmt = $db->prepare("SELECT GET_LOCK($full, 0)");
    $stmt->execute([$name]);
    return (int) $stmt->fetchColumn() === 1;
}

/** 'Y-m-d H:i:s' (UTC) -> ISO 8601; null stays null */
function discord_iso($datetime) {
    return $datetime === null ? null : str_replace(' ', 'T', (string) $datetime) . 'Z';
}

/** Public base URL of this Tripwire (for links in messages), from TRIPWIRE_DOMAIN / TRIPWIRE_HTTPS */
function discord_app_url() {
    $domain = discord_config('TRIPWIRE_DOMAIN');
    if ($domain === '') $domain = 'localhost';
    $https = filter_var(discord_config('TRIPWIRE_HTTPS') === '' ? 'true' : discord_config('TRIPWIRE_HTTPS'), FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    return ($https === false ? 'http' : 'https') . '://' . $domain . '/';
}
