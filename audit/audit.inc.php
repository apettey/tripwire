<?php
// Fork-owned: audit log of who changed what on a mask (see docker/README.md#audit-log).
//
// Every signature and wormhole write goes through six functions in signatures.php (addSignature, updateSignature,
// removeSignature, addWormhole, updateWormhole, removeWormhole); each calls one helper here after its write succeeded. So
// the rows come from the one place that really changes the data: dialog adds and edits, inline edits, pasted scans, the
// automapper, undo/redo (they replay the same requests) and deletes. The mask and the character are the session's
// ($_SESSION['mask'], characterID, characterName), never request values.
//
// Why a table of our own and not upstream's _history_signatures / _history_wormholes: those are full-row copies meant for
// triggers (about 400 bytes a row, no who-changed-what summary, the wormhole table has no actor at all, a fixed status enum)
// and upstream may fill them one day with other semantics; ours is small (one JSON summary a row) and ours to prune.
//
// Auditing never breaks a save: every helper catches everything and only logs to the PHP error log.
// Retention: AUDIT_LOG_DAYS (docker/config.php, default 60, 0 = recording off). Rows older than that are never shown and
// are deleted every AUDIT_PRUNE_EVERY writes (on the id of the row just written) and whenever an admin opens the tab.

const AUDIT_DDL = "CREATE TABLE IF NOT EXISTS `fork_audit_log` (
      `id` bigint unsigned NOT NULL AUTO_INCREMENT,
      `maskID` decimal(12,1) NOT NULL,
      `at` datetime NOT NULL,
      `characterID` int NOT NULL,
      `characterName` varchar(50) NOT NULL DEFAULT '',
      `entity` varchar(10) NOT NULL,
      `action` varchar(10) NOT NULL,
      `systemID` int NOT NULL DEFAULT 0,
      `toSystemID` int NOT NULL DEFAULT 0,
      `subject` varchar(40) NOT NULL DEFAULT '',
      `detail` varchar(1000) NOT NULL DEFAULT '',
      PRIMARY KEY (`id`),
      KEY `mask` (`maskID`, `at`),
      KEY `mask_system` (`maskID`, `systemID`, `at`),
      KEY `at` (`at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";

const AUDIT_DEFAULT_DAYS = 60;
const AUDIT_MAX_DAYS = 3650;
const AUDIT_PRUNE_EVERY = 100;
const AUDIT_PAGE_SIZE = 50;
const AUDIT_MAX_PAGE = 100;
const AUDIT_VALUE_MAX = 60;
const AUDIT_DETAIL_MAX = 1000;
const AUDIT_SIGNATURE_FIELDS = ['signatureID', 'systemID', 'type', 'name', 'bookmark', 'lifeLength'];
const AUDIT_WORMHOLE_FIELDS = ['type', 'parent', 'life', 'mass'];
const AUDIT_ENTITIES = ['signature', 'wormhole', 'mask'];
const AUDIT_ACTIONS = ['add', 'update', 'delete'];
const AUDIT_MASK_ACTIONS = ['grant', 'revoke', 'block', 'unblock', 'remove', 'defaults', 'token-create', 'token-revoke'];

/** Retention in days from AUDIT_LOG_DAYS (constant or environment): 0 = off, otherwise 1..3650, default 60 */
function audit_days() {
    $raw = defined('AUDIT_LOG_DAYS') ? AUDIT_LOG_DAYS : getenv('AUDIT_LOG_DAYS');
    if ($raw === false || $raw === null || trim((string) $raw) === '' || !is_numeric($raw)) return AUDIT_DEFAULT_DAYS;
    return max(0, min(AUDIT_MAX_DAYS, (int) $raw));
}

function audit_run(PDO $db, callable $fn) {
    try {
        return $fn();
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') throw $e;
        $db->exec(AUDIT_DDL);
        if (function_exists('maskadmin_ensure_schema')) maskadmin_ensure_schema($db);   // the mask-admin entries are read with ours
        return $fn();
    }
}

function audit_clip($value, $max = AUDIT_VALUE_MAX) {
    return mb_substr(trim((string) $value), 0, $max, 'UTF-8');
}

/** The value as the log stores it: ids as numbers, text clipped, nothing as '' */
function audit_value($field, $value) {
    if ($value === null) return '';
    if ($field === 'systemID' || $field === 'lifeLength') return (int) $value;
    if ($field === 'bookmark') return $value === '' || $value === 0 || $value === '0' ? '' : 'set';   // a bookmark is a long game string: only whether there is one
    return audit_clip($value);
}

/** [field => [before, after]] for the fields that differ ($before, $after: field => value) */
function audit_changes(array $before, array $after, array $fields) {
    $out = [];
    foreach ($fields as $f) {
        $b = audit_value($f, isset($before[$f]) ? $before[$f] : null);
        $a = audit_value($f, isset($after[$f]) ? $after[$f] : null);
        if ($b !== $a) $out[$f] = [$b, $a];
    }
    return $out;
}

/** JSON of $detail, within the column: long text values are cut harder before giving up on them */
function audit_json(array $detail) {
    $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE;
    $json = json_encode($detail, $flags);
    if ($json !== false && strlen($json) <= AUDIT_DETAIL_MAX) return $json;
    array_walk_recursive($detail, function (&$v) { if (is_string($v)) $v = audit_clip($v, 12); });
    $json = json_encode($detail, $flags);
    return $json !== false && strlen($json) <= AUDIT_DETAIL_MAX ? $json : '{}';
}

/** Delete entries older than $days (default: the configured retention); returns the number deleted */
function audit_prune(PDO $db, $days = null) {
    $days = $days === null ? audit_days() : (int) $days;
    if ($days < 1) return 0;
    try {
        return audit_run($db, function () use ($db, $days) {
            $stmt = $db->prepare('DELETE FROM fork_audit_log WHERE at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ' . $days . ' DAY) LIMIT 5000');
            $stmt->execute();
            return $stmt->rowCount();
        });
    } catch (Throwable $e) {
        error_log('audit: ' . $e->getMessage());
        return 0;
    }
}

/**
 * Write one entry. $who = ['id', 'name'] (the session's character). Never throws. Returns the row id or 0.
 * $entity: signature | wormhole; $action: add | update | delete.
 */
function audit_record(PDO $db, $mask, array $who, $entity, $action, $systemID, $toSystemID, $subject, array $detail) {
    try {
        if (audit_days() < 1) return 0;
        if (!is_string($mask) || preg_match('/^[0-9]{1,10}\.[0-3]$/', $mask) !== 1) return 0;
        if (!in_array($entity, ['signature', 'wormhole'], true) || !in_array($action, AUDIT_ACTIONS, true)) return 0;
        $id = audit_run($db, function () use ($db, $mask, $who, $entity, $action, $systemID, $toSystemID, $subject, $detail) {
            $stmt = $db->prepare('INSERT INTO fork_audit_log (maskID, at, characterID, characterName, entity, action, systemID, toSystemID, subject, detail)
                VALUES (?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?)');
            $stmt->execute([$mask, (int) $who['id'], audit_clip($who['name'], 50), $entity, $action, (int) $systemID, (int) $toSystemID, audit_clip($subject, 40), audit_json($detail)]);
            return (int) $db->lastInsertId();
        });
        if ($id > 0 && $id % AUDIT_PRUNE_EVERY === 0) audit_prune($db);
        return $id;
    } catch (Throwable $e) {
        error_log('audit: ' . $e->getMessage());
        return 0;
    }
}

function audit_session_mask() { return isset($_SESSION['mask']) ? (string) $_SESSION['mask'] : ''; }
function audit_session_who() {
    return ['id' => isset($_SESSION['characterID']) ? (int) $_SESSION['characterID'] : 0, 'name' => isset($_SESSION['characterName']) ? (string) $_SESSION['characterName'] : ''];
}

// ---- snapshots (one small SELECT each, always scoped to the session's mask) ----

function audit_signature_row(PDO $db, $id) {
    try {
        if (audit_days() < 1) return null;   // not recording: no extra queries
        $stmt = $db->prepare("SELECT id, signatureID, systemID, type, name, IF(bookmark IS NULL OR bookmark = '', '', 'set') AS bookmark, lifeLength FROM signatures WHERE id = ? AND maskID = ?");
        $stmt->execute([(int) $id, audit_session_mask()]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    } catch (Throwable $e) {
        error_log('audit: ' . $e->getMessage());
        return null;
    }
}

/** A wormhole row with the systems and signature ids of its two ends (ends may be missing if already deleted) */
function audit_wormhole_row(PDO $db, $id) {
    try {
        if (audit_days() < 1) return null;
        $stmt = $db->prepare('SELECT w.id, w.initialID, w.secondaryID, w.type, w.parent, w.life, w.mass, a.systemID AS fromSystem, b.systemID AS toSystem, a.signatureID AS fromSig, b.signatureID AS toSig
            FROM wormholes w LEFT JOIN signatures a ON a.id = w.initialID LEFT JOIN signatures b ON b.id = w.secondaryID WHERE w.id = ? AND w.maskID = ?');
        $stmt->execute([(int) $id, audit_session_mask()]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    } catch (Throwable $e) {
        error_log('audit: ' . $e->getMessage());
        return null;
    }
}

/** The wormhole a wormhole-type signature belongs to, before the signature is deleted (deleting it cascades to the hole), or null */
function audit_hole_before(PDO $db, $signature) {
    try {
        if (audit_days() < 1 || $signature->type !== 'wormhole') return null;
        $stmt = $db->prepare('SELECT id FROM wormholes WHERE (initialID = ? OR secondaryID = ?) AND maskID = ? LIMIT 1');
        $stmt->execute([(int) $signature->id, (int) $signature->id, audit_session_mask()]);
        $id = $stmt->fetchColumn();
        return $id ? audit_wormhole_row($db, $id) : null;
    } catch (Throwable $e) {
        error_log('audit: ' . $e->getMessage());
        return null;
    }
}

/**
 * Per request: wormhole-type signature adds not (yet) followed by their wormhole (id => entry), and signature ids already
 * logged as part of a wormhole deletion. An add whose wormhole never follows is an orphan hole signature and is logged
 * as a signature add when the request ends (audit_flush_pending).
 */
function &audit_request_state() {
    static $state = ['pending' => [], 'covered' => [], 'registered' => false];
    return $state;
}

/** Log the wormhole signatures added in this request that no wormhole claimed */
function audit_flush_pending() {
    $state = &audit_request_state();
    $pending = $state['pending'];
    $state['pending'] = [];
    foreach ($pending as $e) {
        audit_record($e['db'], $e['mask'], $e['who'], 'signature', 'add', (int) $e['state']['systemID'], 0, strtoupper((string) $e['state']['signatureID']), audit_signature_summary($e['state']));
    }
}

function audit_signature_state($signature) {
    return ['id' => (int) $signature->id, 'signatureID' => $signature->signatureID, 'systemID' => $signature->systemID, 'type' => $signature->type,
        'name' => $signature->name, 'bookmark' => $signature->bookmark, 'lifeLength' => $signature->lifeLength];
}

/** The summary of a whole signature (add / delete): its id as the scan shows it, type and name */
function audit_signature_summary(array $s) {
    $d = [];
    if (!empty($s['signatureID'])) $d['id'] = audit_clip(strtoupper($s['signatureID']), 10);
    $d['type'] = isset($s['type']) ? audit_clip($s['type']) : 'unknown';
    if (isset($s['name']) && $s['name'] !== '' && $s['name'] !== null) $d['name'] = audit_clip($s['name']);
    return $d;
}

// ---- hooks called from signatures.php, after the write succeeded ----

/** Wormhole-type signatures are logged as part of their wormhole, so this logs the others only */
function audit_signature_added(PDO $db, $signature) {
    try {
        $s = audit_signature_state($signature);
        if ($signature->type === 'wormhole') {
            if (audit_days() < 1) return;
            $state = &audit_request_state();
            $state['pending'][(int) $signature->id] = ['db' => $db, 'mask' => audit_session_mask(), 'who' => audit_session_who(), 'state' => $s];
            if (!$state['registered']) { $state['registered'] = true; register_shutdown_function('audit_flush_pending'); }
            return;
        }
        audit_record($db, audit_session_mask(), audit_session_who(), 'signature', 'add', (int) $s['systemID'], 0, strtoupper((string) $s['signatureID']), audit_signature_summary($s));
    } catch (Throwable $e) { error_log('audit: ' . $e->getMessage()); }
}

/** $before: audit_signature_row() taken before the UPDATE */
function audit_signature_updated(PDO $db, $before, $signature) {
    try {
        if (!$before) return;
        $after = audit_signature_state($signature);
        $bothHoles = $before['type'] === 'wormhole' && $after['type'] === 'wormhole';
        // a hole's life, mass and type are logged by updateWormhole; here only where it leads and how the scan names it
        $fields = $bothHoles ? ['signatureID', 'systemID', 'name'] : AUDIT_SIGNATURE_FIELDS;
        $changes = audit_changes($before, $after, $fields);
        if (!$changes) return;
        audit_record($db, audit_session_mask(), audit_session_who(), $bothHoles ? 'wormhole' : 'signature', 'update', (int) $after['systemID'], 0,
            strtoupper((string) $after['signatureID']), ['id' => audit_clip(strtoupper((string) $after['signatureID']), 10), 'changes' => $changes]);
    } catch (Throwable $e) { error_log('audit: ' . $e->getMessage()); }
}

/** $rows: rows the DELETE removed; $hole: audit_hole_before() (the hole this deletion took with it, if any) */
function audit_signature_removed(PDO $db, $signature, $rows = 1, $hole = null) {
    try {
        if ($rows < 1) return;
        $id = (int) $signature->id;
        if ($signature->type === 'wormhole') {
            $state = &audit_request_state();
            if (isset($state['pending'][$id])) { unset($state['pending'][$id]); return; }   // added and rolled back in this request
            if ($hole) { audit_wormhole_removed($db, $hole, 1); return; }                  // the delete cascaded to its wormhole
            if (isset($state['covered'][$id])) return;                                      // logged with its wormhole
        }
        $s = audit_signature_state($signature);
        audit_record($db, audit_session_mask(), audit_session_who(), 'signature', 'delete', (int) $s['systemID'], 0, strtoupper((string) $s['signatureID']), audit_signature_summary($s));
    } catch (Throwable $e) { error_log('audit: ' . $e->getMessage()); }
}

function audit_wormhole_summary(array $w) {
    $d = ['type' => audit_clip($w['type']), 'life' => audit_clip($w['life']), 'mass' => audit_clip($w['mass'])];
    if (!empty($w['fromSig'])) $d['from'] = audit_clip(strtoupper($w['fromSig']), 10);
    if (!empty($w['toSig'])) $d['to'] = audit_clip(strtoupper($w['toSig']), 10);
    return $d;
}

function audit_wormhole_added(PDO $db, $wormhole) {
    try {
        $state = &audit_request_state();
        unset($state['pending'][(int) $wormhole->initialID], $state['pending'][(int) $wormhole->secondaryID]);
        $w = audit_wormhole_row($db, $wormhole->id);
        if (!$w) return;
        audit_record($db, audit_session_mask(), audit_session_who(), 'wormhole', 'add', (int) $w['fromSystem'], (int) $w['toSystem'], audit_clip($w['type'], 40), audit_wormhole_summary($w));
    } catch (Throwable $e) { error_log('audit: ' . $e->getMessage()); }
}

/** $before: audit_wormhole_row() taken before the UPDATE */
function audit_wormhole_updated(PDO $db, $before, $wormhole) {
    try {
        if (!$before) return;
        $after = ['type' => $wormhole->type, 'parent' => $wormhole->parent, 'life' => $wormhole->life, 'mass' => $wormhole->mass];
        $changes = audit_changes($before, $after, AUDIT_WORMHOLE_FIELDS);
        if (!$changes) return;
        audit_record($db, audit_session_mask(), audit_session_who(), 'wormhole', 'update', (int) $before['fromSystem'], (int) $before['toSystem'], audit_clip($after['type'], 40),
            ['from' => audit_clip(strtoupper((string) $before['fromSig']), 10), 'to' => audit_clip(strtoupper((string) $before['toSig']), 10), 'changes' => $changes]);
    } catch (Throwable $e) { error_log('audit: ' . $e->getMessage()); }
}

function audit_wormhole_removed(PDO $db, $before, $rows = 1) {
    try {
        if (!$before || $rows < 1) return;
        $state = &audit_request_state();
        $state['covered'][(int) $before['initialID']] = true;
        $state['covered'][(int) $before['secondaryID']] = true;
        audit_record($db, audit_session_mask(), audit_session_who(), 'wormhole', 'delete', (int) $before['fromSystem'], (int) $before['toSystem'], audit_clip($before['type'], 40), audit_wormhole_summary($before));
    } catch (Throwable $e) { error_log('audit: ' . $e->getMessage()); }
}

// ---- reading (Mask Admin > Audit) ----

/** Date 'YYYY-MM-DD' -> that day's start (or the next day's start) as a UTC datetime string, or null */
function audit_date($text, $endOfDay = false) {
    if (!is_string($text) || preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $text, $m) !== 1 || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) return null;
    $t = gmmktime(0, 0, 0, (int) $m[2], (int) $m[3], (int) $m[1]);
    return gmdate('Y-m-d H:i:s', $endOfDay ? $t + 86400 : $t);
}

/** The values the request may carry, cleaned: system int, character text, kind ('signature.add', 'wormhole', 'mask', ...), from/to dates, page */
function audit_filters(array $in) {
    $kind = isset($in['kind']) && is_string($in['kind']) ? $in['kind'] : '';
    $parts = explode('.', $kind, 2);
    $entity = in_array($parts[0], AUDIT_ENTITIES, true) ? $parts[0] : '';
    $action = $entity && isset($parts[1]) && in_array($parts[1], array_merge(AUDIT_ACTIONS, AUDIT_MASK_ACTIONS), true) ? $parts[1] : '';
    $system = isset($in['system']) && is_scalar($in['system']) && ctype_digit((string) $in['system']) && strlen((string) $in['system']) <= 10 ? (int) $in['system'] : 0;
    $character = isset($in['character']) && is_string($in['character']) ? mb_substr(trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $in['character']) ?? ''), 0, 50, 'UTF-8') : '';
    $page = isset($in['page']) && is_scalar($in['page']) && ctype_digit((string) $in['page']) ? max(1, min(AUDIT_MAX_PAGE, (int) $in['page'])) : 1;
    return ['entity' => $entity, 'action' => $action, 'system' => $system, 'character' => $character,
        'from' => audit_date(isset($in['from']) ? $in['from'] : null), 'to' => audit_date(isset($in['to']) ? $in['to'] : null, true), 'page' => $page];
}

/**
 * One page (newest first) of the mask's entries in the retention window: signature/wormhole entries and the mask-admin
 * entries of fork_mask_audit. Returns ['rows' => [...], 'hasMore' => bool, 'page' => n, 'days' => retention].
 * $mask is always the session's mask; no filter can name another one.
 */
function audit_query(PDO $db, $mask, array $filters, $now = null) {
    $days = audit_days();
    $f = $filters + ['entity' => '', 'action' => '', 'system' => 0, 'character' => '', 'from' => null, 'to' => null, 'page' => 1];
    $page = max(1, min(AUDIT_MAX_PAGE, (int) $f['page']));
    if ($days < 1) return ['rows' => [], 'hasMore' => false, 'page' => 1, 'days' => 0];
    $offset = ($page - 1) * AUDIT_PAGE_SIZE;
    $limit = $offset + AUDIT_PAGE_SIZE + 1;
    $cutoff = gmdate('Y-m-d H:i:s', ($now === null ? time() : $now) - $days * 86400);

    $where = function ($nameCol, array &$params) use ($f, $cutoff) {
        $w = ['maskID = ?', 'at >= ?'];
        $params[] = $cutoff;
        if ($f['from']) { $w[] = 'at >= ?'; $params[] = $f['from']; }
        if ($f['to']) { $w[] = 'at < ?'; $params[] = $f['to']; }
        if ($f['character'] !== '') { $w[] = $nameCol . ' LIKE ?'; $params[] = '%' . addcslashes($f['character'], '%_\\') . '%'; }
        return $w;
    };
    $sql = [];
    $params = [];
    if ($f['entity'] !== 'mask') {
        $p = [$mask];
        $w = $where('characterName', $p);
        if ($f['entity'] !== '') { $w[] = 'entity = ?'; $p[] = $f['entity']; }
        if ($f['action'] !== '') { $w[] = 'action = ?'; $p[] = $f['action']; }
        if ($f['system'] > 0) { $w[] = '(systemID = ? OR toSystemID = ?)'; $p[] = $f['system']; $p[] = $f['system']; }
        $sql[] = "(SELECT 'a' AS src, id, at, characterID, characterName, entity, action, systemID, toSystemID, subject, detail FROM fork_audit_log WHERE " . implode(' AND ', $w) . ' ORDER BY at DESC, id DESC LIMIT ' . $limit . ')';
        $params = array_merge($params, $p);
    }
    if (($f['entity'] === '' || $f['entity'] === 'mask') && $f['system'] === 0) {
        $p = [$mask];
        $w = $where('actorName', $p);
        if ($f['action'] !== '') { $w[] = 'action = ?'; $p[] = $f['action']; }
        $sql[] = "(SELECT 'm' AS src, id, at, actorID AS characterID, actorName AS characterName, 'mask' AS entity, action, 0 AS systemID, 0 AS toSystemID, targetName AS subject, detail FROM fork_mask_audit WHERE " . implode(' AND ', $w) . ' ORDER BY at DESC, id DESC LIMIT ' . $limit . ')';
        $params = array_merge($params, $p);
    }
    if (!$sql) return ['rows' => [], 'hasMore' => false, 'page' => $page, 'days' => $days];

    $rows = audit_run($db, function () use ($db, $sql, $params, $offset) {
        $stmt = $db->prepare(implode(' UNION ALL ', $sql) . ' ORDER BY at DESC, src, id DESC LIMIT ' . (AUDIT_PAGE_SIZE + 1) . ' OFFSET ' . $offset);
        $stmt->execute($params);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    });
    $hasMore = count($rows) > AUDIT_PAGE_SIZE;
    $rows = array_slice($rows, 0, AUDIT_PAGE_SIZE);
    foreach ($rows as &$r) {
        $r['id'] = (int) $r['id'];
        $r['characterID'] = (int) $r['characterID'];
        $r['systemID'] = (int) $r['systemID'];
        $r['toSystemID'] = (int) $r['toSystemID'];
        if ($r['src'] === 'a') {
            $detail = json_decode($r['detail'], true);
            $r['detail'] = is_array($detail) ? $detail : new stdClass();
        }
    }
    unset($r);
    return ['rows' => $rows, 'hasMore' => $hasMore, 'page' => $page, 'days' => $days];
}
