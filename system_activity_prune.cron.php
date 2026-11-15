<?php
//***********************************************************
//	File: 		system_activity_prune.cron.php
//	Purpose:	Retention sweep for the system_activity table.
//***********************************************************
//
// system_activity is written once an hour for every system with traffic --
// roughly 4,900 rows an hour, about 43 million a year -- and nothing has ever
// deleted from it.
//
// Almost none of that is readable. The activity graph's widest window is a
// week (activity.time(168)), and activity_graph.php walks $length = time + 1
// hourly buckets back from now, so 169 hours is the furthest any client can
// reach. Everything older is written, indexed, backed up and never read.
//
// Deliberately a separate job rather than a few lines appended to
// system_activity.cron.php: a fault in pruning must not be able to stop
// collection, and a destructive statement belongs somewhere it can be read on
// its own.
//
// Deletes in bounded batches. A first run against a table that has never been
// pruned would otherwise be one enormous transaction -- long lock, large
// undo log, a replication stall if this is ever replicated. Each batch commits
// on its own, so the job can be killed at any point and simply picks up where
// it left off on the next run.
//
// Usage:
//   php system_activity_prune.cron.php --dry-run   report only, changes nothing
//   php system_activity_prune.cron.php             delete

require('config.php');
require('db.inc.php');

date_default_timezone_set('UTC');

// 169 hours is what the graph can actually request. The extra day is slack, so
// an hour is never pruned while a client could still be asking for it.
define('RETENTION_HOURS', 192);		// 8 days
define('BATCH_SIZE',      5000);	// about one hour of rows
define('MAX_BATCHES',     500);		// 2.5M rows per run -- a backstop, not a target

$dryRun = in_array('--dry-run', $argv, true);
$label  = $dryRun ? 'prune (dry run)' : 'prune';

// ---- Guards -------------------------------------------------------------
// Two ways this could destroy data that is still in use, both cheap to rule
// out before issuing a DELETE.

// 1. A retention window shorter than the graph's reach would silently delete
//    hours the client still plots, and the symptom would be a graph that
//    truncates rather than an error.
if (RETENTION_HOURS < 169) {
	fwrite(STDERR, $label . ": RETENTION_HOURS is " . RETENTION_HOURS . ", below the 169 hours the graph can request. Refusing.\n");
	exit(1);
}

$cutoff = gmdate('Y-m-d H:00:00', time() - (RETENTION_HOURS * 3600));

// 2. If nothing would survive the cutoff, the cutoff is wrong -- a bad clock,
//    a bad constant, or a table that stopped being written to. Deleting the
//    whole table is never the correct outcome here and is the one mistake in
//    this script that cannot be undone.
$stmt = $mysql->prepare('SELECT COUNT(*) FROM system_activity WHERE time >= :cutoff');
$stmt->bindValue(':cutoff', $cutoff);
$stmt->execute();
$surviving = (int)$stmt->fetchColumn();

if ($surviving === 0) {
	fwrite(STDERR, $label . ": cutoff " . $cutoff . " would leave the table empty. Refusing.\n");
	exit(1);
}

// ---- Report -------------------------------------------------------------

$stmt = $mysql->prepare('SELECT COUNT(*) FROM system_activity WHERE time < :cutoff');
$stmt->bindValue(':cutoff', $cutoff);
$stmt->execute();
$expired = (int)$stmt->fetchColumn();

printf("%s: cutoff %s UTC, %s rows older, %s to keep\n",
	$label, $cutoff, number_format($expired), number_format($surviving));

if ($dryRun || $expired === 0) {
	exit(0);
}

// ---- Sweep --------------------------------------------------------------
// BATCH_SIZE is interpolated because MySQL will not take a placeholder for
// LIMIT in a DELETE. It is a defined integer constant, never request data.
// ORDER BY time makes the batch use time_idx and deletes oldest first, so an
// interrupted run always leaves a contiguous tail rather than holes.

$delete = $mysql->prepare(
	'DELETE FROM system_activity WHERE time < :cutoff ORDER BY time LIMIT ' . (int)BATCH_SIZE
);

$deleted = 0;
$batches = 0;

for ($i = 0; $i < MAX_BATCHES; $i++) {
	$delete->bindValue(':cutoff', $cutoff);
	$delete->execute();

	$n = $delete->rowCount();
	$deleted += $n;
	$batches++;

	if ($n < BATCH_SIZE) { break; }

	// Yield between batches so an hourly insert or a page load is not queued
	// behind a long run of deletes.
	usleep(100000);	// 100ms
}

printf("%s: deleted %s rows in %d batch%s\n",
	$label, number_format($deleted), $batches, $batches === 1 ? '' : 'es');

if ($deleted >= MAX_BATCHES * BATCH_SIZE) {
	printf("%s: hit the per-run cap, %s rows still expired. Run again.\n",
		$label, number_format($expired - $deleted));
}
