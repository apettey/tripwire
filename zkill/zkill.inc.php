<?php
// Fork-owned: the pooled zKillboard / ESI integration (see docker/README.md#zkillboard-integration).
//
// Everything that talks to zkillboard.com, r2z2.zkillboard.com or esi.evetech.net goes through this module, and only
// one process calls it for outgoing requests: zkill_feed.worker.php. Web endpoints (public/kills.php,
// public/system_kills.php, ...) only read the tables below and, at most, add rows to the back-fill and name queues.
//
//   zkill/http.php       one HTTP client: User-Agent, per-host rate limits, 429/Retry-After, ESI error limit
//   zkill/schema.php     DDL (CREATE TABLE IF NOT EXISTS) for every zkill_* table, reference copy in docker/sql/
//   zkill/killmails.php  normalise a killmail, store it in zkill_killmails, stream coverage state, pruning
//   zkill/backfill.php   per-system back-fill queue (web: request, worker: drain via the zKillboard API)
//   zkill/names.php      ESI name cache + queue (web: look up / queue, worker: resolve via /universe/names/)
//   zkill/query.php      read helpers for endpoints (kills of systems in a window, coverage)
//
// Tables: zkill_killmails (all kills, from the stream and back-fill), zkill_state, zkill_backfill, zkill_names,
// plus Kill Reporting's zkill_kills (alert log, chain systems only, unchanged) and zkill_feed_state.

require_once(__DIR__ . '/http.php');
require_once(__DIR__ . '/schema.php');
require_once(__DIR__ . '/killmails.php');
require_once(__DIR__ . '/backfill.php');
require_once(__DIR__ . '/names.php');
require_once(__DIR__ . '/query.php');

const ZK_API_BASE  = 'https://zkillboard.com/api/';
const ZK_ESI_BASE  = 'https://esi.evetech.net/latest/';

/** Integer setting from a config.php constant or the environment, clamped to [min, max] */
function zk_config_int($name, $default, $min, $max) {
    $value = defined($name) ? constant($name) : getenv($name);
    if ($value === false || $value === null || $value === '' || !is_numeric($value)) return $default;
    return max($min, min($max, (int) $value));
}

/** Whether the instance follows zKillboard at all (ZKILL_FEED_ENABLED, default on) */
function zk_feed_enabled() {
    if (defined('ZKILL_FEED_ENABLED')) return (bool) ZKILL_FEED_ENABLED;
    $value = getenv('ZKILL_FEED_ENABLED');
    if ($value === false || $value === '') return true;
    $parsed = filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
    return $parsed === null ? true : $parsed;
}

/** How long kills stay in zkill_killmails, and the longest window an endpoint can ask for (ZKILL_RETENTION_HOURS, 1-168, default 48) */
function zk_retention_seconds() {
    return zk_config_int('ZKILL_RETENTION_HOURS', 48, 1, 168) * 3600;
}

/** Minimum seconds between requests to the zKillboard API, i.e. back-fills (ZKILL_API_INTERVAL, 1-60, default 2) */
function zk_api_interval() {
    return zk_config_int('ZKILL_API_INTERVAL', 2, 1, 60);
}

function zk_user_agent() {
    $agent = defined('USER_AGENT') ? USER_AGENT : getenv('USER_AGENT');
    return ($agent === false || $agent === null || trim($agent) === '') ? 'Tripwire kill feed (+https://github.com/apettey/tripwire)' : $agent;
}

/** Real New Eden system ID (k-space, J-space, Abyssal/Pochven ranges) */
function zk_is_system_id($id) {
    return is_int($id) && $id >= 30000000 && $id < 33000000;
}

/** 'Y-m-d H:i:s' (UTC) -> ISO 8601 'Y-m-d\TH:i:s\Z'; null stays null */
function zk_iso($datetime) {
    return $datetime === null ? null : str_replace(' ', 'T', $datetime) . 'Z';
}
