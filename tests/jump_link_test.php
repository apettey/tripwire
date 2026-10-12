<?php
// Fork-owned: "Which signature did you jump through?" linking against the dev stack (its MySQL, nginx/PHP in the app container, the dev
// login from docker/dev-seed.sh).
//   docker compose -f docker-compose.dev.yml exec -T app php tests/jump_link_test.php
// 1. jumplink/jumplink.inc.php directly: the link (candidate linked, names carried, jumps re-pointed, bare hole deleted, link recorded),
//    every precondition (bare hole filled in, flags, candidate linked meanwhile, other mask, wrong systems), a second link refused,
//    the mask's jump prompt mode, and the undo (bare hole and jumps back, linked hole edited since = refused, twice = refused).
// 2. public/jump_link.php over HTTP: token, CSRF / X-Requested-With / Origin / JSON checks, the session's mask being the only mask a
//    request can touch, and two simultaneous links of one bare hole (exactly one wins, the other is refused cleanly).
// Fixtures live on the dev corp mask in three fake wormhole systems and are deleted at the end (and before); the dev user's mask row
// for the bookmark settings is put back.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/..');
$base = getenv('JUMPLINK_BASE') ?: 'http://127.0.0.1';
$user = getenv('DEV_USERNAME') ?: 'dev';
$password = getenv('DEV_PASSWORD') ?: 'dev-password';
$db = new PDO('mysql:host=' . getenv('DB_HOST') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
require_once(__DIR__ . '/../jumplink/jumplink.inc.php');
require_once(__DIR__ . '/../rolling.inc.php');
require_once(__DIR__ . '/../preserve_mass.inc.php');
require_once(__DIR__ . '/../jump_fit.inc.php');
require_once(__DIR__ . '/../watchlist/watchlist.inc.php');

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

const FROM = 31990001, TO = 31990002, ELSEWHERE = 31990003;
$OTHER_MASK = '990099.0';

$stmt = $db->prepare('SELECT c.characterID, c.characterName, c.corporationID FROM accounts a INNER JOIN characters c ON c.userID = a.id WHERE a.username = ?');
$stmt->execute([$user]);
$me = $stmt->fetch(PDO::FETCH_ASSOC);
$mask = $me['corporationID'] . '.2';
$actor = ['id' => (int) $me['characterID'], 'name' => $me['characterName']];
bookmark_ensure_schema($db);
jumplink_ensure_schema($db);
rolling_ensure_table($db);
preserve_mass_ensure_table($db);
jump_fit_ensure_table($db);
watchlist_ensure_schema($db);
$stmt = $db->prepare('SELECT * FROM fork_bookmark_templates WHERE maskID = ?');
$stmt->execute([$mask]);
$savedRow = $stmt->fetch(PDO::FETCH_ASSOC);

function cleanup() {
    global $db, $mask, $OTHER_MASK;
    foreach ([$mask, $OTHER_MASK] as $m) {
        $ids = $db->prepare('SELECT id FROM signatures WHERE maskID = ? AND systemID IN (?, ?, ?)');
        $ids->execute([$m, FROM, TO, ELSEWHERE]);
        $ids = $ids->fetchAll(PDO::FETCH_COLUMN);
        // far sides with no system yet belong to holes touching these systems
        foreach ($ids as $id) {
            $w = $db->prepare('SELECT id, initialID, secondaryID FROM wormholes WHERE maskID = ? AND (initialID = ? OR secondaryID = ?)');
            $w->execute([$m, $id, $id]);
            foreach ($w->fetchAll(PDO::FETCH_ASSOC) as $row) {
                foreach (['fork_rolling', 'fork_preserve_mass', 'jumps', 'fork_jump_fits', 'fork_watchlist_seen'] as $t) {
                    try { $db->prepare("DELETE FROM $t WHERE maskID = ? AND wormholeID = ?")->execute([$m, $row['id']]); } catch (PDOException $e) { /* no table */ }
                }
                $db->prepare('DELETE FROM wormholes WHERE id = ?')->execute([$row['id']]);
                $db->prepare('DELETE FROM signatures WHERE id IN (?, ?)')->execute([$row['initialID'], $row['secondaryID']]);
            }
        }
    }
    $db->prepare("DELETE FROM jumps WHERE maskID = ? AND characterID = 990001")->execute([$mask]);
    $db->prepare('DELETE FROM fork_jump_links WHERE maskID IN (?, ?)')->execute([$mask, $OTHER_MASK]);
}
cleanup();
register_shutdown_function(function () use ($db, $mask, $savedRow) {
    cleanup();
    $db->prepare('DELETE FROM fork_bookmark_templates WHERE maskID = ?')->execute([$mask]);
    if ($savedRow) {
        $db->prepare('INSERT INTO fork_bookmark_templates (maskID, `data`, updatedBy, updatedAt) VALUES (?, ?, ?, ?)')->execute([$savedRow['maskID'], $savedRow['data'], $savedRow['updatedBy'], $savedRow['updatedAt']]);
    }
});

function sig($systemID, $signatureID = null, $name = '', $m = null, $type = 'wormhole') {
    global $db, $mask;
    $db->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, modifiedTime, maskID)
        VALUES (?, ?, ?, ?, 86400, 1, 'fixture', 1, 'fixture', '2020-01-01 00:00:00', ?)")->execute([$signatureID, $systemID, $type, $name, $m ?: $mask]);
    return (int) $db->lastInsertId();
}
function hole($a, $b, $type = null, $life = 'stable', $m = null) {
    global $db, $mask;
    $db->prepare("INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (?, ?, ?, 'initial', ?, 'stable', ?)")->execute([$a, $b, $type, $life, $m ?: $mask]);
    return (int) $db->lastInsertId();
}
/** A bare automapped hole FROM <-> TO: [wormholeID, sigInFrom, sigInTo] */
function bare($nameFrom = '', $nameTo = '') {
    $a = sig(FROM, null, $nameFrom);
    $b = sig(TO, null, $nameTo);
    return [hole($a, $b), $a, $b];
}
/** A scanned signature in $system with an unset far side: [wormholeID, sig, farSig] */
function candidate($system, $signatureID, $name = '', $m = null) {
    $c = sig($system, $signatureID, $name, $m);
    $far = sig(null, null, '', $m);
    return [hole($c, $far, 'H296', 'stable', $m), $c, $far];
}
function row($table, $id) {
    global $db;
    $s = $db->prepare("SELECT * FROM $table WHERE id = ?");
    $s->execute([$id]);
    return $s->fetch(PDO::FETCH_ASSOC);
}
function jump($wormholeID, $t) {
    global $db, $mask;
    $db->prepare("INSERT INTO jumps (wormholeID, characterID, characterName, fromID, toID, shipTypeID, shipType, maskID, time) VALUES (?, 990001, 'Fixture Pilot', ?, ?, 1, 'x', ?, ?)")->execute([$wormholeID, FROM, TO, $mask, $t]);
}
function jumps($wormholeID) {
    global $db, $mask;
    $s = $db->prepare('SELECT characterID, UNIX_TIMESTAMP(time) AS t FROM jumps WHERE wormholeID = ? AND maskID = ? ORDER BY time');
    $s->execute([$wormholeID, $mask]);
    return $s->fetchAll(PDO::FETCH_ASSOC);
}
function dolink($bare, $cand, $mode = 'nomatch', $m = null) {
    global $db, $mask, $actor;
    return jumplink_link($db, $m ?: $mask, $actor, $bare, $cand, $mode);
}

// ---- 1. the link ----
[$bw, $ba, $bb] = bare();
[$cw, $cs, $cf] = candidate(FROM, 'ABC123', 'A');
jump($bw, '2026-10-12 10:00:00');
jump($bw, '2026-10-12 10:05:00');
[$ok, $msg, $status, $data] = dolink($bw, $cs);
check('link ok', [$ok, $status], [true, 200]);
check('bare hole deleted', [row('wormholes', $bw), row('signatures', $ba), row('signatures', $bb)], [false, false, false]);
check('far side of the candidate leads to the other system', (int) row('signatures', $cf)['systemID'], TO);
check('candidate untouched', [row('signatures', $cs)['signatureID'], row('signatures', $cs)['name'], (int) row('signatures', $cs)['systemID']], ['ABC123', 'A', FROM]);
check('far side marked modified (other clients sync it)', [row('signatures', $cf)['modifiedByID'] == $actor['id'], row('signatures', $cf)['modifiedTime'] > '2024-01-01'], [true, true]);
check('jumps moved to the linked hole', [count(jumps($bw)), count(jumps($cw)), $data['moved']], [0, 2, 2]);
check('linked hole kept', [(int) row('wormholes', $cw)['id'], row('wormholes', $cw)['type']], [$cw, 'H296']);
$link = $db->query('SELECT * FROM fork_jump_links ORDER BY id DESC LIMIT 1')->fetch(PDO::FETCH_ASSOC);
check('link recorded', [(int) $link['id'] === $data['linkId'], $link['maskID'], (int) $link['wormholeID'], $link['undoneAt']], [true, number_format((float) $mask, 1, '.', ''), $cw, null]);
// a second link of the same bare hole
[$cw2, $cs2, $cf2] = candidate(FROM, 'DEF456');
[$ok, $msg, $status] = dolink($bw, $cs2);
check('second link of the same bare hole refused', [$ok, $status, stripos($msg, 'gone') !== false], [false, 409, true]);
check('and changed nothing', [$db->query("SELECT systemID FROM signatures WHERE id = $cf2")->fetchColumn(), (int) row('wormholes', $cw2)['id']], [null, $cw2]);

// the candidate linked meanwhile (by someone else)
[$bw, $ba, $bb] = bare();
[$xw, $xs, $xf] = candidate(FROM, 'GHI789');
$db->prepare('UPDATE signatures SET systemID = ? WHERE id = ?')->execute([ELSEWHERE, $xf]);
[$ok, $msg, $status] = dolink($bw, $xs);
check('candidate with a far side now: refused', [$ok, $status, stripos($msg, 'meanwhile') !== false], [false, 409, true]);
check('bare hole still there', (int) row('wormholes', $bw)['id'], $bw);
// two candidates, one bare hole: the second one is refused after the first
[$yw, $ys, $yf] = candidate(TO, 'JKL012');
[$zw, $zs, $zf] = candidate(TO, 'MNO345');
[$ok1] = dolink($bw, $ys);
[$ok2, , $status2] = dolink($bw, $zs);
check('concurrent second candidate refused', [$ok1, $ok2, $status2], [true, false, 409]);
check('a signature in the arrival system leads back to the system you left', (int) row('signatures', $yf)['systemID'], FROM);

// preconditions: the bare hole was filled in meanwhile
$cases = [
    'signature ID on the side you left' => function ($ba, $bb, $bw) use ($db) { $db->prepare("UPDATE signatures SET signatureID = 'QQQ123' WHERE id = ?")->execute([$ba]); },
    'signature ID on the arrival side' => function ($ba, $bb, $bw) use ($db) { $db->prepare("UPDATE signatures SET signatureID = 'QQQ' WHERE id = ?")->execute([$bb]); },
    'type' => function ($ba, $bb, $bw) use ($db) { $db->prepare("UPDATE wormholes SET type = 'H296' WHERE id = ?")->execute([$bw]); },
    'life' => function ($ba, $bb, $bw) use ($db) { $db->prepare("UPDATE wormholes SET life = 'critical' WHERE id = ?")->execute([$bw]); },
    'mass' => function ($ba, $bb, $bw) use ($db) { $db->prepare("UPDATE wormholes SET mass = 'destab' WHERE id = ?")->execute([$bw]); },
    'name (default mode)' => function ($ba, $bb, $bw) use ($db) { $db->prepare("UPDATE signatures SET name = 'AB' WHERE id = ?")->execute([$ba]); },
    'bookmark' => function ($ba, $bb, $bw) use ($db) { $db->prepare("UPDATE signatures SET bookmark = 'x' WHERE id = ?")->execute([$ba]); },
    'rolling flag' => function ($ba, $bb, $bw) use ($db, $mask) { rolling_set($db, $mask, $bw, 1, 'x', ''); },
    'preserve mass flag' => function ($ba, $bb, $bw) use ($db, $mask) { preserve_mass_set($db, $mask, $bw, 'x', ''); },
];
foreach ($cases as $label => $fill) {
    [$bw, $ba, $bb] = bare();
    [$kw, $ks, $kf] = candidate(FROM, 'PQR' . rand(100, 999));
    $fill($ba, $bb, $bw);
    [$ok, $msg, $status] = dolink($bw, $ks);
    check("refused: $label", [$ok, $status], [false, 409]);
    check("unchanged: $label", [(int) row('wormholes', $bw)['id'], $db->query("SELECT systemID FROM signatures WHERE id = $kf")->fetchColumn()], [$bw, null]);
}
// ... but a name is fine in "always" mode and moves over (both sides)
[$bw, $ba, $bb] = bare('AB', 'BA');
[$kw, $ks, $kf] = candidate(FROM, 'STU678');
[$ok, , , $data] = dolink($bw, $ks, 'always');
check('always mode: named bare hole linked', [$ok, row('signatures', $ks)['name'], row('signatures', $kf)['name'], (int) row('signatures', $kf)['systemID']], [true, 'AB', 'BA', TO]);
check('names carried are recorded', count($data['carried']), 2);
// "always" still refuses what is not just a name
[$bw, $ba, $bb] = bare('AB');
$db->prepare("UPDATE wormholes SET mass = 'critical' WHERE id = ?")->execute([$bw]);
[$kw, $ks, $kf] = candidate(FROM, 'VWX901');
[$ok, , $status] = dolink($bw, $ks, 'always');
check('always mode still refuses mass', [$ok, $status], [false, 409]);
// a candidate's own name is kept
[$bw, $ba, $bb] = bare('AB');
[$kw, $ks, $kf] = candidate(FROM, 'YZA234', 'KEEP');
dolink($bw, $ks, 'always');
check('candidate keeps its own name', row('signatures', $ks)['name'], 'KEEP');
// the mask turned it off
[$bw, $ba, $bb] = bare();
[$kw, $ks, $kf] = candidate(FROM, 'BCD567');
[$ok, , $status] = dolink($bw, $ks, 'off');
check('mode off refused', [$ok, $status], [false, 403]);
// bad input / not the right signatures
[$ok, , $status] = dolink(0, $ks);
check('missing ids', [$ok, $status], [false, 400]);
[$ok, , $status] = dolink($bw, $ba);
check('the bare hole itself as the candidate', [$ok, $status], [false, 404]);
[$ow, $os, $of] = candidate(ELSEWHERE, 'EFG890');
[$ok, , $status] = dolink($bw, $os);
check('a signature in neither system', [$ok, $status], [false, 409]);
[$gw, $gs, $gf] = [0, sig(FROM, 'GAS111', '', null, 'gas'), 0];
[$ok, , $status] = dolink($bw, $gs);
check('not a wormhole signature', [$ok, $status], [false, 404]);

// mask scoping: another mask's rows are invisible
[$mw, $ms, $mf] = candidate(FROM, 'HIJ123', '', $OTHER_MASK);
[$ok, , $status] = dolink($bw, $ms);
check('candidate of another mask refused', [$ok, $status], [false, 404]);
$a2 = sig(FROM, null, '', $OTHER_MASK); $b2 = sig(TO, null, '', $OTHER_MASK); $w2 = hole($a2, $b2, null, 'stable', $OTHER_MASK);
[$ok, , $status] = dolink($w2, $ks);
check('bare hole of another mask: gone', [$ok, $status], [false, 409]);
[$ok, , $status] = dolink($w2, $ks, 'nomatch', $OTHER_MASK);
check('and a candidate of this mask is not found in the other mask', [$ok, $status], [false, 404]);

// ---- undo ----
[$bw, $ba, $bb] = bare('AB');
$db->prepare("UPDATE signatures SET lifeLength = 172800 WHERE id = ?")->execute([$ba]);
[$kw, $ks, $kf] = candidate(FROM, 'KLM456');
jump($bw, '2026-10-12 11:00:00');
jump($bw, '2026-10-12 11:00:00');   // two logged in the same second (the table has no row id)
[$ok, , , $data] = dolink($bw, $ks, 'always');
check('linked for the undo test', [$ok, count(jumps($kw))], [true, 2]);
[$ok, $msg, $status, $undone] = jumplink_unlink($db, $mask, $actor, $data['linkId']);
check('unlink ok', [$ok, $status], [true, 200]);
check('far side unlinked again', [$db->query("SELECT systemID FROM signatures WHERE id = $kf")->fetchColumn(), row('signatures', $kf)['name']], [null, '']);
$newBare = row('wormholes', $undone['bareID']);
check('bare hole recreated', [$newBare['type'], $newBare['life'], $newBare['mass']], [null, 'stable', 'stable']);
$s1 = row('signatures', $newBare['initialID']); $s2 = row('signatures', $newBare['secondaryID']);
check('with its sigs', [(int) $s1['systemID'], (int) $s2['systemID'], $s1['name'], $s1['signatureID'], (int) $s1['lifeLength']], [FROM, TO, 'AB', null, 172800]);
check('jumps moved back', [count(jumps($kw)), count(jumps($undone['bareID'])), $undone['moved']], [0, 2, 2]);
[$ok, $msg, $status] = jumplink_unlink($db, $mask, $actor, $data['linkId']);
check('second undo refused', [$ok, $status], [false, 409]);
$candidateName = row('signatures', $ks)['name'];
check('the candidate was not renamed', $candidateName, '');
// and the link can be made again after the undo (new bare hole)
[$ok] = dolink($undone['bareID'], $ks, 'always');
check('link again after undo', $ok, true);
// edited since: refused, nothing touched
$latest = $db->query('SELECT id FROM fork_jump_links ORDER BY id DESC LIMIT 1')->fetchColumn();
$db->prepare('UPDATE signatures SET systemID = ? WHERE id = ?')->execute([ELSEWHERE, $kf]);
[$ok, $msg, $status] = jumplink_unlink($db, $mask, $actor, $latest);
check('undo after the linked hole was edited: refused', [$ok, $status], [false, 409]);
check('and left the hole as the editor had it', (int) row('signatures', $kf)['systemID'], ELSEWHERE);
[$ok, , $status] = jumplink_unlink($db, $OTHER_MASK, $actor, $latest);
check('another mask can not undo it', [$ok, $status], [false, 404]);
[$ok, , $status] = jumplink_unlink($db, $mask, $actor, 0);
check('unlink needs an id', [$ok, $status], [false, 400]);

// ---- jump fits, watchlist rows, what an undo checks ----
function fit($wormholeID, $characterID, $time, $baseMass) {
    global $db, $mask;
    $db->prepare("INSERT INTO fork_jump_fits (maskID, wormholeID, characterID, jumpTime, shipTypeID, fitSource, baseMass) VALUES (?, ?, ?, ?, 1, 'hull', ?)")->execute([$mask, $wormholeID, $characterID, $time, $baseMass]);
}
function fits($wormholeID) {
    global $db, $mask;
    $s = $db->prepare('SELECT characterID, jumpTime, baseMass FROM fork_jump_fits WHERE maskID = ? AND wormholeID = ? ORDER BY characterID, jumpTime');
    $s->execute([$mask, $wormholeID]);
    return $s->fetchAll(PDO::FETCH_ASSOC);
}
[$bw, $ba, $bb] = bare();
[$kw, $ks, $kf] = candidate(FROM, 'FIT111');
fit($bw, 990001, '2026-10-12 12:00:00', 100);
fit($bw, 990002, '2026-10-12 12:00:05', 200);
$db->prepare('INSERT INTO fork_watchlist_seen (maskID, filterID, systemID, wormholeID, createdAt) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())')->execute([$mask, 'f1', FROM, $bw]);
[$ok, , , $data] = dolink($bw, $ks);
check('fits moved to the linked hole', [$ok, count(fits($bw)), count(fits($kw))], [true, 0, 2]);
check('watchlist rows of the bare hole cleaned', (int) $db->query("SELECT COUNT(*) FROM fork_watchlist_seen WHERE wormholeID = $bw")->fetchColumn(), 0);
[$ok, , , $undone] = jumplink_unlink($db, $mask, $actor, $data['linkId']);
check('fits moved back on unlink', [$ok, count(fits($kw)), count(fits($undone['bareID']))], [true, 0, 2]);

// a fit the linked hole already has (same character and jump time): no 500, the linked hole's row is kept, the bare hole's copy comes back on undo
[$bw, $ba, $bb] = bare();
[$kw, $ks, $kf] = candidate(FROM, 'FIT222');
fit($bw, 990001, '2026-10-12 13:00:00', 111);
fit($bw, 990002, '2026-10-12 13:00:05', 222);
fit($kw, 990001, '2026-10-12 13:00:00', 999);   // same key as the bare hole's first fit
[$ok, $msg, $status, $data] = dolink($bw, $ks);
check('duplicate fit key: still linked', [$ok, $status], [true, 200]);
check('the linked hole keeps its own row, the other moved', array_map(function ($r) { return [(int) $r['characterID'], (int) $r['baseMass']]; }, fits($kw)), [[990001, 999], [990002, 222]]);
check('nothing left on the removed hole', count(fits($bw)), 0);
[$ok, , , $undone] = jumplink_unlink($db, $mask, $actor, $data['linkId']);
check('undo with a duplicate fit key', [$ok, array_map(function ($r) { return [(int) $r['characterID'], (int) $r['baseMass']]; }, fits($undone['bareID'])), array_map(function ($r) { return (int) $r['baseMass']; }, fits($kw))],
    [true, [[990001, 111], [990002, 222]], [999]]);

// undo refused when the linked hole's type or signature IDs changed since
foreach (['type' => "UPDATE wormholes SET type = 'C247' WHERE id = ?", 'signature ID of the candidate' => "UPDATE signatures SET signatureID = 'ZZZ999' WHERE id = ?", 'signature ID of the far side' => "UPDATE signatures SET signatureID = 'YYY888' WHERE id = ?"] as $label => $sql) {
    [$bw, $ba, $bb] = bare();
    [$kw, $ks, $kf] = candidate(FROM, 'UND' . rand(100, 999));
    [$ok, , , $data] = dolink($bw, $ks);
    $db->prepare($sql)->execute([$label === 'type' ? $kw : ($label === 'signature ID of the candidate' ? $ks : $kf)]);
    [$ok, , $status] = jumplink_unlink($db, $mask, $actor, $data['linkId']);
    check("undo refused after a change of the $label", [$ok, $status], [false, 409]);
    check("link record still open after $label", $db->query('SELECT undoneAt FROM fork_jump_links WHERE id = ' . (int) $data['linkId'])->fetchColumn(), null);
}

// a deadlock victim is retried once
check('40001 is retryable', jumplink_retryable(new PDOException('x', 0)) , false);
$e = new PDOException('Deadlock'); $e->errorInfo = ['40001', 1213, 'Deadlock found'];
check('deadlock error info is retryable', jumplink_retryable($e), true);
$calls = 0;
$r = jumplink_with_retry($db, function () use (&$calls) { $calls++; if ($calls === 1) { $x = new PDOException('Deadlock'); $x->errorInfo = ['40001', 1213, 'Deadlock']; throw $x; } return 'done'; });
check('the body runs again after a deadlock', [$r, $calls], ['done', 2]);
$calls = 0;
try { jumplink_with_retry($db, function () use (&$calls) { $calls++; $x = new PDOException('Deadlock'); $x->errorInfo = ['40001', 1213, 'Deadlock']; throw $x; }); } catch (PDOException $x) { $calls .= 'thrown'; }
check('but only once', $calls, '2thrown');

// ---- 2. over HTTP ----
function http($method, $path, $jar, $body = null, array $headers = []) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 20]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$status, json_decode((string) $text, true)];
}
function post($jar, $csrf, array $data, array $extra = []) {
    return http('POST', 'jump_link.php', $jar, json_encode($data), array_merge(['Content-Type: application/json', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf], $extra));
}
$jar = sys_get_temp_dir() . '/jumplink.cookies';
@unlink($jar);
[$status, $out] = http('POST', 'login.php', $jar, http_build_query(['mode' => 'login', 'username' => $user, 'password' => $password]));
if (($out['result'] ?? '') !== 'success') { fwrite(STDERR, "login failed (run docker/dev-seed.sh first)\n"); exit(1); }

[$status, $out] = http('GET', 'jump_link.php?mode=token', @tempnam(sys_get_temp_dir(), 'nojar'));
check('no session: refused', $status, 403);
[$status, $out] = http('GET', 'jump_link.php?mode=token', $jar);
check('token', [$status, strlen($out['csrf'] ?? '') > 20, $out['jumpPrompt'] ?? null], [200, true, 'nomatch']);
$csrf = $out['csrf'];
[$bw, $ba, $bb] = bare();
[$kw, $ks, $kf] = candidate(FROM, 'NOP789');
$body = ['mode' => 'link', 'bareID' => $bw, 'candidateSigID' => $ks];
check('no token', post($jar, '', $body)[0], 403);
check('wrong token', post($jar, 'nope', $body)[0], 403);
check('no X-Requested-With', http('POST', 'jump_link.php', $jar, json_encode($body), ['Content-Type: application/json', 'X-CSRF-Token: ' . $csrf])[0], 400);
check('not JSON', http('POST', 'jump_link.php', $jar, 'mode=link', ['Content-Type: application/x-www-form-urlencoded', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf])[0], 415);
check('cross-origin', post($jar, $csrf, $body, ['Origin: http://evil.example'])[0], 403);
check('unknown mode', post($jar, $csrf, ['mode' => 'nope'])[0], 400);
check('string ids are accepted, junk is not', [post($jar, $csrf, ['mode' => 'link', 'bareID' => 'x', 'candidateSigID' => '1'])[0]], [400]);
check('nothing changed by the refusals', (int) row('wormholes', $bw)['id'], $bw);
[$status, $out] = post($jar, $csrf, $body + ['mask' => $OTHER_MASK, 'maskID' => $OTHER_MASK]);
check('link over HTTP (a mask in the body is ignored)', [$status, $out['result'] ?? null, count(jumps($out['wormholeID'] ?? 0)) >= 0], [200, true, true]);
$linkId = $out['linkId'] ?? 0;
[$status, $out] = post($jar, $csrf, ['mode' => 'unlink', 'linkId' => $linkId]);
check('unlink over HTTP', [$status, $out['result'] ?? null], [200, true]);
[$status, $out] = post($jar, $csrf, ['mode' => 'unlink', 'linkId' => $linkId]);
check('unlink twice over HTTP', [$status, isset($out['error'])], [409, true]);
// another mask's rows can not be reached with this session, whatever the ids
[$ow, $os, $of] = candidate(FROM, 'OTH123', '', $OTHER_MASK);
[$status, $out] = post($jar, $csrf, ['mode' => 'link', 'bareID' => $newId = $db->query("SELECT id FROM wormholes WHERE maskID = '$mask' ORDER BY id DESC LIMIT 1")->fetchColumn(), 'candidateSigID' => $os]);
check('candidate of another mask over HTTP', $status, 404);
// the mask turned it off
$db->prepare('DELETE FROM fork_bookmark_templates WHERE maskID = ?')->execute([$mask]);
bookmark_save($db, $mask, ['hole' => '={name}', 'back' => '!{name}', 'jumpPrompt' => 'off'], 'test');
[$bw, $ba, $bb] = bare();
[$kw, $ks, $kf] = candidate(FROM, 'OFF123');
[$status, $out] = post($jar, $csrf, ['mode' => 'link', 'bareID' => $bw, 'candidateSigID' => $ks]);
check('mask mode off over HTTP', $status, 403);
bookmark_save($db, $mask, ['hole' => '={name}', 'back' => '!{name}', 'jumpPrompt' => 'nomatch'], 'test');

// two simultaneous links of one bare hole: exactly one wins, the other is refused cleanly
[$bw, $ba, $bb] = bare();
[$k1w, $k1s, $k1f] = candidate(FROM, 'RAC111');
[$k2w, $k2s, $k2f] = candidate(TO, 'RAC222');
[$status, $out] = http('GET', 'jump_link.php?mode=token', $jar);
$csrf = $out['csrf'];
$mh = curl_multi_init();
$handles = [];
foreach ([$k1s, $k2s] as $cand) {
    $ch = curl_init($base . '/jump_link.php');
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEFILE => $jar, CURLOPT_TIMEOUT => 20,
        CURLOPT_POSTFIELDS => json_encode(['mode' => 'link', 'bareID' => $bw, 'candidateSigID' => $cand]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Requested-With: XMLHttpRequest', 'X-CSRF-Token: ' . $csrf]]);
    curl_multi_add_handle($mh, $ch);
    $handles[] = $ch;
}
do { curl_multi_exec($mh, $running); curl_multi_select($mh, 0.2); } while ($running > 0);
$statuses = [];
foreach ($handles as $ch) { $statuses[] = curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_multi_remove_handle($mh, $ch); }
sort($statuses);
check('simultaneous links: one wins, one refused', $statuses, [200, 409]);
$linked = (int) ($db->query("SELECT COUNT(*) FROM signatures WHERE id IN ($k1f, $k2f) AND systemID IS NOT NULL")->fetchColumn());
check('exactly one candidate got linked', $linked, 1);
check('the bare hole is gone once', $db->query("SELECT COUNT(*) FROM wormholes WHERE id = $bw")->fetchColumn(), 0);

echo ($failures ? "FAILED $failures of $count\n" : "OK: $count checks\n");
exit($failures ? 1 : 0);
