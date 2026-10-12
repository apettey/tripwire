<?php
// Fork-owned: tests for the audit log (audit/audit.inc.php, the hooks in signatures.php, public/audit_log.php) against the dev
// stack's database and nginx/PHP. Fake ids only (mask 991001.0 / 991002.0, characters 991xxx); everything is deleted at the end.
//   docker compose -f docker-compose.dev.yml exec -T app php tests/audit_log_test.php
// 1. Recording: every save function of signatures.php writes the right entry (who, mask, system, before/after), wormhole
//    signatures are logged as part of their wormhole, a save with no change writes nothing, a missing table is created.
// 2. Retention: AUDIT_LOG_DAYS (0 = off, clamp, default 60), old rows never shown, audit_prune, prune on write.
// 3. Reading: filters, paging, merged mask-admin entries, mask scoping.
// 4. public/audit_log.php over HTTP: admins only, the session's mask only (a "mask" request value is ignored), GET only.
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/..');
$base = getenv('MASKADMIN_BASE') ?: 'http://127.0.0.1';
putenv('AUDIT_LOG_DAYS');   // use the default unless a check says otherwise
$mysql = new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_NAME') . ';charset=utf8mb4', getenv('DB_USER'), getenv('DB_PASSWORD'));
$mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db = $mysql;
const MASK_A = '991001.0';   // owned by OWNER_A
const MASK_B = '991002.0';   // owned by OWNER_B
const OWNER_A = 991001, OWNER_B = 991002, MEMBER = 991003, EDITOR = 991004;
const CORP = 99100010;
$_SESSION = ['mask' => MASK_A, 'userID' => 0, 'characterID' => EDITOR, 'characterName' => 'Test Editor'];
require_once(__DIR__ . '/../signatures.php');   // no $_POST on the CLI: only the classes and functions (and the audit helpers)
require_once(__DIR__ . '/../maskadmin/maskadmin.inc.php');

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
        foreach (['fork_audit_log', 'fork_mask_audit', 'fork_mask_admins', 'fork_mask_blocks', 'wormholes', 'signatures', 'statistics', '`groups`', 'masks'] as $t) {
            try { $db->prepare("DELETE FROM $t WHERE maskID = ?")->execute([$m]); } catch (PDOException $e) { if ($e->getCode() !== '42S02') throw $e; }
        }
    }
    $db->exec('DELETE FROM characters WHERE characterID BETWEEN 991001 AND 991009');
    $db->exec("DELETE FROM accounts WHERE username LIKE 'audit-test-%'");
    foreach (glob('/var/lib/php/session/sess_auditlogtest*') ?: [] as $f) @unlink($f);
}
function rows($mask = MASK_A, $where = '1') {
    global $db;
    $stmt = $db->prepare("SELECT entity, action, systemID, toSystemID, subject, detail, characterID, characterName FROM fork_audit_log WHERE maskID = ? AND $where ORDER BY id");
    $stmt->execute([$mask]);
    return array_map(function ($r) { $r['detail'] = json_decode($r['detail'], true); return $r; }, $stmt->fetchAll(PDO::FETCH_ASSOC));
}
function count_rows($mask = MASK_A) { global $db; return (int) $db->query("SELECT COUNT(*) FROM fork_audit_log WHERE maskID = '$mask'")->fetchColumn(); }
function as_actor($id, $name, $mask = MASK_A) { $_SESSION['characterID'] = $id; $_SESSION['characterName'] = $name; $_SESSION['mask'] = $mask; }

cleanup();
$db->exec("INSERT INTO accounts (username, password) VALUES ('audit-test-session', 'x')");   // statistics rows need a real user
$_SESSION['userID'] = (int) $db->lastInsertId();
$db->exec('DROP TABLE IF EXISTS fork_audit_log');   // the first write must create it
$A = 31000201; $B = 31000202; $C = 31000203;

// ---- 1. recording ----
as_actor(EDITOR, 'Test Editor');
list($ok, $sig) = addSignature(['signatureID' => 'abc123', 'systemID' => $A, 'type' => 'relic', 'name' => 'Ancient <b>site</b>'], $mysql);
check('add signature ok', $ok, true);
$r = rows();
check('table created on first write, one add row', count($r), 1);
check('add row: who, system, subject', [$r[0]['entity'], $r[0]['action'], $r[0]['characterID'], $r[0]['characterName'], $r[0]['systemID'], $r[0]['subject']], ['signature', 'add', EDITOR, 'Test Editor', $A, 'ABC123']);
check('add row: detail', $r[0]['detail'], ['id' => 'ABC123', 'type' => 'relic', 'name' => 'Ancient <b>site</b>']);

list($ok, $fetched) = fetchSignature($sig->id, $mysql);
$fetched->name = 'Renamed';
$fetched->type = 'data';
as_actor(OWNER_A, 'Test Owner');
updateSignature($fetched, $mysql);
$r = rows(MASK_A, "action = 'update'");
check('update row: one, by the second character', [count($r), $r[0]['characterID'] ?? null, $r[0]['systemID'] ?? null], [1, OWNER_A, $A]);
check('update row: before/after', $r[0]['detail']['changes'] ?? null, ['type' => ['relic', 'data'], 'name' => ['Ancient <b>site</b>', 'Renamed']]);
list($ok, $fetched) = fetchSignature($sig->id, $mysql);
updateSignature($fetched, $mysql);
check('a save with no change writes nothing', count(rows(MASK_A, "action = 'update'")), 1);
list($ok, $fetched) = fetchSignature($sig->id, $mysql);
$fetched->systemID = $B;
updateSignature($fetched, $mysql);
$r = rows(MASK_A, "action = 'update'");
check('moving a signature logs the system change', $r[1]['detail']['changes']['systemID'] ?? null, [$A, $B]);

list($ok, $fetched) = fetchSignature($sig->id, $mysql);
as_actor(EDITOR, 'Test Editor');
removeSignature($fetched, $mysql);
$r = rows(MASK_A, "action = 'delete'");
check('delete row', [count($r), $r[0]['entity'] ?? null, $r[0]['subject'] ?? null, $r[0]['systemID'] ?? null, $r[0]['detail']['name'] ?? null], [1, 'signature', 'ABC123', $B, 'Renamed']);

// a wormhole: two wormhole signatures + the hole = one "wormhole add" row
$before = count_rows();
list($ok, $s1) = addSignature(['signatureID' => 'xyz789', 'systemID' => $A, 'type' => 'wormhole', 'name' => 'A'], $mysql);
list($ok, $s2) = addSignature(['signatureID' => 'def456', 'systemID' => $C, 'type' => 'wormhole'], $mysql);
check('wormhole signatures alone write nothing', count_rows(), $before);
list($ok, $wh) = addWormhole(['initialID' => $s1->id, 'secondaryID' => $s2->id, 'type' => 'h296', 'parent' => 'initial', 'life' => 'stable', 'mass' => 'stable'], $mysql);
$r = rows(MASK_A, "entity = 'wormhole'");
check('wormhole add: one row with both systems', [count($r), $r[0]['action'], $r[0]['systemID'], $r[0]['toSystemID'], $r[0]['subject']], [1, 'add', $A, $C, 'H296']);
check('wormhole add: detail', $r[0]['detail'], ['type' => 'H296', 'life' => 'stable', 'mass' => 'stable', 'from' => 'XYZ789', 'to' => 'DEF456']);

list($ok, $w) = fetchWormhole($wh->id, $mysql);
$w->life = 'critical';
$w->mass = 'destab';
updateWormhole($w, $mysql);
$r = rows(MASK_A, "entity = 'wormhole' AND action = 'update'");
check('wormhole update: life and mass', [count($r), $r[0]['detail']['changes'] ?? null], [1, ['life' => ['stable', 'critical'], 'mass' => ['stable', 'destab']]]);
list($ok, $w) = fetchWormhole($wh->id, $mysql);
updateWormhole($w, $mysql);
check('wormhole update with no change writes nothing', count(rows(MASK_A, "entity = 'wormhole' AND action = 'update'")), 1);
list($ok, $w) = fetchWormhole($wh->id, $mysql);
$w->type = 'K162';
updateWormhole($w, $mysql);
check('wormhole type change', rows(MASK_A, "entity = 'wormhole' AND action = 'update'")[1]['detail']['changes'] ?? null, ['type' => ['H296', 'K162']]);
// where it leads
list($ok, $f2) = fetchSignature($s2->id, $mysql);
$f2->systemID = $B;
updateSignature($f2, $mysql);
$r = rows(MASK_A, "entity = 'wormhole' AND action = 'update'");
check('moving the far end logs a wormhole update (leads to)', [count($r), $r[2]['detail']['changes']['systemID'] ?? null, $r[2]['systemID']], [3, [$C, $B], $B]);
// the life change in the critical path also rewrites lifeLeft of both signatures: not logged
list($ok, $f1) = fetchSignature($s1->id, $mysql);
$f1->lifeLeft = date('Y-m-d H:i:s', strtotime('4 hour'));
updateSignature($f1, $mysql);
check('lifeLeft rewrites are not logged', count(rows(MASK_A, "entity = 'wormhole' AND action = 'update'")), 3);

as_actor(OWNER_A, 'Test Owner');
list($ok, $f1) = fetchSignature($s1->id, $mysql);
list($ok, $f2) = fetchSignature($s2->id, $mysql);
removeWormhole(['id' => $wh->id], $mysql);
removeSignature($f1, $mysql);
removeSignature($f2, $mysql);
$r = rows(MASK_A, "action = 'delete' AND entity = 'wormhole'");
check('wormhole delete: one row (its signatures add none), by whoever deleted', [count($r), $r[0]['characterID'], $r[0]['systemID'], $r[0]['toSystemID'], $r[0]['detail']['type'] ?? null], [1, OWNER_A, $A, $B, 'K162']);
check('no signature delete rows for wormhole signatures', count(rows(MASK_A, "action = 'delete' AND entity = 'signature'")), 1);
check('deleting a hole that is gone writes nothing', (function () use ($mysql) { $n = count_rows(); removeWormhole(['id' => 99999999], $mysql); return count_rows() - $n; })(), 0);

// mask scoping: another mask's session writes its own rows only
as_actor(OWNER_B, 'Test OwnerB', MASK_B);
addSignature(['signatureID' => 'bbb111', 'systemID' => $A, 'type' => 'gas'], $mysql);
check('mask B row is in mask B', [count_rows(MASK_B), rows(MASK_B)[0]['subject']], [1, 'BBB111']);
check('mask A is untouched by mask B', count(rows(MASK_A, "subject = 'BBB111'")), 0);
// a request value naming another mask changes nothing: updating a mask A signature id from a mask B session finds no row
list($ok, $a2) = addSignature(['signatureID' => 'ccc222', 'systemID' => $A, 'type' => 'gas'], $mysql);
as_actor(OWNER_A, 'Test Owner', MASK_A);
list($ok, $a3) = addSignature(['signatureID' => 'ddd333', 'systemID' => $A, 'type' => 'gas'], $mysql);
as_actor(OWNER_B, 'Test OwnerB', MASK_B);
$n = count_rows(MASK_A);
list($ok, $none) = fetchSignature($a3->id, $mysql);
check('a mask B session cannot fetch a mask A signature (so nothing to log)', $ok, false);
check('audit_signature_row is mask scoped', audit_signature_row($mysql, $a3->id), null);
check('no extra mask A rows', count_rows(MASK_A), $n);
as_actor(EDITOR, 'Test Editor', MASK_A);

// auditing never breaks a save, and a long name / odd text is clipped
list($ok, $long) = addSignature(['signatureID' => 'eee444', 'systemID' => $A, 'type' => 'combat', 'name' => str_repeat('é', 400)], $mysql);
$r = rows(MASK_A, "subject = 'EEE444'");
check('long name: save ok, clipped in the log', [$ok, mb_strlen($r[0]['detail']['name'], 'UTF-8'), strlen(json_encode($r[0]['detail'])) < 1000], [true, 60, true]);
check('bad mask is not recorded', audit_record($mysql, 'nonsense', audit_session_who(), 'signature', 'add', 1, 0, 'X', []), 0);
check('bad entity is not recorded', audit_record($mysql, MASK_A, audit_session_who(), 'mask', 'add', 1, 0, 'X', []), 0);

// ---- 2. retention ----
check('default retention', audit_days(), 60);
putenv('AUDIT_LOG_DAYS=7'); check('env retention', audit_days(), 7);
putenv('AUDIT_LOG_DAYS=99999'); check('retention clamped', audit_days(), 3650);
putenv('AUDIT_LOG_DAYS=abc'); check('junk retention falls back', audit_days(), 60);
putenv('AUDIT_LOG_DAYS=-5'); check('negative retention means off', audit_days(), 0);
putenv('AUDIT_LOG_DAYS=0');
$n = count_rows();
check('AUDIT_LOG_DAYS=0 records nothing', [audit_record($mysql, MASK_A, audit_session_who(), 'signature', 'add', 1, 0, 'X', []), count_rows()], [0, $n]);
check('AUDIT_LOG_DAYS=0 shows nothing', audit_query($mysql, MASK_A, audit_filters([]))['rows'], []);

putenv('AUDIT_LOG_DAYS=2');
$old = $db->prepare("INSERT INTO fork_audit_log (maskID, at, characterID, characterName, entity, action, systemID, subject, detail) VALUES (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR), 1, 'Old Timer', 'signature', 'add', ?, ?, '{}')");
$old->execute([MASK_A, 49, $A, 'OLD-AAA']);   // just over 2 days
$old->execute([MASK_A, 47, $A, 'NEW-BBB']);   // just under
$old->execute([MASK_B, 100, $A, 'OLD-BBB']);
$q = audit_query($mysql, MASK_A, audit_filters([]));
$subjects = array_column($q['rows'], 'subject');
check('rows older than the retention are not shown', [in_array('OLD-AAA', $subjects, true), in_array('NEW-BBB', $subjects, true)], [false, true]);
check('query reports the retention', $q['days'], 2);
check('prune deletes only the expired rows', audit_prune($mysql), 2);
check('after prune: the recent row is kept, the old ones gone (both masks)', [count(rows(MASK_A, "subject = 'NEW-BBB'")), count(rows(MASK_A, "subject = 'OLD-AAA'")), count(rows(MASK_B, "subject = 'OLD-BBB'"))], [1, 0, 0]);
check('prune with an explicit short window', (function () use ($mysql) { $n = audit_prune($mysql, 1); return $n >= 1; })(), true);
check('prune with 0 days does nothing', audit_prune($mysql, 0), 0);
// prune on write: every AUDIT_PRUNE_EVERY-th row id
$old->execute([MASK_A, 24 * 5, $A, 'OLD-CCC']);
$next = (int) ceil(((int) $db->query('SELECT MAX(id) FROM fork_audit_log')->fetchColumn() + 2) / AUDIT_PRUNE_EVERY) * AUDIT_PRUNE_EVERY;
$db->exec('ALTER TABLE fork_audit_log AUTO_INCREMENT = ' . $next);
$id = audit_record($mysql, MASK_A, audit_session_who(), 'signature', 'add', $A, 0, 'TRIGGER', ['type' => 'gas']);
check('the write that lands on a multiple of ' . AUDIT_PRUNE_EVERY . ' prunes', [$id, count(rows(MASK_A, "subject = 'OLD-CCC'"))], [$next, 0]);
putenv('AUDIT_LOG_DAYS');

// ---- 3. reading ----
foreach ([MASK_A, MASK_B] as $m) $db->prepare("DELETE FROM fork_audit_log WHERE maskID = ?")->execute([$m]);
$db->prepare('DELETE FROM fork_mask_audit WHERE maskID = ?')->execute([MASK_A]);
$ins = $db->prepare("INSERT INTO fork_audit_log (maskID, at, characterID, characterName, entity, action, systemID, toSystemID, subject, detail) VALUES (?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?, ?, ?, ?, ?, ?, ?, '{}')");
for ($i = 0; $i < 60; $i++) $ins->execute([MASK_A, 1000 + $i, 1, 'Bulk Alice', 'signature', 'add', $A, 0, sprintf('BLK-%03d', $i)]);
$ins->execute([MASK_A, 10, 2, 'Bob_100%', 'wormhole', 'update', $B, $C, 'H296']);
$ins->execute([MASK_A, 20, 3, 'Carol', 'signature', 'delete', $C, 0, 'CAR-001']);
$ins->execute([MASK_B, 5, 4, 'Dave', 'signature', 'add', $A, 0, 'MASKB']);
maskadmin_audit($mysql, MASK_A, ['id' => 5, 'name' => 'Eve'], 'block', 77, 'Mallory', 'spying');
maskadmin_audit($mysql, MASK_B, ['id' => 6, 'name' => 'Frank'], 'grant', 78, 'Gina', '');
$all = audit_query($mysql, MASK_A, audit_filters([]));
check('page 1 has 50 rows and more', [count($all['rows']), $all['hasMore'], $all['page']], [50, true, 1]);
check('newest first (the mask-admin entry was just written)', [$all['rows'][0]['src'], $all['rows'][0]['entity'], $all['rows'][0]['characterName'], $all['rows'][0]['subject']], ['m', 'mask', 'Eve', 'Mallory']);
$times = array_column($all['rows'], 'at');
$sorted = $times; rsort($sorted);
check('sorted by time descending', $times, $sorted);
check('mask B rows never appear', in_array('MASKB', array_column($all['rows'], 'subject'), true) || in_array('Frank', array_column($all['rows'], 'characterName'), true), false);
$p2 = audit_query($mysql, MASK_A, audit_filters(['page' => '2']));
check('page 2: the other 13, no more', [count($p2['rows']), $p2['hasMore'], $p2['page']], [13, false, 2]);
check('no row on both pages', count(array_intersect(array_column($all['rows'], 'subject'), array_column($p2['rows'], 'subject'))), 0);
check('page beyond the data is empty', audit_query($mysql, MASK_A, audit_filters(['page' => '9']))['rows'], []);
check('page is clamped', audit_filters(['page' => '99999'])['page'], AUDIT_MAX_PAGE);
check('filter: character (substring, case-insensitive)', array_column(audit_query($mysql, MASK_A, audit_filters(['character' => 'carol']))['rows'], 'subject'), ['CAR-001']);
check('filter: character wildcard characters are literal', array_column(audit_query($mysql, MASK_A, audit_filters(['character' => '_100%']))['rows'], 'subject'), ['H296']);
check('filter: character % alone matches nothing special', count(audit_query($mysql, MASK_A, audit_filters(['character' => '%']))['rows']), 1);
check('filter: system (either end)', array_column(audit_query($mysql, MASK_A, audit_filters(['system' => (string) $C]))['rows'], 'subject'), ['H296', 'CAR-001']);
check('filter: system excludes mask-admin entries', count(array_filter(audit_query($mysql, MASK_A, audit_filters(['system' => (string) $B]))['rows'], function ($r) { return $r['entity'] === 'mask'; })), 0);
check('filter: kind wormhole', array_column(audit_query($mysql, MASK_A, audit_filters(['kind' => 'wormhole']))['rows'], 'subject'), ['H296']);
check('filter: kind signature.delete', array_column(audit_query($mysql, MASK_A, audit_filters(['kind' => 'signature.delete']))['rows'], 'subject'), ['CAR-001']);
check('filter: kind mask', array_column(audit_query($mysql, MASK_A, audit_filters(['kind' => 'mask']))['rows'], 'subject'), ['Mallory']);
check('filter: kind mask.block', count(audit_query($mysql, MASK_A, audit_filters(['kind' => 'mask.block']))['rows']), 1);
check('filter: kind mask.grant (none on A)', count(audit_query($mysql, MASK_A, audit_filters(['kind' => 'mask.grant']))['rows']), 0);
check('filter: junk kind is ignored', audit_filters(['kind' => 'signature.drop table'])['action'], '');
check('detail of a mask-admin entry is its text', audit_query($mysql, MASK_A, audit_filters(['kind' => 'mask']))['rows'][0]['detail'], 'spying');
$today = gmdate('Y-m-d');
check('filter: date range with today', count(audit_query($mysql, MASK_A, audit_filters(['character' => 'Carol', 'from' => $today, 'to' => $today]))['rows']) <= 1, true);
check('filter: a past range excludes recent rows', audit_query($mysql, MASK_A, audit_filters(['from' => '2001-01-01', 'to' => '2001-01-31']))['rows'], []);
check('filter: bad dates are ignored', [audit_filters(['from' => '2026-13-45'])['from'], audit_filters(['to' => 'x'])['to']], [null, null]);
check('filter: injection in system / character is inert', count(audit_query($mysql, MASK_A, audit_filters(['system' => '1 OR 1=1', 'character' => "' OR '1'='1"]))['rows']), 0);

// ---- 4. over HTTP ----
$chars = [[OWNER_A, 'Test Owner', CORP, 1], [OWNER_B, 'Test OwnerB', CORP + 1, 0], [MEMBER, 'Test Member', CORP, 0]];
foreach ($chars as $i => $c) {
    $db->prepare('INSERT INTO accounts (username, password) VALUES (?, ?)')->execute(['audit-test-' . $i, 'x']);
    $uid = (int) $db->lastInsertId();
    $db->prepare('INSERT INTO characters (userID, characterID, characterName, corporationID, corporationName, admin) VALUES (?, ?, ?, ?, ?, 0)')->execute([$uid, $c[0], $c[1], $c[2], 'Corp ' . $c[2]]);
}
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, ?, 1373)')->execute([MASK_A, 'Audit mask A', OWNER_A]);
$db->prepare('INSERT INTO masks (maskID, name, ownerID, ownerType) VALUES (?, ?, ?, 1373)')->execute([MASK_B, 'Audit mask B', OWNER_B]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_A, CORP]);
$db->prepare('INSERT INTO `groups` (maskID, joined, eveID, eveType) VALUES (?, 1, ?, 2)')->execute([MASK_B, CORP + 1]);
function sess($name, $id, $charName, $corp, $mask) {
    $sid = 'auditlogtest' . $name;
    $data = ['userID' => $id, 'mask' => $mask, 'characterID' => $id, 'characterName' => $charName, 'corporationID' => $corp, 'allianceID' => null, 'admin' => 0, 'super' => 0];
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
    curl_close($ch);
    return [$status, json_decode((string) $text, true)];
}
$sOwnerA = sess('ownera', OWNER_A, 'Test Owner', CORP, MASK_A);
$sOwnerB = sess('ownerb', OWNER_B, 'Test OwnerB', CORP + 1, MASK_B);
$sMember = sess('member', MEMBER, 'Test Member', CORP, MASK_A);
list($st, $out) = http('GET', 'audit_log.php?character=carol', $sOwnerA);
check('http: owner reads the log', [$st, array_column($out['rows'] ?? [], 'subject')], [200, ['CAR-001']]);
list($st, $out) = http('GET', 'audit_log.php', $sOwnerA);
check('http: a page of 50 with paging info', [$st, count($out['rows'] ?? []), $out['hasMore'] ?? null, $out['days'] ?? null], [200, 50, true, 60]);
list($st, $out) = http('GET', 'audit_log.php?character=Alice', $sMember);
check('http: a plain member is refused', [$st, isset($out['rows'])], [403, false]);
list($st) = http('GET', 'audit_log.php', null);
check('http: no session is refused', $st, 403);
list($st, $out) = http('GET', 'audit_log.php?mask=' . urlencode(MASK_A) . '&maskID=' . urlencode(MASK_A), $sOwnerB);
check('http: owner of B sees B only, a mask value in the request is ignored', [$st, array_column($out['rows'] ?? [], 'subject')], [200, ['Gina', 'MASKB']]);
list($st, $out) = http('GET', 'audit_log.php?character=Alice', $sOwnerB);
check('http: owner of B cannot find mask A entries by filtering', [$st, $out['rows'] ?? null], [200, []]);
list($st) = http('POST', 'audit_log.php', $sOwnerA);
check('http: POST is refused', $st, 405);
list($st, $out) = http('GET', 'audit_log.php?page=2', $sOwnerA);
check('http: page 2', [$st, count($out['rows'] ?? []), $out['hasMore'] ?? null], [200, 13, false]);

cleanup();
echo "$count checks, $failures failed\n";
exit($failures ? 1 : 0);
