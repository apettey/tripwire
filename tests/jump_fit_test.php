<?php
// Fork-owned: tests for jump_fit.inc.php (auto-mass-logging).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/jump_fit_test.php
// The pure validation runs anywhere; the database part runs against the dev database in a scratch mask
// (maskID 990000001.9) and cleans up after itself. Skip it with --pure.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../jump_fit.inc.php');

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

$now = 1791640000;
$fit = array('characterID' => '91', 'fromID' => '31001880', 'toID' => '31001881', 'shipTypeID' => '641', 'fitSource' => 'assets',
	'baseMass' => '105900000', 'propTypeID' => '12068', 'propMass' => '50000000', 'higgsMult' => '2', 'fitTime' => (string)($now - 600), 'hot' => '1');

// --- jump_fit_clean_report ---
list($err, $r) = jump_fit_clean_report($fit, $now);
check('fit: no error', $err, null);
$sorted = function($a) { ksort($a); return $a; };
check('fit: values', $sorted($r), $sorted(array('characterID' => 91, 'fromID' => 31001880, 'toID' => 31001881, 'shipTypeID' => 641, 'hot' => 1,
	'fitSource' => 'assets', 'baseMass' => 105900000, 'propTypeID' => 12068, 'propMass' => 50000000, 'higgsMult' => 2.0, 'fitTime' => $now - 600)));
list($err, $r) = jump_fit_clean_report(array('characterID' => '91', 'fromID' => '31001880', 'toID' => '30000142', 'fitSource' => 'hull', 'hot' => '0',
	'baseMass' => '5', 'higgsMult' => '9'), $now);
check('hull: no error', $err, null);
check('hull: fit numbers ignored', array($r['baseMass'], $r['propMass'], $r['higgsMult'], $r['fitTime'], $r['hot'], $r['shipTypeID']), array(null, null, null, null, 0, null));
check('bad system', jump_fit_clean_report(array_merge($fit, array('toID' => '12')), $now)[0], 'Invalid character or systems');
check('same system', jump_fit_clean_report(array_merge($fit, array('toID' => '31001880')), $now)[0], 'Invalid character or systems');
check('no character', jump_fit_clean_report(array_merge($fit, array('characterID' => 'x')), $now)[0], 'Invalid character or systems');
check('bad source', jump_fit_clean_report(array_merge($fit, array('fitSource' => '<script>')), $now)[0], 'Invalid fitSource');
check('mass too big', jump_fit_clean_report(array_merge($fit, array('baseMass' => '99999999999')), $now)[0], 'Invalid fit mass');
check('negative prop', jump_fit_clean_report(array_merge($fit, array('propMass' => '-1')), $now)[0], 'Invalid fit mass');
check('higgs out of range', jump_fit_clean_report(array_merge($fit, array('higgsMult' => '0.5')), $now)[0], 'Invalid fit mass');
check('missing base mass', jump_fit_clean_report(array_merge($fit, array('baseMass' => '')), $now)[0], 'Invalid fit mass');
check('no prop module', jump_fit_clean_report(array_merge($fit, array('propTypeID' => '', 'propMass' => '0')), $now)[1]['propTypeID'], null);
check('stale fit time dropped', jump_fit_clean_report(array_merge($fit, array('fitTime' => (string)($now - 30 * 86400))), $now)[1]['fitTime'], null);
check('array input', jump_fit_clean_report(array_merge($fit, array('baseMass' => array(1))), $now)[0], 'Invalid fit mass');
check('hot anything else is cold', jump_fit_clean_report(array_merge($fit, array('hot' => 'yes')), $now)[1]['hot'], 0);

// --- jump_fit_clean_hot ---
check('hot ok', jump_fit_clean_hot(array('wormholeID' => '2', 'characterID' => '91', 'time' => '2026-10-10 19:16:55', 'hot' => '0')),
	array(null, array('wormholeID' => 2, 'characterID' => 91, 'time' => '2026-10-10 19:16:55', 'hot' => 0)));
check('hot bad time', jump_fit_clean_hot(array('wormholeID' => '2', 'characterID' => '91', 'time' => "2026-10-10' OR 1=1", 'hot' => '1'))[0], 'Invalid jump');
check('hot bad value', jump_fit_clean_hot(array('wormholeID' => '2', 'characterID' => '91', 'time' => '2026-10-10 19:16:55', 'hot' => '2'))[0], 'Invalid jump');
check('hot missing', jump_fit_clean_hot(array())[0], 'Invalid jump');

// --- Database flow (dev database) ---
if (!in_array('--pure', $argv) && getenv('DB_HOST')) {
	require(__DIR__ . '/../db.inc.php');
	$mask = '990000001.9';
	$char = 91;
	$cleanup = function() use ($mysql, $mask) {
		$mysql->exec("DELETE FROM jumps WHERE maskID = $mask");
		$mysql->exec("DELETE FROM fork_jump_fits WHERE maskID = $mask");
	};
	jump_fit_ensure_table($mysql);
	$cleanup();
	$stmt = $mysql->prepare('INSERT INTO jumps (wormholeID, characterID, characterName, fromID, toID, shipTypeID, shipType, maskID, time)
		VALUES (:w, :c, :n, :f, :t, 641, :s, :m, NOW() - INTERVAL :ago SECOND)');
	$add = function($w, $from, $to, $ago, $ship = 'Megathron|p') use ($stmt, $char, $mask) {
		$stmt->execute(array(':w' => $w, ':c' => $char, ':n' => 'Roller|P', ':f' => $from, ':t' => $to, ':s' => $ship, ':m' => $mask, ':ago' => $ago));
	};
	$add(77, 31001880, 31001881, 3600);	// an hour ago: too old to match
	// Fit time relative to the real clock: the fixed $now above is older than the 7-day window by now
	list(, $report) = jump_fit_clean_report(array_merge($fit, array('fitTime' => (string)(time() - 600))), time());
	check('db: no recent jump, no match', jump_fit_report($mysql, $mask, $report), null);
	$add(77, 31001880, 31001881, 20);
	$match = jump_fit_report($mysql, $mask, $report);
	check('db: matched the recent jump', $match !== null && $match['wormholeID'] === 77, true);
	check('db: wrong direction does not match', jump_fit_report($mysql, $mask, array_merge($report, array('fromID' => 31001881, 'toID' => 31001880))), null);

	$rows = jump_fit_jumps($mysql, $mask, 77, array());
	check('db: log has both jumps', count($rows), 2);
	check('db: newest first with the fit', array($rows[0]->fitSource, (int)$rows[0]->baseMass, (int)$rows[0]->propMass, (float)$rows[0]->higgsMult, (int)$rows[0]->hot, (int)$rows[0]->characterID),
		array('assets', 105900000, 50000000, 2.0, 1, $char));
	check('db: fit time round-trips', (int)$rows[0]->fitTime, $report['fitTime']);
	check('db: upstream columns kept', array($rows[0]->shipType, (int)$rows[0]->toID, $rows[0]->characterName), array('Megathron|p', 31001881, 'Roller|P'));
	check('db: older jump has no fit', $rows[1]->fitSource, null);

	// The pilot says cold; a repeated report keeps that choice
	check('db: set cold', jump_fit_set_hot($mysql, $mask, array('wormholeID' => 77, 'characterID' => $char, 'time' => $rows[0]->time, 'hot' => 0)), true);
	jump_fit_report($mysql, $mask, $report);
	$rows = jump_fit_jumps($mysql, $mask, 77, array());
	check('db: cold kept after a repeated report', (int)$rows[0]->hot, 0);

	// Hot/cold on a jump without a fit creates a hull-only row
	check('db: set hot on the old jump', jump_fit_set_hot($mysql, $mask, array('wormholeID' => 77, 'characterID' => $char, 'time' => $rows[1]->time, 'hot' => 1)), true);
	$rows = jump_fit_jumps($mysql, $mask, 77, array());
	check('db: hull-only row', array($rows[1]->fitSource, $rows[1]->baseMass, (int)$rows[1]->hot), array('hull', null, 1));
	check('db: unknown jump', jump_fit_set_hot($mysql, $mask, array('wormholeID' => 77, 'characterID' => $char, 'time' => '2000-01-01 00:00:00', 'hot' => 1)), false);
	check('db: other mask can\'t touch it', jump_fit_set_hot($mysql, '990000002.9', array('wormholeID' => 77, 'characterID' => $char, 'time' => $rows[1]->time, 'hot' => 0)), false);
	$cleanup();
}

echo "$count checks, $failures failures\n";
exit($failures ? 1 : 0);
