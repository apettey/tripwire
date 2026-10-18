<?php
// Fork-owned: hourly prune of the product analytics tables (analytics/analytics.inc.php, docker/README.md#product-analytics):
// counters older than ANALYTICS_DAYS, raw events older than ANALYTICS_RAW_DAYS, and an expired salt replaced.
// Run from docker/crontab; works whether or not MySQL runs its event scheduler.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }
chdir(__DIR__);
require('config.php');
require('db.inc.php');
require_once('analytics/analytics.inc.php');

if (!isset($mysql) || !($mysql instanceof PDO)) { fwrite(STDERR, "analytics prune: no database\n"); exit(1); }
$deleted = analytics_prune($mysql);
if ($deleted > 0) echo 'analytics prune: deleted ', $deleted, " rows\n";
