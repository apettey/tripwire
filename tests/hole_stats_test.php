<?php
// Fork-owned: tests for Hole statistics' recording (holestats/holestats.inc.php, the hooks in signatures.php) and
// public/hole_stats.php, against the dev stack's database and nginx/PHP. Fake ids only (masks 992001.0 / 992002.0,
// characters 992xxx); everything is deleted at the end.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/hole_stats_test.php
// 1. What a hole looks like from home (pure): sides, K162, unknown type, no end in home.
// 2. Live recording through signatures.php: a static, its far side found later, a re-paste merged (48 h), a new hole,
//    an inbound K162, a hole moved away, no home = nothing, another mask's home.
// 3. The upsert's merge window and value rules.
// 4. Backfill: the plan from audit rows (pure: sides from parent, from where the type can lead, guesses), once per mask
//    and home, never duplicated on a re-run.
// 5. public/hole_stats.php over HTTP: the session's mask only, GET only, no session refused.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/..');
$base = getenv('MASKADMIN_BASE') ?: 'http://127.0.0.1';
$mysql = new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db = $mysql;
const MASK_A = '992001.0';
const MASK_B = '992002.0';
const MEMBER = 992003, OTHER = 992004;
const CORP = 99200010;
const HOME = 31002012;   // J163701, C5, static H296
const C5A = 31002013, C5B = 31002014, HS = 30000142;
$_SESSION = ['mask' => MASK_A, 'userID' => 0, 'characterID' => MEMBER, 'characterName' => 'Test Member'];
require_once(__DIR__ . '/../signatures.php');   // no $_POST on the CLI: only the classes and functions (and the hooks)

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
function cleanup() {
    global $db;
    foreach ([MASK_A, MASK_B] as $m) {
        foreach (['fork_hole_log', 'fork_hole_log_backfill', 'fork_audit_log', 'discord_settings', 'wormholes', 'signatures', 'statistics', '`groups`', 'masks'] as $t) {
            try { $db->prepare("DELETE FROM $t WHERE maskID = ?")->execute([$m]); } catch (PDOException $e) { if ($e->getCode() !== '42S02') throw $e; }
        }
    }
    $db->exec("DELETE FROM accounts WHERE username LIKE 'holestats-test-%'");
    foreach (glob('/var/lib/php/session/sess_holestatstest*') ?: [] as $f) @unlink($f);
}
function set_home($mask, $home) {
    global $db;
    $db->prepare('INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE settings = VALUES(settings)')
        ->execute([$mask, json_encode(['homeSystemID' => $home, 'types' => []]), 'test']);
    holestats_home($db, $mask, true);   // refresh the per-request cache
}
function log_rows($mask = MASK_A) {
    global $db;
    $stmt = $db->prepare('SELECT wormholeID, auditID, homeSig, homeType, farSystemID, farSig, farType, firstSeen, source, guessed FROM fork_hole_log WHERE maskID = ? ORDER BY firstSeen, id');
    $stmt->execute([$mask]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}
function brief($rows) {
    return array_map(function ($r) { return [$r['homeSig'], $r['homeType'], (int) $r['farSystemID'], $r['farType']]; }, $rows);
}
/** Add a hole like the Sig dialog: [sigID, systemID] per end, type and parent as sent */
function add_hole($a, $b, $type, $parent) {
    global $mysql;
    list(, $s1) = addSignature(['signatureID' => $a[0], 'systemID' => $a[1], 'type' => 'wormhole'], $mysql);
    list(, $s2) = addSignature(['signatureID' => $b[0], 'systemID' => $b[1], 'type' => 'wormhole'], $mysql);
    list(, $wh) = addWormhole(['initialID' => $s1->id, 'secondaryID' => $s2->id, 'type' => $type, 'parent' => $parent, 'life' => 'stable', 'mass' => 'stable'], $mysql);
    return [$s1, $s2, $wh];
}
function delete_hole($hole) {
    global $mysql;
    list($s1, $s2, $wh) = $hole;
    removeWormhole(['id' => $wh->id], $mysql);
    removeSignature($s1, $mysql);
    removeSignature($s2, $mysql);
}

cleanup();
$db->exec("CREATE TABLE IF NOT EXISTS `discord_settings` (`maskID` decimal(12,1) NOT NULL, `settings` mediumtext NOT NULL, `updatedBy` varchar(100) NOT NULL DEFAULT '',
    `updatedAt` datetime NOT NULL, PRIMARY KEY (`maskID`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
$db->exec("INSERT INTO accounts (username, password) VALUES ('holestats-test-session', 'x')");
$_SESSION['userID'] = (int) $db->lastInsertId();
$db->exec('DROP TABLE IF EXISTS fork_hole_log');            // the first write must create them
$db->exec('DROP TABLE IF EXISTS fork_hole_log_backfill');

// ---- 1. the view (pure) ----
$w = ['type' => 'H296', 'parent' => 'initial', 'aSystem' => HOME, 'bSystem' => 7, 'aSig' => 'ABC123', 'bSig' => null];
check('view: home typed side, far generic', holestats_view($w, HOME), ['homeSig' => 'abc123', 'homeType' => 'H296', 'farSystemID' => 0, 'farSig' => '', 'farType' => 'K162']);
check('view: home on the secondary side is the K162', holestats_view(['bSystem' => HOME, 'aSystem' => C5A] + $w, HOME)['homeType'], 'K162');
check('view: ???? on the typed side is unknown', holestats_view(['type' => '????', 'parent' => 'secondary'] + $w, HOME), ['homeSig' => 'abc123', 'homeType' => 'K162', 'farSystemID' => 0, 'farSig' => '', 'farType' => '']);
check('view: no parent, nothing known', [holestats_view(['parent' => null] + $w, HOME)['homeType'], holestats_view(['parent' => null] + $w, HOME)['farType']], ['', '']);
check('view: no end in home', holestats_view(['aSystem' => C5A, 'bSystem' => C5B] + $w, HOME), null);
check('view: no home', holestats_view($w, 0), null);
check('view: real far system kept', holestats_view(['bSystem' => C5A] + $w, HOME)['farSystemID'], C5A);
check('sig complete', [holestats_sig_complete('abc123'), holestats_sig_complete('abc'), holestats_sig_complete('abc12?')], [true, false, false]);
// unknown holes as paste.js and the automapper add them: no type, parent 'initial'. Neither end is known, whichever is home.
$unknown = ['type' => null, 'parent' => 'initial'] + $w;
check('view: no type with a parent, home initial: nothing known', [holestats_view($unknown, HOME)['homeType'], holestats_view($unknown, HOME)['farType']], ['', '']);
check('view: no type with a parent, home secondary (jumped into home): not a K162', [holestats_view(['aSystem' => C5A, 'bSystem' => HOME] + $unknown, HOME)['homeType'], holestats_view(['aSystem' => C5A, 'bSystem' => HOME] + $unknown, HOME)['farType']], ['', '']);
check('view: empty type with a parent', holestats_view(['type' => '', 'parent' => 'secondary'] + $w, HOME)['homeType'], '');
// a literal K162 type: that end is the K162, the other end is not known
check('view: K162 typed on the home side', [holestats_view(['type' => 'K162'] + $w, HOME)['homeType'], holestats_view(['type' => 'K162'] + $w, HOME)['farType']], ['K162', '']);
check('view: K162 typed on the far side', [holestats_view(['type' => 'k162', 'parent' => 'secondary'] + $w, HOME)['homeType'], holestats_view(['type' => 'k162', 'parent' => 'secondary'] + $w, HOME)['farType']], ['', 'K162']);

// ---- 2. live recording ----
check('no home: holestats_home is 0', holestats_home($db, MASK_A, true), 0);
$h0 = add_hole(['qqq111', HOME], ['', 7], 'H296', 'initial');
check('no home: nothing recorded (and no table needed)', holestats_flush(), 0);
delete_hole($h0);

set_home(MASK_A, HOME);
check('home read from the Discord settings', holestats_home($db, MASK_A), HOME);
$h1 = add_hole(['abc123', HOME], ['', 7], 'H296', 'initial');
holestats_flush();
$r = log_rows();
check('a static of home: one row, table created', brief($r), [['abc123', 'H296', 0, 'K162']]);
check('live row: source, wormhole id', [$r[0]['source'], (int) $r[0]['wormholeID']], ['live', (int) $h1[2]->id]);

// the far side is found: the far signature moves to a real system and gets its id
list(, $far) = fetchSignature($h1[1]->id, $mysql);
$far->systemID = C5A;
$far->signatureID = 'xyz789';
updateSignature($far, $mysql);
holestats_flush();
check('far side found later: same row filled in', brief(log_rows()), [['abc123', 'H296', C5A, 'K162']]);
check('far signature id kept', log_rows()[0]['farSig'], 'xyz789');

// re-pasted: deleted and added again with the same home signature id = the same hole
delete_hole($h1);
$h1b = add_hole(['abc123', HOME], ['', 7], null, null);   // pasted again without a type
holestats_flush();
$r = log_rows();
check('re-paste merged into the row, known values kept', brief($r), [['abc123', 'H296', C5A, 'K162']]);
check('re-paste: row follows the new wormhole', (int) $r[0]['wormholeID'], (int) $h1b[2]->id);

// a new static (another signature id)
$h2 = add_hole(['def456', HOME], ['', 7], 'H296', 'initial');
// an inbound K162 scanned in home, its type typed on home's side as K162 (Sig dialog: parent = the other end, ????)
$h3 = add_hole(['ghi789', HOME], ['', 11], '????', 'secondary');
holestats_flush();
check('new static and an inbound K162', array_slice(brief(log_rows()), 1), [['def456', 'H296', 0, 'K162'], ['ghi789', 'K162', 0, '']]);
// the inbound hole's type and origin are learned: M555 from high-sec, typed on the far side
list(, $w3) = fetchWormhole($h3[2]->id, $mysql);
$w3->type = 'M555';
updateWormhole($w3, $mysql);
list(, $f3) = fetchSignature($h3[1]->id, $mysql);
$f3->systemID = HS;
updateSignature($f3, $mysql);
holestats_flush();
check('inbound: origin type and system filled in', brief(log_rows())[2], ['ghi789', 'K162', HS, 'M555']);

// a hole put in home by mistake and moved: no longer home's
$h4 = add_hole(['jkl012', HOME], ['', 7], 'D845', 'initial');
holestats_flush();
check('mistake recorded first', count(log_rows()), 4);
list(, $s4) = fetchSignature($h4[0]->id, $mysql);
$s4->systemID = C5B;
updateSignature($s4, $mysql);
holestats_flush();
check('moved away from home: row removed', array_column(log_rows(), 'homeSig'), ['abc123', 'def456', 'ghi789']);

// a hole between two other systems: nothing
add_hole(['mno345', C5A], ['', 7], 'H296', 'initial');
holestats_flush();
check('a hole elsewhere is not recorded', count(log_rows()), 3);

// another mask: its own home, its own rows
$_SESSION['mask'] = MASK_B;
set_home(MASK_B, C5B);
add_hole(['pqr678', HOME], ['', 7], 'H296', 'initial');   // HOME is not mask B's home
add_hole(['stu901', C5B], ['', 7], 'H296', 'initial');
holestats_flush();
check('mask B: only its own home', brief(log_rows(MASK_B)), [['stu901', 'H296', 0, 'K162']]);
check('mask A untouched', count(log_rows(MASK_A)), 3);
$_SESSION['mask'] = MASK_A;

// the automapper maps an unscanned hole into home (home is the secondary end, no type): recorded, but not as inbound
$h5 = add_hole(['', C5A], ['', HOME], null, 'initial');
holestats_flush();
$stmt = $db->prepare('SELECT homeType, farType, farSystemID FROM fork_hole_log WHERE maskID = ? AND wormholeID = ?');
$stmt->execute([MASK_A, (int) $h5[2]->id]);
check('automapped unknown hole into home: types not known', $stmt->fetch(PDO::FETCH_NUM), ['', '', C5A]);
// it turns out to be home's static, typed on home's end later: an exact type fills in
list(, $w5) = fetchWormhole($h5[2]->id, $mysql);
$w5->type = 'H296';
$w5->parent = 'secondary';
updateWormhole($w5, $mysql);
holestats_flush();
$stmt->execute([MASK_A, (int) $h5[2]->id]);
check('typed later: a static roll', $stmt->fetch(PDO::FETCH_NUM), ['H296', 'K162', C5A]);
// an unknown type sent again later never wipes what is known
list(, $w5) = fetchWormhole($h5[2]->id, $mysql);
$w5->type = '????';
updateWormhole($w5, $mysql);
holestats_flush();
$stmt->execute([MASK_A, (int) $h5[2]->id]);
check('a less known save keeps the known home type', $stmt->fetch(PDO::FETCH_NUM), ['H296', 'K162', C5A]);
// a correction on an exact row replaces both ends: home re-typed as a K162 with the origin not known
list(, $w5) = fetchWormhole($h5[2]->id, $mysql);
$w5->type = '????';
$w5->parent = 'initial';   // the far end (initial here) typed, not known: home is the K162
updateWormhole($w5, $mysql);
holestats_flush();
$stmt->execute([MASK_A, (int) $h5[2]->id]);
check('an exact correction replaces both types (no stale far type)', $stmt->fetch(PDO::FETCH_NUM), ['K162', '', C5A]);
delete_hole($h5);
$db->prepare('DELETE FROM fork_hole_log WHERE maskID = ? AND wormholeID = ?')->execute([MASK_A, (int) $h5[2]->id]);
// first seen = when the home signature was created, not when the hole was first touched after deploy
$h6 = add_hole(['bcd234', HOME], ['', 7], 'H296', 'initial');
$db->prepare('UPDATE signatures SET lifeTime = ? WHERE id = ?')->execute([date('Y-m-d H:i:s', time() - 5 * 3600), $h6[0]->id]);
$db->prepare('DELETE FROM fork_hole_log WHERE maskID = ? AND wormholeID = ?')->execute([MASK_A, (int) $h6[2]->id]);
list(, $w6) = fetchWormhole($h6[2]->id, $mysql);
$w6->mass = 'destab';
updateWormhole($w6, $mysql);
holestats_flush();
$stmt = $db->prepare('SELECT firstSeen FROM fork_hole_log WHERE maskID = ? AND wormholeID = ?');
$stmt->execute([MASK_A, (int) $h6[2]->id]);
check('first seen from the home signature\'s creation', abs(strtotime($stmt->fetchColumn() . ' UTC') - (time() - 5 * 3600)) < 5, true);
// lastUpdated follows what was learned when, firstSeen stays at the creation
list(, $f6) = fetchSignature($h6[1]->id, $mysql);
$f6->systemID = C5A;
updateSignature($f6, $mysql);
holestats_flush(time() + 3 * 3600);
$stmt = $db->prepare('SELECT firstSeen, lastUpdated, farSystemID FROM fork_hole_log WHERE maskID = ? AND wormholeID = ?');
$stmt->execute([MASK_A, (int) $h6[2]->id]);
$t6 = $stmt->fetch(PDO::FETCH_NUM);
check('far side found later: lastUpdated moves on, firstSeen stays', [abs(strtotime($t6[0] . ' UTC') - (time() - 5 * 3600)) < 5, abs(strtotime($t6[1] . ' UTC') - (time() + 3 * 3600)) < 5, (int) $t6[2]],
    [true, true, C5A]);
delete_hole($h6);
$db->prepare('DELETE FROM fork_hole_log WHERE maskID = ? AND wormholeID = ?')->execute([MASK_A, (int) $h6[2]->id]);

// ---- 3. upsert: merge window and value rules ----
$view = ['homeSig' => 'vwx234', 'homeType' => 'H296', 'farSystemID' => 0, 'farSig' => '', 'farType' => 'K162'];
holestats_upsert($db, MASK_A, HOME, $view, '2026-01-01 00:00:00', ['wormholeID' => 900001]);
holestats_upsert($db, MASK_A, HOME, $view, '2026-01-02 23:00:00', ['wormholeID' => 900002]);   // 47 h later: same hole
holestats_upsert($db, MASK_A, HOME, $view, '2026-01-03 01:00:00', ['wormholeID' => 900003]);   // 49 h after the first: a new hole
$stmt = $db->prepare("SELECT wormholeID, firstSeen FROM fork_hole_log WHERE maskID = ? AND homeSig = 'vwx234' ORDER BY firstSeen");
$stmt->execute([MASK_A]);
$merged = $stmt->fetchAll(PDO::FETCH_NUM);
check('merge within 48 h of the first sighting, not after', array_map(function ($r) { return [(int) $r[0], $r[1]]; }, $merged),
    [[900002, '2026-01-01 00:00:00'], [900003, '2026-01-03 01:00:00']]);
$incomplete = ['homeSig' => 'abc', 'homeType' => 'H296', 'farSystemID' => 0, 'farSig' => '', 'farType' => 'K162'];
holestats_upsert($db, MASK_A, HOME, $incomplete, '2026-01-05 00:00:00', ['wormholeID' => 900010]);
holestats_upsert($db, MASK_A, HOME, $incomplete, '2026-01-05 01:00:00', ['wormholeID' => 900011]);
check('an incomplete signature id never merges', (int) $db->query("SELECT COUNT(*) FROM fork_hole_log WHERE maskID = '" . MASK_A . "' AND homeSig = 'abc'")->fetchColumn(), 2);
// a guessed type never replaces an exact one; an exact one replaces a guess
$id = holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'yza567', 'homeType' => 'K162', 'farSystemID' => 0, 'farSig' => '', 'farType' => 'H296'], '2026-02-01 00:00:00', ['source' => 'backfill', 'guessed' => true]);
holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'yza567', 'homeType' => 'H296', 'farSystemID' => C5A, 'farSig' => '', 'farType' => 'K162'], '2026-02-01 05:00:00', ['wormholeID' => 900020]);
$row = $db->query('SELECT homeType, farSystemID, guessed, source FROM fork_hole_log WHERE id = ' . (int) $id)->fetch(PDO::FETCH_ASSOC);
check('exact types replace a guess (and the far system fills in)', [$row['homeType'], (int) $row['farSystemID'], (int) $row['guessed'], $row['source']], ['H296', C5A, 0, 'backfill']);
holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'yza567', 'homeType' => 'K162', 'farSystemID' => 0, 'farSig' => '', 'farType' => 'H296'], '2026-02-01 06:00:00', ['guessed' => true]);
check('a guess never replaces exact types', $db->query('SELECT homeType FROM fork_hole_log WHERE id = ' . (int) $id)->fetchColumn(), 'H296');
// what is known fills in, field by field
$id2 = holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'efg890', 'homeType' => 'H296', 'farSystemID' => 0, 'farSig' => '', 'farType' => ''], '2026-02-10 00:00:00', ['wormholeID' => 900030]);
holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'efg890', 'homeType' => '', 'farSystemID' => C5B, 'farSig' => 'hij123', 'farType' => 'K162'], '2026-02-10 01:00:00', ['wormholeID' => 900030]);
check('fields fill in one by one', $db->query('SELECT homeType, farType, farSystemID, farSig FROM fork_hole_log WHERE id = ' . (int) $id2)->fetch(PDO::FETCH_NUM), ['H296', 'K162', C5B, 'hij123']);
// exact views: a far-only K162 keeps a known home type, but not a home K162 (that end was the inbound side)
$id3 = holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'klm456', 'homeType' => 'K162', 'farSystemID' => HS, 'farSig' => '', 'farType' => 'M555'], '2026-02-12 00:00:00', ['wormholeID' => 900040]);
holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'klm456', 'homeType' => '', 'farSystemID' => 0, 'farSig' => '', 'farType' => 'K162'], '2026-02-12 01:00:00', ['wormholeID' => 900040]);
check('exact: home K162 re-entered as the far K162', $db->query('SELECT homeType, farType FROM fork_hole_log WHERE id = ' . (int) $id3)->fetch(PDO::FETCH_NUM), ['', 'K162']);
// guessed views still fill in field by field
$id4 = holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'nop789', 'homeType' => 'H296', 'farSystemID' => 0, 'farSig' => '', 'farType' => ''], '2026-02-13 00:00:00', ['source' => 'backfill', 'guessed' => true]);
holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'nop789', 'homeType' => '', 'farSystemID' => 0, 'farSig' => '', 'farType' => 'K162'], '2026-02-13 01:00:00', ['source' => 'backfill', 'guessed' => true]);
check('guessed: fill in field by field', $db->query('SELECT homeType, farType, guessed FROM fork_hole_log WHERE id = ' . (int) $id4)->fetch(PDO::FETCH_NUM), ['H296', 'K162', 1]);
// firstSeen only moves earlier (a hole touched after deploy, then backfilled with its real first sighting)
holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'efg890', 'homeType' => '', 'farSystemID' => 0, 'farSig' => '', 'farType' => ''], '2026-02-09 08:00:00', ['source' => 'backfill']);
holestats_upsert($db, MASK_A, HOME, ['homeSig' => 'efg890', 'homeType' => '', 'farSystemID' => 0, 'farSig' => '', 'farType' => ''], '2026-02-10 05:00:00', ['wormholeID' => 900030]);
check('firstSeen moves earlier, never later', $db->query('SELECT firstSeen, lastUpdated FROM fork_hole_log WHERE id = ' . (int) $id2)->fetch(PDO::FETCH_NUM), ['2026-02-09 08:00:00', '2026-02-10 05:00:00']);
$db->prepare("DELETE FROM fork_hole_log WHERE maskID = ? AND firstSeen < '2026-03-01'")->execute([MASK_A]);

// ---- 4. backfill ----
$data = holestats_game_data();
check('game data: home is a C5 with an H296 static, far systems C5', [holestats_space(HOME, $data), $data['systems'][HOME]['statics'], holestats_space(C5A, $data), holestats_space(HS, $data)],
    ['Class-5', ['H296'], 'Class-5', 'High-Sec']);
check('game data: H296 spawns in and leads to C5', $data['wormholes']['H296'], ['from' => ['Class-5'], 'leadsTo' => 'Class-5']);
check('space of a generic far side', [holestats_space(7, $data), holestats_space(2, $data), holestats_space(11, $data)], ['Class-5', 'High-Sec', '']);
// sides
check('guess: no type', holestats_guess_side('', 'a', HOME, 7, ['H296'], $data), [null, false]);
check('guess: ???? = K162 on the initial side', holestats_guess_side('????', 'a', HOME, 7, ['H296'], $data), ['b', true]);
check('guess: M555 (HS -> C5) from HS into home', holestats_guess_side('M555', 'a', HOME, HS, ['H296'], $data), ['b', false]);
check('guess: M555 with the far side unknown only fits inbound', holestats_guess_side('M555', 'b', 11, HOME, ['H296'], $data), ['a', false]);
check('guess: C140 (C5/C6 -> LS) from home to low-sec is outgoing', holestats_guess_side('C140', 'a', HOME, 1, ['H296'], $data), ['a', false]);
check('guess: a type not in the game data', holestats_guess_side('XX99', 'b', 7, HOME, ['H296'], $data), ['a', true]);
check('guess: H296 C5 to C5, both fit: home\'s static', holestats_guess_side('H296', 'b', C5A, HOME, ['H296'], $data), ['b', true]);
check('guess: both fit, not a static: the initial side', holestats_guess_side('H296', 'b', C5A, HOME, ['C140'], $data), ['a', true]);

$audit = function ($id, $at, $action, $sys, $to, $subject, $detail) {
    return ['id' => $id, 'at' => $at, 'action' => $action, 'systemID' => $sys, 'toSystemID' => $to, 'subject' => $subject, 'detail' => json_encode($detail)];
};
$rows = [
    $audit(1, '2026-10-01 10:00:00', 'add', HOME, 7, 'H296', ['type' => 'H296', 'life' => 'stable', 'mass' => 'stable', 'from' => 'AAA111', 'to' => 'BBB222']),
    $audit(2, '2026-10-01 11:00:00', 'update', C5A, 0, 'BBB222', ['id' => 'BBB222', 'changes' => ['systemID' => [7, C5A]]]),   // far side found
    $audit(3, '2026-10-02 10:00:00', 'add', HOME, 11, '????', ['type' => '????', 'life' => 'stable', 'mass' => 'stable', 'from' => 'CCC333']),
    $audit(4, '2026-10-02 12:00:00', 'update', HOME, 11, 'M555', ['from' => 'CCC333', 'to' => '', 'changes' => ['type' => ['????', 'M555']]]),
    $audit(5, '2026-10-03 10:00:00', 'add', C5A, HOME, 'H296', ['type' => 'H296', 'life' => 'stable', 'mass' => 'stable', 'parent' => 'secondary', 'from' => 'DDD444', 'to' => 'EEE555']),
    $audit(6, '2026-10-03 11:00:00', 'add', C5A, C5B, 'H296', ['type' => 'H296', 'from' => 'FFF666', 'to' => 'GGG777']),   // not home's
    $audit(7, '2026-10-04 10:00:00', 'add', HOME, 7, 'H296', ['type' => 'H296', 'from' => 'HHH888']),
    $audit(8, '2026-10-04 11:00:00', 'update', HOME, 7, 'H296', ['from' => 'HHH888', 'to' => '', 'changes' => ['parent' => ['initial', 'secondary']]]),
    $audit(9, '2026-10-04 12:00:00', 'delete', HOME, 7, 'H296', ['type' => 'H296', 'from' => 'HHH888']),
    $audit(10, '2026-10-05 10:00:00', 'add', HOME, 7, 'H296', ['type' => 'H296', 'from' => 'III999']),
    $audit(11, '2026-10-05 10:30:00', 'update', C5B, 0, 'III999', ['id' => 'III999', 'changes' => ['systemID' => [HOME, C5B]]]),   // moved away
    $audit(12, '2026-10-06 10:00:00', 'add', HOME, 7, 'H296', ['type' => 'H296', 'from' => 'JJJ000']),
    $audit(13, '2026-10-06 11:00:00', 'update', HOME, 0, 'JJJ001', ['id' => 'JJJ001', 'changes' => ['signatureID' => ['jjj000', 'jjj001']]]),   // id corrected
];
$plan = holestats_backfill_plan($rows, HOME, ['H296'], $data);
$planBrief = array_map(function ($p) { return [$p['auditID'], $p['view']['homeSig'], $p['view']['homeType'], $p['view']['farSystemID'], $p['view']['farType'], $p['guessed']]; }, $plan);
check('backfill plan', $planBrief, [
    [1, 'aaa111', 'H296', C5A, 'K162', true],     // H296 C5 -> C5 between two C5s: either way, taken as home's static (a guess)
    [3, 'ccc333', 'K162', 0, 'M555', false],      // M555 only leads into a C5 (from high-sec)
    [5, 'eee555', 'H296', C5A, 'K162', false],    // parent said so
    [7, 'hhh888', 'K162', 0, 'H296', false],      // parent changed to secondary
    [12, 'jjj001', 'H296', 0, 'K162', true],
]);
check('backfill plan times', [$plan[0]['at'], $plan[0]['lastAt'], $plan[3]['lastAt']], ['2026-10-01 10:00:00', '2026-10-01 11:00:00', '2026-10-04 12:00:00']);

// A pasted hole (no far signature id) filled in later by the Sig dialog, as the audit log wrote it before it kept `wh`:
// the far signature update has no old id, the wormhole update names the far id the plan never saw
$pasted = [
    $audit(21, '2026-10-07 10:00:00', 'add', HOME, 11, '', ['type' => '', 'life' => 'stable', 'mass' => 'stable', 'from' => 'ABC123']),
    $audit(22, '2026-10-07 10:05:00', 'update', C5A, 0, 'XYZ789', ['id' => 'XYZ789', 'changes' => ['signatureID' => ['', 'xyz789'], 'systemID' => [11, C5A]]]),
    $audit(23, '2026-10-07 10:05:00', 'update', HOME, C5A, 'H296', ['from' => 'ABC123', 'to' => 'XYZ789', 'changes' => ['type' => ['', 'H296'], 'parent' => ['', 'initial']]]),
];
$p = holestats_backfill_plan($pasted, HOME, ['H296'], $data);
check('plan: paste in home, then the dialog fills far sig, leads-to and type', [$p[0]['view'], $p[0]['guessed'], $p[0]['lastAt']],
    [['homeSig' => 'abc123', 'homeType' => 'H296', 'farSystemID' => C5A, 'farSig' => 'xyz789', 'farType' => 'K162'], false, '2026-10-07 10:05:00']);
// the same without the signature row (only the wormhole row): the far system comes from the wormhole row's systems
$p = holestats_backfill_plan([$pasted[0], $pasted[2]], HOME, ['H296'], $data);
check('plan: the wormhole row alone gives the far id and system', [$p[0]['view']['farSig'], $p[0]['view']['farSystemID'], $p[0]['view']['homeType']], ['xyz789', C5A, 'H296']);
// leads-to set with no far id and no wormhole change: applied when only one hole of home lacks a far id ...
$p = holestats_backfill_plan([$pasted[0], $audit(24, '2026-10-07 11:00:00', 'update', C5A, 0, '', ['id' => '', 'changes' => ['systemID' => [11, C5A]]])], HOME, ['H296'], $data);
check('plan: leads-to without a far id, one candidate', $p[0]['view']['farSystemID'], C5A);
// ... and left alone when it is ambiguous
$two = [$pasted[0], $audit(25, '2026-10-07 10:30:00', 'add', HOME, 11, '', ['type' => '', 'from' => 'DEF456']),
    $audit(26, '2026-10-07 11:00:00', 'update', C5A, 0, '', ['id' => '', 'changes' => ['systemID' => [11, C5A]]])];
$p = holestats_backfill_plan($two, HOME, ['H296'], $data);
check('plan: leads-to without a far id, two candidates: not applied', [$p[0]['view']['farSystemID'], $p[1]['view']['farSystemID']], [0, 0]);
// rows that carry the wormhole id (`wh`) are followed by it, even with no signature ids at all
$withWh = [
    $audit(31, '2026-10-08 10:00:00', 'add', C5B, HOME, '', ['type' => '', 'parent' => 'initial', 'wh' => 501]),   // automapped into home
    $audit(32, '2026-10-08 10:01:00', 'add', HOME, 11, '', ['type' => '', 'parent' => 'initial', 'from' => 'GHI789', 'wh' => 502]),
    $audit(33, '2026-10-08 11:00:00', 'update', HOME, 0, 'JKL012', ['id' => 'JKL012', 'changes' => ['signatureID' => ['', 'jkl012']], 'wh' => 501]),
    $audit(34, '2026-10-08 11:00:00', 'update', C5B, HOME, 'H296', ['from' => '', 'to' => 'JKL012', 'changes' => ['type' => ['', 'H296'], 'parent' => ['initial', 'secondary']], 'wh' => 501]),
    $audit(35, '2026-10-08 12:00:00', 'update', HS, 0, 'MNO345', ['id' => 'MNO345', 'changes' => ['signatureID' => ['', 'mno345'], 'systemID' => [11, HS]], 'wh' => 502]),
    $audit(36, '2026-10-08 12:00:00', 'update', HOME, HS, 'M555', ['from' => 'GHI789', 'to' => 'MNO345', 'changes' => ['type' => ['', 'M555'], 'parent' => ['initial', 'secondary']], 'wh' => 502]),
];
$p = holestats_backfill_plan($withWh, HOME, ['H296'], $data);
check('plan: followed by wormhole id', array_map(function ($x) { return [$x['view']['homeSig'], $x['view']['homeType'], $x['view']['farSystemID'], $x['view']['farType'], $x['guessed']]; }, $p),
    [['jkl012', 'H296', C5B, 'K162', false], ['ghi789', 'K162', HS, 'M555', false]]);
// new audit rows with parent 'initial' and no type (a paste): nothing known, not a K162
$p = holestats_backfill_plan([$audit(41, '2026-10-09 10:00:00', 'add', C5A, HOME, '', ['type' => '', 'parent' => 'initial', 'from' => 'PQR678', 'to' => 'STU901'])], HOME, ['H296'], $data);
check('plan: a typeless hole with a parent is not inbound', [$p[0]['view']['homeType'], $p[0]['view']['farType']], ['', '']);
check('guess: a literal K162 with no parent is taken as the initial end', holestats_guess_side('K162', 'b', C5A, HOME, ['H296'], $data), ['a', true]);

$db->prepare("DELETE FROM fork_hole_log WHERE maskID = ?")->execute([MASK_A]);
// audit rows in the database for the real backfill: a static (exact parent) and an inbound K162, plus one already on the map
$ins = $db->prepare('INSERT INTO fork_audit_log (maskID, at, characterID, characterName, entity, action, systemID, toSystemID, subject, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
$db->exec(AUDIT_DDL);
$db->prepare('DELETE FROM fork_audit_log WHERE maskID = ?')->execute([MASK_A]);   // the live part above wrote some
$ins->execute([MASK_A, '2026-10-10 10:00:00', MEMBER, 'Test Member', 'wormhole', 'add', HOME, C5A, 'H296', json_encode(['type' => 'H296', 'life' => 'stable', 'mass' => 'stable', 'parent' => 'initial', 'from' => 'KKK111', 'to' => 'LLL222'])]);
$ins->execute([MASK_A, '2026-10-11 10:00:00', MEMBER, 'Test Member', 'wormhole', 'add', C5B, HOME, '????', json_encode(['type' => '????', 'life' => 'stable', 'mass' => 'stable', 'parent' => 'initial', 'from' => 'MMM333', 'to' => 'NNN444'])]);
$ins->execute([MASK_A, gmdate('Y-m-d H:i:s', time() - 3600), MEMBER, 'Test Member', 'wormhole', 'add', HOME, 7, 'H296', json_encode(['type' => 'H296', 'life' => 'stable', 'mass' => 'stable', 'parent' => 'initial', 'from' => 'DEF456'])]);
$db->exec("DELETE FROM fork_hole_log_backfill WHERE maskID = '" . MASK_A . "'");
$stamp = holestats_backfill($db, MASK_A, HOME);
$r = log_rows();
check('backfill: audit holes and the map', array_map(function ($x) { return [$x['homeSig'], $x['homeType'], (int) $x['farSystemID'], $x['farType'], $x['source']]; }, $r), [
    ['kkk111', 'H296', C5A, 'K162', 'backfill'],
    ['nnn444', 'K162', C5B, '', 'backfill'],
    ['def456', 'H296', 0, 'K162', 'backfill'],   // in the audit log an hour ago and on the map now: one hole
    ['abc123', '', 0, '', 'backfill'],           // on the map, re-pasted without a type
    ['ghi789', 'K162', HS, 'M555', 'backfill'],
]);
check('backfill stamp', [is_array($stamp), $stamp['rows'] ?? null], [true, count($r)]);
$again = holestats_backfill($db, MASK_A, HOME);
check('backfill runs once per mask and home', [count(log_rows()), $again['doneAt'] ?? null], [count($r), $stamp['doneAt']]);
$db->exec("DELETE FROM fork_hole_log_backfill WHERE maskID = '" . MASK_A . "'");
holestats_backfill($db, MASK_A, HOME);
check('a re-run (stamp deleted) never duplicates', count(log_rows()), count($r));
check('no home: no backfill', holestats_backfill($db, MASK_A, 0), null);
// the stamp: a backfill still running is left alone; one that died (stale claim) is run again by the next open
$db->prepare("UPDATE fork_hole_log_backfill SET state = 'running', doneAt = UTC_TIMESTAMP() WHERE maskID = ?")->execute([MASK_A]);
check('a running backfill: no second one, no stamp to show', holestats_backfill($db, MASK_A, HOME), null);
$db->prepare("UPDATE fork_hole_log_backfill SET doneAt = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 11 MINUTE) WHERE maskID = ?")->execute([MASK_A]);
$again = holestats_backfill($db, MASK_A, HOME);
check('a stale claim is taken over and finished', [is_array($again), $again['capped'] ?? null, count(log_rows())], [true, false, count($r)]);
check('stamp done', $db->query("SELECT state FROM fork_hole_log_backfill WHERE maskID = '" . MASK_A . "'")->fetchColumn(), 'done');

// Live recording before the first backfill: audit holes merge into their live rows, nothing is counted twice, and audit
// holes inside the live period that were never recorded live (added and deleted) are still backfilled
$db->prepare('DELETE FROM fork_hole_log WHERE maskID = ?')->execute([MASK_A]);
$db->prepare('DELETE FROM fork_hole_log_backfill WHERE maskID = ?')->execute([MASK_A]);
$db->prepare('DELETE FROM fork_audit_log WHERE maskID = ?')->execute([MASK_A]);
// a hole from before the deploy (old audit row: no wh, no parent), touched after it: a live row first seen 3 h ago
$hp = add_hole(['pre111', HOME], ['', 7], 'H296', 'initial');
$db->prepare('UPDATE signatures SET lifeTime = ? WHERE id = ?')->execute([date('Y-m-d H:i:s', time() - 3 * 3600), $hp[0]->id]);
holestats_flush();
$db->prepare('DELETE FROM fork_audit_log WHERE maskID = ?')->execute([MASK_A]);
$ins->execute([MASK_A, gmdate('Y-m-d H:i:s', time() - 3 * 3600), MEMBER, 'Test Member', 'wormhole', 'add', HOME, 7, 'H296', json_encode(['type' => 'H296', 'life' => 'stable', 'mass' => 'stable', 'from' => 'PRE111'])]);
// a hole recorded live since: its audit rows carry wh
$hw = add_hole(['whl222', HOME], ['', 7], 'H296', 'initial');
holestats_flush();
// a hole added and deleted 30 minutes ago that live recording never saw (audit rows only)
$ins->execute([MASK_A, gmdate('Y-m-d H:i:s', time() - 1800), MEMBER, 'Test Member', 'wormhole', 'add', HOME, C5A, 'H296', json_encode(['type' => 'H296', 'life' => 'stable', 'mass' => 'stable', 'parent' => 'initial', 'from' => 'INW333', 'wh' => 999001])]);
$ins->execute([MASK_A, gmdate('Y-m-d H:i:s', time() - 1700), MEMBER, 'Test Member', 'wormhole', 'delete', HOME, C5A, 'H296', json_encode(['type' => 'H296', 'life' => 'stable', 'mass' => 'stable', 'parent' => 'initial', 'from' => 'INW333', 'wh' => 999001])]);
holestats_backfill($db, MASK_A, HOME);
$stmt = $db->prepare("SELECT homeSig, source, wormholeID, homeType FROM fork_hole_log WHERE maskID = ? AND homeSig IN ('pre111', 'whl222', 'inw333') ORDER BY homeSig");
$stmt->execute([MASK_A]);
check('backfill after live recording: one row per hole, live rows kept, the unseen hole added', array_map(function ($x) { return [$x[0], $x[1], (int) $x[2], $x[3]]; }, $stmt->fetchAll(PDO::FETCH_NUM)), [
    ['inw333', 'backfill', 999001, 'H296'],
    ['pre111', 'live', (int) $hp[2]->id, 'H296'],
    ['whl222', 'live', (int) $hw[2]->id, 'H296'],
]);
$db->prepare('DELETE FROM fork_hole_log_backfill WHERE maskID = ?')->execute([MASK_A]);
holestats_backfill($db, MASK_A, HOME);
$stmt->execute([MASK_A]);
check('... and a re-run adds nothing', count($stmt->fetchAll(PDO::FETCH_NUM)), 3);
delete_hole($hp);
delete_hole($hw);
$r = log_rows();

// ---- 5. public/hole_stats.php ----
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, ?, 1373)')->execute([MASK_A, 'Hole stats A', OTHER]);
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, ?, 1373)')->execute([MASK_B, 'Hole stats B', OTHER]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_A, CORP]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_B, CORP + 1]);
function sess($name, $id, $corp, $mask) {
    $sid = 'holestatstest' . $name;
    $data = ['userID' => $id, 'mask' => $mask, 'characterID' => $id, 'characterName' => 'Test ' . $name, 'corporationID' => $corp, 'allianceID' => null, 'admin' => 0, 'super' => 0];
    $payload = '';
    foreach ($data as $k => $v) $payload .= $k . '|' . serialize($v);
    $path = '/var/lib/php/session/sess_' . $sid;
    file_put_contents($path, $payload);
    @chown($path, 'www-data');
    @chmod($path, 0600);
    return $sid;
}
function http($method, $path, $sid) {
    global $base;
    $ch = curl_init($base . '/' . ltrim($path, '/'));
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $sid ? ['Cookie: PHPSESSID=' . $sid] : [], CURLOPT_TIMEOUT => 20]);
    $text = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    return [$status, json_decode((string) $text, true)];
}
$sA = sess('member', MEMBER, CORP, MASK_A);
$sB = sess('other', OTHER, CORP + 1, MASK_B);
list($st, $out) = http('GET', 'hole_stats.php?mode=home', $sA);
check('http: home of the session mask', [$st, $out['home'] ?? null], [200, HOME]);
list($st, $out) = http('GET', 'hole_stats.php?mode=rows&mask=' . urlencode(MASK_B), $sA);
check('http: a member reads its mask\'s rows (a mask value is ignored)', [$st, $out['home'] ?? null, count($out['rows'] ?? []), $out['capped'] ?? null], [200, HOME, count($r), false]);
check('http: newest first', ($out['rows'][0]['firstSeen'] ?? '') >= ($out['rows'][count($out['rows']) - 1]['firstSeen'] ?? ''), true);
list($st, $out) = http('GET', 'hole_stats.php?mode=rows', $sB);
check('http: mask B sees its own home and rows, backfilled once', [$st, $out['home'] ?? null, array_column($out['rows'] ?? [], 'homeSig')], [200, C5B, ['stu901']]);
list($st) = http('POST', 'hole_stats.php?mode=rows', $sA);
check('http: GET only', $st, 405);
list($st) = http('GET', 'hole_stats.php?mode=rows', null);
check('http: no session is refused', $st, 403);
list($st) = http('GET', 'hole_stats.php?mode=nope', $sA);
check('http: unknown mode', $st, 400);
$db->prepare('DELETE FROM discord_settings WHERE maskID = ?')->execute([MASK_A]);
list($st, $out) = http('GET', 'hole_stats.php?mode=rows', $sA);
check('http: no home, no rows', [$st, $out['home'] ?? null, $out['rows'] ?? null], [200, 0, []]);

cleanup();
echo "$count checks, $failures failures\n";
exit($failures ? 1 : 0);
