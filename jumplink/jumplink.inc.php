<?php
// Fork-owned: "Which signature did you jump through?" linking, done as ONE server-side operation (see
// docker/README.md#bookmark-names, public/jump_link.php, app/js/fork/jump-sig-prompt.js).
//
// After a jump the automapper may have made a bare hole (two sigs with no ID, name or type) between the two systems. When the pilot
// says which scanned signature they went through, the bare hole is replaced by that signature's hole: the candidate's far side gets the
// other system of the bare hole, the bare hole's names move over, the jumps (and jump fits) logged on the bare hole are re-pointed to the
// linked hole and the bare hole is deleted. Everything runs in one transaction with the rows locked (signatures first, then wormholes, the
// order signatures.php uses; one retry on a deadlock), and every precondition is re-checked on the server (the browser's view may be stale,
// a second pilot may have linked meanwhile).
//
// Undo is the same kind of operation (jumplink_unlink): the link is stored in fork_jump_links with everything needed to put it back
// (the bare hole's rows, the jumps and fits that moved), so an undo reverts only what the link changed, and refuses when the linked hole
// was edited since (its system, type or signature IDs).
//
// Rows in other fork tables that point at the deleted bare hole: fork_watchlist_seen is cleaned here; the Discord rolling / preserve-mass
// message rows need no cleaning (a bare hole can't carry those flags: the link is refused for them) and the worker strikes any live message
// of a gone hole by itself (discord_rolling_gone / discord_preserve_gone).
//
// All functions take the mask and the actor explicitly (the mask of the endpoint is the session's), so the PHP tests run them without a server.

require_once(__DIR__ . '/../bookmark/bookmark.inc.php');
require_once(__DIR__ . '/../audit/audit.inc.php');

const JUMPLINK_REAL_SYSTEM = 30000000;   // ids below are generic "Leads To" types, not systems

const JUMPLINK_DDL = [
    // One row per link made: `data` is the JSON needed to undo it (jumplink_link builds it). undoneAt is set when it was undone.
    "CREATE TABLE IF NOT EXISTS `fork_jump_links` (
      `id` int NOT NULL AUTO_INCREMENT,
      `maskID` decimal(12,1) NOT NULL,
      `characterID` int NOT NULL,
      `characterName` varchar(100) NOT NULL DEFAULT '',
      `wormholeID` int NOT NULL,
      `data` mediumtext NOT NULL,
      `createdAt` datetime NOT NULL,
      `undoneAt` datetime DEFAULT NULL,
      PRIMARY KEY (`id`),
      KEY `mask` (`maskID`, `id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

/** CREATE TABLE is DDL (it ends a transaction): callers run this before jumplink_link / jumplink_unlink */
function jumplink_ensure_schema(PDO $db) {
    foreach (JUMPLINK_DDL as $ddl) $db->exec($ddl);
}

function jumplink_real($systemID) {
    return is_numeric($systemID) && (int) $systemID >= JUMPLINK_REAL_SYSTEM;
}

function jumplink_has_id($signatureID) {
    return is_string($signatureID) && preg_match('/^[a-z]{3}/i', $signatureID) === 1;
}

function jumplink_text($value) {
    return trim((string) ($value === null ? '' : $value));
}

/** [ok, message, http status, data] */
function jumplink_fail($status, $message) {
    return [false, $message, $status, null];
}

/** A deadlock or lock wait that the database asks to be retried (SQLSTATE 40001, error 1213) */
function jumplink_retryable(PDOException $e) {
    return $e->getCode() === '40001' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1213);
}

/** Run a transaction body once more when it was the deadlock victim */
function jumplink_with_retry(PDO $db, callable $fn) {
    try {
        return $fn();
    } catch (PDOException $e) {
        if (!jumplink_retryable($e)) throw $e;
        if ($db->inTransaction()) $db->rollBack();
        return $fn();
    }
}

/** Does a fork table have a row for this wormhole in this mask? A missing table (feature never used) means no. */
function jumplink_flag(PDO $db, $table, $mask, $wormholeID) {
    try {
        $stmt = $db->prepare("SELECT 1 FROM $table WHERE maskID = ? AND wormholeID = ? LIMIT 1");
        $stmt->execute([$mask, $wormholeID]);
        return (bool) $stmt->fetchColumn();
    } catch (PDOException $e) {
        if ($e->getCode() === '42S02') return false;
        throw $e;
    }
}

/** Run a statement on an optional fork table: a missing table (never used) is not an error. Returns the statement or null. */
function jumplink_optional(PDO $db, $sql, array $args) {
    try {
        $stmt = $db->prepare($sql);
        $stmt->execute($args);
        return $stmt;
    } catch (PDOException $e) {
        if ($e->getCode() === '42S02') return null;
        throw $e;
    }
}

function jumplink_row(PDO $db, $table, $mask, $id, $lock = false) {
    $stmt = $db->prepare("SELECT * FROM $table WHERE id = ? AND maskID = ?" . ($lock ? ' FOR UPDATE' : ''));
    $stmt->execute([(int) $id, $mask]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

/** Lock signatures (ascending id, scoped to the mask) and return them by id; a missing one is missing from the result */
function jumplink_lock_sigs(PDO $db, $mask, array $ids) {
    $ids = array_values(array_unique(array_map('intval', $ids)));
    sort($ids);
    $in = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("SELECT * FROM signatures WHERE maskID = ? AND id IN ($in) ORDER BY id FOR UPDATE");
    $stmt->execute(array_merge([$mask], $ids));
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $out[(int) $row['id']] = $row;
    return $out;
}

/** Lock wormholes (ascending id, scoped to the mask) and return them by id. Always after the signatures. */
function jumplink_lock_holes(PDO $db, $mask, array $ids) {
    $ids = array_values(array_unique(array_map('intval', $ids)));
    sort($ids);
    $in = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("SELECT * FROM wormholes WHERE maskID = ? AND id IN ($in) ORDER BY id FOR UPDATE");
    $stmt->execute(array_merge([$mask], $ids));
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $out[(int) $row['id']] = $row;
    return $out;
}

/**
 * Move the jumps and jump fits logged on one hole to another. Returns [jump rows moved (as stored for the undo), fit keys moved, fit rows
 * dropped]. A fit whose key already exists on the target (same character and jump time) stays with the target: the bare hole's copy is
 * deleted (and kept in the link record, so the undo can bring it back).
 */
function jumplink_move_logs(PDO $db, $mask, $fromID, $toID) {
    $jumps = $db->prepare('SELECT characterID, characterName, fromID, fromName, toID, toName, shipTypeID, shipType, UNIX_TIMESTAMP(time) AS t FROM jumps WHERE wormholeID = ? AND maskID = ?');
    $jumps->execute([$fromID, $mask]);
    $jumpRows = $jumps->fetchAll(PDO::FETCH_ASSOC);
    $db->prepare('UPDATE jumps SET wormholeID = ? WHERE wormholeID = ? AND maskID = ?')->execute([$toID, $fromID, $mask]);

    $moved = [];
    $dropped = [];
    $fits = jumplink_optional($db, 'SELECT * FROM fork_jump_fits WHERE maskID = ? AND wormholeID = ? FOR UPDATE', [$mask, $fromID]);
    if ($fits) {
        $before = $fits->fetchAll(PDO::FETCH_ASSOC);
        if ($before) {
            jumplink_optional($db, 'UPDATE IGNORE fork_jump_fits SET wormholeID = ? WHERE maskID = ? AND wormholeID = ?', [$toID, $mask, $fromID]);
            // what is still on the bare hole could not move (the target has that key): drop it, remembered for the undo
            $left = jumplink_optional($db, 'SELECT characterID, UNIX_TIMESTAMP(jumpTime) AS t FROM fork_jump_fits WHERE maskID = ? AND wormholeID = ?', [$mask, $fromID])->fetchAll(PDO::FETCH_ASSOC);
            $leftKeys = [];
            foreach ($left as $l) $leftKeys[$l['characterID'] . ':' . $l['t']] = true;
            foreach ($before as $row) {
                $stamp = jumplink_optional($db, 'SELECT UNIX_TIMESTAMP(?) AS t', [$row['jumpTime']])->fetchColumn();
                $key = $row['characterID'] . ':' . $stamp;
                unset($row['updated']);
                if (isset($leftKeys[$key])) $dropped[] = $row; else $moved[] = ['characterID' => (int) $row['characterID'], 'jumpTime' => $row['jumpTime']];
            }
            if ($dropped) jumplink_optional($db, 'DELETE FROM fork_jump_fits WHERE maskID = ? AND wormholeID = ?', [$mask, $fromID]);
        }
    }
    return [$jumpRows, $moved, $dropped];
}

/**
 * Link a scanned signature to the jump a bare hole stands for.
 * $mode: the mask's jump prompt mode ('nomatch': the bare hole must have no names, 'always': names are allowed and move over, 'off': refused).
 * Returns [ok, message, status, data]; data: linkId, wormholeID (the linked hole), moved (jumps re-pointed), carried (names moved).
 */
function jumplink_link(PDO $db, $mask, array $actor, $bareID, $candidateSigID, $mode) {
    return jumplink_with_retry($db, function () use ($db, $mask, $actor, $bareID, $candidateSigID, $mode) {
        return jumplink_link_once($db, $mask, $actor, $bareID, $candidateSigID, $mode);
    });
}

function jumplink_link_once(PDO $db, $mask, array $actor, $bareID, $candidateSigID, $mode) {
    if (!in_array($mode, ['nomatch', 'always'], true)) return jumplink_fail(403, 'This mask has turned the jump prompt off');
    $bareID = (int) $bareID;
    $candidateSigID = (int) $candidateSigID;
    if ($bareID <= 0 || $candidateSigID <= 0) return jumplink_fail(400, 'bareID and candidateSigID are required');

    $audit = null;
    $db->beginTransaction();
    try {
        // Read what to lock without locking (the order of locks is signatures, then wormholes), then lock and check again
        $bare0 = jumplink_row($db, 'wormholes', $mask, $bareID);
        if (!$bare0) { $db->rollBack(); return jumplink_fail(409, 'That unknown hole is gone already: someone linked or removed it'); }
        $c0 = jumplink_row($db, 'signatures', $mask, $candidateSigID);
        if (!$c0 || $c0['type'] !== 'wormhole') { $db->rollBack(); return jumplink_fail(404, 'That signature is gone or not a wormhole'); }
        $stmt = $db->prepare('SELECT * FROM wormholes WHERE maskID = ? AND (initialID = ? OR secondaryID = ?) ORDER BY id LIMIT 1');
        $stmt->execute([$mask, $c0['id'], $c0['id']]);
        $w0 = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$w0 || (int) $w0['id'] === $bareID) { $db->rollBack(); return jumplink_fail(404, 'That signature has no hole'); }
        $pID = (int) $w0['initialID'] === (int) $c0['id'] ? (int) $w0['secondaryID'] : (int) $w0['initialID'];

        $sigs = jumplink_lock_sigs($db, $mask, [$bare0['initialID'], $bare0['secondaryID'], $c0['id'], $pID]);
        $holes = jumplink_lock_holes($db, $mask, [$bareID, $w0['id']]);
        $bare = isset($holes[$bareID]) ? $holes[$bareID] : null;
        $w = isset($holes[(int) $w0['id']]) ? $holes[(int) $w0['id']] : null;
        if (!$bare) { $db->rollBack(); return jumplink_fail(409, 'That unknown hole is gone already: someone linked or removed it'); }
        if (!$w || (int) $bare['initialID'] !== (int) $bare0['initialID'] || (int) $bare['secondaryID'] !== (int) $bare0['secondaryID']
            || (int) $w['initialID'] !== (int) $w0['initialID'] || (int) $w['secondaryID'] !== (int) $w0['secondaryID']) {
            $db->rollBack(); return jumplink_fail(409, 'The holes changed meanwhile: try again');
        }
        $a = isset($sigs[(int) $bare['initialID']]) ? $sigs[(int) $bare['initialID']] : null;
        $b = isset($sigs[(int) $bare['secondaryID']]) ? $sigs[(int) $bare['secondaryID']] : null;
        $c = isset($sigs[(int) $c0['id']]) ? $sigs[(int) $c0['id']] : null;
        $p = isset($sigs[$pID]) ? $sigs[$pID] : null;
        if (!$a || !$b || $a['type'] !== 'wormhole' || $b['type'] !== 'wormhole') { $db->rollBack(); return jumplink_fail(409, 'That hole is not a plain wormhole any more'); }
        if (!jumplink_real($a['systemID']) || !jumplink_real($b['systemID']) || (int) $a['systemID'] === (int) $b['systemID']) {
            $db->rollBack(); return jumplink_fail(409, 'That hole does not connect two systems');
        }

        // Still bare? Nothing but names (in "always" mode) may have been filled in.
        if (jumplink_text($bare['type']) !== '' || $bare['life'] !== 'stable' || $bare['mass'] !== 'stable') { $db->rollBack(); return jumplink_fail(409, 'The unknown hole has a type, life or mass set: not replacing it'); }
        if (jumplink_has_id($a['signatureID']) || jumplink_has_id($b['signatureID'])) { $db->rollBack(); return jumplink_fail(409, 'The unknown hole has a signature ID now: not replacing it'); }
        if (jumplink_text($a['bookmark']) !== '' || jumplink_text($b['bookmark']) !== '') { $db->rollBack(); return jumplink_fail(409, 'The unknown hole has a bookmark: not replacing it'); }
        $nameA = jumplink_text($a['name']);
        $nameB = jumplink_text($b['name']);
        if ($mode === 'nomatch' && ($nameA !== '' || $nameB !== '')) { $db->rollBack(); return jumplink_fail(409, 'The unknown hole has been named: not replacing it'); }
        if (jumplink_flag($db, 'fork_rolling', $mask, $bareID) || jumplink_flag($db, 'fork_preserve_mass', $mask, $bareID)) {
            $db->rollBack(); return jumplink_fail(409, 'The unknown hole is marked for rolling or mass preservation: not replacing it');
        }

        // The candidate: a wormhole signature in one of the two systems whose far side is still unset
        if (!$c || $c['type'] !== 'wormhole') { $db->rollBack(); return jumplink_fail(404, 'That signature is gone or not a wormhole'); }
        if ((int) $c['id'] === (int) $a['id'] || (int) $c['id'] === (int) $b['id']) { $db->rollBack(); return jumplink_fail(400, 'That is the unknown hole itself'); }
        if (!$p) { $db->rollBack(); return jumplink_fail(404, 'The far side of that signature is gone'); }
        if (jumplink_real($p['systemID'])) { $db->rollBack(); return jumplink_fail(409, 'That signature was linked to a system meanwhile'); }
        if ((int) $c['systemID'] === (int) $a['systemID']) { $near = $a; $far = $b; }
        elseif ((int) $c['systemID'] === (int) $b['systemID']) { $near = $b; $far = $a; }
        else { $db->rollBack(); return jumplink_fail(409, 'That signature is not in either system of the jump'); }

        // Names move over (only into an unnamed signature): near = the bare hole's side in the candidate's system, far = the other side
        $carried = [];
        $setName = function ($sig, $name) use (&$carried) {
            if ($name !== '' && jumplink_text($sig['name']) === '') { $carried[] = ['id' => (int) $sig['id'], 'name' => $name]; }
        };
        $setName($c, jumplink_text($near['name']));
        $setName($p, jumplink_text($far['name']));
        $farSystemAfter = (int) $near['systemID'] === (int) $a['systemID'] ? (int) $b['systemID'] : (int) $a['systemID'];

        $audit = [
            'bareRow' => audit_wormhole_row($db, $bareID), 'before' => (int) $p['systemID'], 'cSig' => strtoupper((string) $c['signatureID']),
            'from' => (int) $a['systemID'], 'to' => (int) $b['systemID'],
        ];

        // Do it
        $now = date('Y-m-d H:i:s');
        $who = mb_substr((string) $actor['name'], 0, 100);
        $db->prepare('UPDATE signatures SET systemID = ?, modifiedByID = ?, modifiedByName = ?, modifiedTime = ? WHERE id = ? AND maskID = ?')
            ->execute([$farSystemAfter, $actor['id'], $who, $now, $p['id'], $mask]);
        $nm = $db->prepare('UPDATE signatures SET name = ?, modifiedByID = ?, modifiedByName = ?, modifiedTime = ? WHERE id = ? AND maskID = ?');
        foreach ($carried as $item) $nm->execute([mb_substr($item['name'], 0, 100), $actor['id'], $who, $now, $item['id'], $mask]);

        // The logs move last, right before the bare hole goes: a jump logged on it until now is moved too
        list($jumpRows, $fitsMoved, $fitsDropped) = jumplink_move_logs($db, $mask, $bareID, (int) $w['id']);
        jumplink_optional($db, 'DELETE FROM fork_watchlist_seen WHERE maskID = ? AND wormholeID = ?', [$mask, $bareID]);
        $db->prepare('DELETE FROM wormholes WHERE id = ? AND maskID = ?')->execute([$bareID, $mask]);
        $db->prepare('DELETE FROM signatures WHERE id IN (?, ?) AND maskID = ?')->execute([$a['id'], $b['id'], $mask]);

        $undo = [
            'bare' => [
                'wormhole' => ['type' => $bare['type'], 'parent' => $bare['parent'], 'life' => $bare['life'], 'mass' => $bare['mass']],
                'initial' => array_intersect_key($a, array_flip(['systemID', 'name', 'lifeTime', 'lifeLeft', 'lifeLength', 'createdByID', 'createdByName'])),
                'secondary' => array_intersect_key($b, array_flip(['systemID', 'name', 'lifeTime', 'lifeLeft', 'lifeLength', 'createdByID', 'createdByName'])),
            ],
            'candidate' => (int) $c['id'], 'far' => (int) $p['id'], 'wormhole' => (int) $w['id'],
            'farSystemBefore' => $p['systemID'] === null ? null : (int) $p['systemID'], 'farSystemAfter' => $farSystemAfter,
            // what the linked hole looked like right after the link: an undo is refused when its type or signature IDs differ now
            'after' => ['type' => jumplink_text($w['type']), 'candidateSig' => jumplink_text($c['signatureID']), 'farSig' => jumplink_text($p['signatureID'])],
            'carried' => $carried, 'jumps' => $jumpRows, 'fitsMoved' => $fitsMoved, 'fitsDropped' => $fitsDropped,
        ];
        $ins = $db->prepare('INSERT INTO fork_jump_links (maskID, characterID, characterName, wormholeID, data, createdAt) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())');
        $ins->execute([$mask, $actor['id'], $who, $w['id'], json_encode($undo)]);
        $linkID = (int) $db->lastInsertId();
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }

    // The audit trail (after the commit: it may create its table), the removed bare hole and the linked one
    try {
        if ($audit['bareRow']) audit_wormhole_removed($db, $audit['bareRow']);
        audit_record($db, $mask, ['id' => $actor['id'], 'name' => $actor['name']], 'wormhole', 'update', $audit['from'], $audit['to'], 'jump link',
            ['from' => $audit['cSig'], 'to' => '', 'changes' => ['systemID' => [$audit['before'], $undo['farSystemAfter']]]]);
    } catch (Throwable $e) { error_log('jumplink audit: ' . $e->getMessage()); }

    return [true, 'ok', 200, ['linkId' => $linkID, 'wormholeID' => (int) $w['id'], 'moved' => count($jumpRows), 'carried' => $carried]];
}

/** Undo a link made by this mask: put the bare hole back, move its jumps and fits back, unlink the candidate. Refused when the linked hole changed since. */
function jumplink_unlink(PDO $db, $mask, array $actor, $linkID) {
    return jumplink_with_retry($db, function () use ($db, $mask, $actor, $linkID) {
        return jumplink_unlink_once($db, $mask, $actor, $linkID);
    });
}

function jumplink_unlink_once(PDO $db, $mask, array $actor, $linkID) {
    $linkID = (int) $linkID;
    if ($linkID <= 0) return jumplink_fail(400, 'linkId is required');
    $db->beginTransaction();
    try {
        $stmt = $db->prepare('SELECT * FROM fork_jump_links WHERE id = ? AND maskID = ? FOR UPDATE');
        $stmt->execute([$linkID, $mask]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) { $db->rollBack(); return jumplink_fail(404, 'No such link'); }
        if ($row['undoneAt'] !== null) { $db->rollBack(); return jumplink_fail(409, 'That link was undone already'); }
        $u = json_decode($row['data'], true);
        if (!is_array($u)) { $db->rollBack(); return jumplink_fail(500, 'The link record is damaged'); }

        $sigs = jumplink_lock_sigs($db, $mask, [$u['candidate'], $u['far']]);
        $holes = jumplink_lock_holes($db, $mask, [$u['wormhole']]);
        $w = isset($holes[(int) $u['wormhole']]) ? $holes[(int) $u['wormhole']] : null;
        $c = isset($sigs[(int) $u['candidate']]) ? $sigs[(int) $u['candidate']] : null;
        $p = isset($sigs[(int) $u['far']]) ? $sigs[(int) $u['far']] : null;
        if (!$w || !$c || !$p) { $db->rollBack(); return jumplink_fail(409, 'The linked hole was changed or removed since: nothing to undo'); }
        $after = isset($u['after']) && is_array($u['after']) ? $u['after'] : null;
        if ((int) $p['systemID'] !== (int) $u['farSystemAfter']
            || ($after !== null && (jumplink_text($w['type']) !== $after['type'] || jumplink_text($c['signatureID']) !== $after['candidateSig'] || jumplink_text($p['signatureID']) !== $after['farSig']))) {
            $db->rollBack(); return jumplink_fail(409, 'The linked hole was changed since (its system, type or signature IDs): not undoing the link');
        }

        $now = date('Y-m-d H:i:s');
        $who = [$actor['id'], mb_substr((string) $actor['name'], 0, 100), $now];
        // unlink the far side; take back the names this link moved over, only where they are still as it left them
        $db->prepare('UPDATE signatures SET systemID = ?, modifiedByID = ?, modifiedByName = ?, modifiedTime = ? WHERE id = ? AND maskID = ?')
            ->execute(array_merge([$u['farSystemBefore']], $who, [$p['id'], $mask]));
        foreach ($u['carried'] as $item) {
            $db->prepare("UPDATE signatures SET name = '', modifiedByID = ?, modifiedByName = ?, modifiedTime = ? WHERE id = ? AND maskID = ? AND name = ?")
                ->execute(array_merge($who, [$item['id'], $mask, $item['name']]));
        }

        // the bare hole again
        $newSig = function (array $s) use ($db, $mask, $who) {
            $db->prepare("INSERT INTO signatures (signatureID, systemID, type, name, bookmark, lifeTime, lifeLeft, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, modifiedTime, maskID)
                VALUES (NULL, ?, 'wormhole', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                ->execute([$s['systemID'], $s['name'], $s['lifeTime'], $s['lifeLeft'], $s['lifeLength'], $s['createdByID'], $s['createdByName'], $who[0], $who[1], $who[2], $mask]);
            return (int) $db->lastInsertId();
        };
        $i = $newSig($u['bare']['initial']);
        $s = $newSig($u['bare']['secondary']);
        $bw = $u['bare']['wormhole'];
        $db->prepare('INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (?, ?, ?, ?, ?, ?, ?)')
            ->execute([$i, $s, $bw['type'], $bw['parent'], $bw['life'], $bw['mass'], $mask]);
        $bareID = (int) $db->lastInsertId();

        // the jumps that moved go back (matched by character, time and ends: the table has no row id)
        $back = $db->prepare('UPDATE jumps SET wormholeID = ? WHERE wormholeID = ? AND maskID = ? AND characterID = ? AND fromID = ? AND toID = ? AND UNIX_TIMESTAMP(time) = ?');
        $moved = 0;
        foreach ($u['jumps'] as $j) {
            $back->execute([$bareID, $w['id'], $mask, $j['characterID'], $j['fromID'], $j['toID'], $j['t']]);
            $moved += $back->rowCount();
        }
        // the jump fits too: the ones that moved go back, the ones the target already had a copy of are restored
        foreach (isset($u['fitsMoved']) ? $u['fitsMoved'] : [] as $f) {
            jumplink_optional($db, 'UPDATE fork_jump_fits SET wormholeID = ? WHERE maskID = ? AND wormholeID = ? AND characterID = ? AND jumpTime = ?',
                [$bareID, $mask, $w['id'], $f['characterID'], $f['jumpTime']]);
        }
        foreach (isset($u['fitsDropped']) ? $u['fitsDropped'] : [] as $f) {
            $f['wormholeID'] = $bareID;
            $cols = array_keys($f);
            jumplink_optional($db, 'INSERT IGNORE INTO fork_jump_fits (`' . implode('`, `', $cols) . '`) VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')', array_values($f));
        }
        $db->prepare('UPDATE fork_jump_links SET undoneAt = UTC_TIMESTAMP() WHERE id = ?')->execute([$linkID]);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
    return [true, 'ok', 200, ['bareID' => $bareID, 'moved' => $moved]];
}
