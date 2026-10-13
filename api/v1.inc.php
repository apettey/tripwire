<?php
// Fork-owned: the read-only JSON endpoints under /api/v1 (see docker/README.md#rest-api). Called by api/token-auth.php for a
// request authenticated with a personal access token; every query is bound to the token's mask ($ctx['mask']), nothing in the request
// names a mask. Functions return [httpStatus, payload]; they take the database and the time explicitly (tests/api_tokens_test.php).
//
//   GET /api/v1                         who the token is: mask, character, scope, expiry
//   GET /api/v1/chain                   the mapped systems and wormholes of the mask
//   GET /api/v1/signatures[?systemID=]  all signatures of the mask, or of one system
//   GET /api/v1/structures[?systemID=]  live structures of the mask (with systemID: also the recently gone ones of that system)
//   GET /api/v1/timers                  the active structure timers of the mask, soonest first
//   GET /api/v1/notes[?systemID=]       system notes (comments), as sanitised HTML
//
// Times are ISO 8601 UTC ("2026-10-12T14:03:22Z"), except structure rows, which carry unix seconds as the in-app panel gets them.

require_once(__DIR__ . '/tokens.inc.php');
require_once(__DIR__ . '/../note-html.inc.php');
require_once(__DIR__ . '/../structures/structures.inc.php');

const API_V1_LIMIT = 5000;   // rows per answer; `truncated` says when there were more

/** Size class of a hole by its max jump mass in kg, the classes of app/js/fork/size-tags.js */
function api_v1_size($jumpKg) {
    $jump = (float) $jumpKg;
    if ($jump <= 0) return null;
    foreach ([['S', 5000000], ['M', 62000000], ['L', 410000000], ['VL', 1000000000]] as $class) {
        if ($jump <= $class[1]) return $class[0];
    }
    return 'XL';
}

/** type => {jump, mass, life, leadsTo} from api/wormhole-types.json (a copy of tools/wormholes.json; tests/api_tokens_test.php keeps them equal) */
function api_v1_hole_types() {
    static $types = null;
    if ($types === null) {
        $json = @file_get_contents(__DIR__ . '/wormhole-types.json');
        $types = $json === false ? [] : (json_decode($json, true) ?: []);
    }
    return $types;
}

function api_v1_system_param(array $query, &$error) {
    if (!isset($query['systemID']) || $query['systemID'] === '') return null;
    $value = $query['systemID'];
    if (!is_string($value) || !preg_match('/^[0-9]{8}$/D', $value) || (int) $value < 30000000 || (int) $value >= 33000000) {
        $error = 'Invalid systemID';
        return null;
    }
    return (int) $value;
}

function api_v1_who(PDO $db, array $ctx, $now) {
    $token = $ctx['token'];
    return [200, [
        'mask' => $ctx['mask'],
        'scope' => $token['scope'],
        'token' => ['id' => (int) $token['id'], 'name' => $token['name'], 'createdAt' => api_token_iso($token['createdAt']), 'expiresAt' => api_token_iso($token['expiresAt'])],
        'character' => ['id' => $ctx['character']['characterID'], 'name' => $ctx['character']['characterName']],
        'rateLimit' => ['perMinute' => api_token_rate_limit()],
        'serverTime' => gmdate('Y-m-d\TH:i:s\Z', $now),
    ]];
}

function api_v1_signature_row(array $r) {
    return [
        'id' => (int) $r['id'], 'signatureID' => $r['signatureID'], 'systemID' => (int) $r['systemID'], 'type' => $r['type'], 'name' => $r['name'],
        'bookmark' => $r['bookmark'], 'lifeLength' => (int) $r['lifeLength'], 'lifeLeft' => api_token_iso($r['lifeLeft']), 'lifeStart' => api_token_iso($r['lifeTime']),
        'createdBy' => $r['createdByName'], 'modifiedBy' => $r['modifiedByName'], 'modifiedAt' => api_token_iso($r['modifiedTime']),
    ];
}

function api_v1_signatures(PDO $db, array $ctx, array $query) {
    $error = null;
    $systemID = api_v1_system_param($query, $error);
    if ($error) return [400, ['error' => $error]];
    $sql = 'SELECT id, signatureID, systemID, type, name, bookmark, lifeTime, lifeLeft, lifeLength, createdByName, modifiedByName, modifiedTime FROM signatures WHERE maskID = :mask'
        . ($systemID !== null ? ' AND systemID = :system' : '') . ' ORDER BY systemID, id LIMIT ' . (API_V1_LIMIT + 1);
    $stmt = $db->prepare($sql);
    $stmt->bindValue(':mask', $ctx['mask']);
    if ($systemID !== null) $stmt->bindValue(':system', $systemID, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $truncated = count($rows) > API_V1_LIMIT;
    return [200, ['mask' => $ctx['mask'], 'systemID' => $systemID, 'truncated' => $truncated, 'signatures' => array_map('api_v1_signature_row', array_slice($rows, 0, API_V1_LIMIT))]];
}

function api_v1_chain(PDO $db, array $ctx) {
    $mask = $ctx['mask'];
    $stmt = $db->prepare('SELECT systemID, COUNT(*) AS signatures, SUM(type = \'wormhole\') AS wormholes FROM signatures WHERE maskID = :mask GROUP BY systemID ORDER BY systemID LIMIT ' . (API_V1_LIMIT + 1));
    $stmt->bindValue(':mask', $mask);
    $stmt->execute();
    $systems = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $systems[] = ['systemID' => (int) $r['systemID'], 'signatures' => (int) $r['signatures'], 'wormholes' => (int) $r['wormholes']];
    }

    // the signature rows of both ends of every hole (a hole's ends are in the same mask; the join says so)
    $stmt = $db->prepare('SELECT w.id, w.type, w.parent, w.life, w.mass,
            a.id AS aRow, a.signatureID AS aSig, a.systemID AS aSystem, a.name AS aName,
            b.id AS bRow, b.signatureID AS bSig, b.systemID AS bSystem, b.name AS bName
        FROM wormholes w INNER JOIN signatures a ON a.id = w.initialID AND a.maskID = w.maskID
            INNER JOIN signatures b ON b.id = w.secondaryID AND b.maskID = w.maskID
        WHERE w.maskID = :mask ORDER BY w.id LIMIT ' . (API_V1_LIMIT + 1));
    $stmt->bindValue(':mask', $mask);
    $stmt->execute();
    $types = api_v1_hole_types();
    $holes = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $known = $r['type'] !== null && isset($types[$r['type']]) ? $types[$r['type']] : null;
        $holes[] = [
            'id' => (int) $r['id'], 'type' => $r['type'], 'parent' => $r['parent'], 'life' => $r['life'], 'mass' => $r['mass'],
            'size' => $known ? api_v1_size($known['jump']) : null,
            'maxJumpMass' => $known ? (int) $known['jump'] : null, 'maxTotalMass' => $known ? (int) $known['mass'] : null,
            'maxLife' => $known ? $known['life'] : null, 'leadsTo' => $known ? $known['leadsTo'] : null,
            'from' => ['systemID' => (int) $r['aSystem'], 'signatureID' => $r['aSig'], 'name' => $r['aName'], 'rowID' => (int) $r['aRow']],
            'to' => ['systemID' => (int) $r['bSystem'], 'signatureID' => $r['bSig'], 'name' => $r['bName'], 'rowID' => (int) $r['bRow']],
        ];
    }
    $truncated = count($holes) > API_V1_LIMIT || count($systems) > API_V1_LIMIT;
    return [200, ['mask' => $mask, 'truncated' => $truncated, 'systems' => array_slice($systems, 0, API_V1_LIMIT), 'holes' => array_slice($holes, 0, API_V1_LIMIT)]];
}

/** Retry once after creating the structures tables (they are created on first use) */
function api_v1_structures_run(PDO $db, callable $fn) {
    try {
        return $fn();
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') throw $e;
        structures_schema($db);
        return $fn();
    }
}

function api_v1_friendly(array $ctx) {
    return intel_friendly_ids(['corporationID' => $ctx['character']['corporationID'], 'allianceID' => null], $ctx['mask']);
}

function api_v1_structures(PDO $db, array $ctx, array $query) {
    $error = null;
    $systemID = api_v1_system_param($query, $error);
    if ($error) return [400, ['error' => $error]];
    $friendly = api_v1_friendly($ctx);
    return api_v1_structures_run($db, function () use ($db, $ctx, $systemID, $friendly) {
        if ($systemID !== null) {
            $list = structures_list($db, $ctx['mask'], $systemID, $friendly);
            return [200, ['mask' => $ctx['mask'], 'systemID' => $systemID, 'truncated' => false, 'structures' => $list['structures'], 'gone' => $list['gone']]];
        }
        $stmt = $db->prepare(structures_select() . ' WHERE maskID = :mask AND ' . structures_live_where() . ' ORDER BY systemID, id LIMIT ' . (API_V1_LIMIT + 1));
        $stmt->bindValue(':mask', $ctx['mask']);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $structures = [];
        foreach (array_slice($rows, 0, API_V1_LIMIT) as $r) $structures[] = structures_format($r, $friendly);
        return [200, ['mask' => $ctx['mask'], 'systemID' => null, 'truncated' => count($rows) > API_V1_LIMIT, 'structures' => $structures]];
    });
}

function api_v1_timers(PDO $db, array $ctx, $now) {
    $friendly = api_v1_friendly($ctx);
    return api_v1_structures_run($db, function () use ($db, $ctx, $now, $friendly) {
        $timers = structures_timers($db, $ctx['mask'], $friendly, $now, STRUCTURES_BOARD_MAX + 1);
        return [200, ['mask' => $ctx['mask'], 'serverTime' => (int) $now, 'truncated' => count($timers) > STRUCTURES_BOARD_MAX, 'timers' => array_slice($timers, 0, STRUCTURES_BOARD_MAX)]];
    });
}

function api_v1_notes(PDO $db, array $ctx, array $query) {
    $error = null;
    $systemID = api_v1_system_param($query, $error);
    if ($error) return [400, ['error' => $error]];
    $sql = 'SELECT id, systemID, comment, created, createdByName, modified, modifiedByName FROM comments WHERE maskID = :mask'
        . ($systemID !== null ? ' AND systemID = :system' : '') . ' ORDER BY systemID, id LIMIT ' . (API_V1_LIMIT + 1);
    $stmt = $db->prepare($sql);
    $stmt->bindValue(':mask', $ctx['mask']);
    if ($systemID !== null) $stmt->bindValue(':system', $systemID, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $notes = [];
    foreach (array_slice($rows, 0, API_V1_LIMIT) as $r) {
        $notes[] = [
            'id' => (int) $r['id'], 'systemID' => (int) $r['systemID'],
            'html' => sanitizeNoteHtml($r['comment']),   // stored sanitised; sanitised again here so an old row never hands out markup
            'createdAt' => api_token_iso($r['created']), 'createdBy' => $r['createdByName'],
            'modifiedAt' => api_token_iso($r['modified']), 'modifiedBy' => $r['modifiedByName'],
        ];
    }
    return [200, ['mask' => $ctx['mask'], 'systemID' => $systemID, 'truncated' => count($rows) > API_V1_LIMIT, 'notes' => $notes]];
}

/** Route /api/v1/<segments>: $segments = the path parts after "v1". Returns [status, payload]. */
function api_v1_route(PDO $db, array $ctx, array $segments, array $query, $now) {
    $segments = array_values(array_filter($segments, function ($s) { return $s !== ''; }));
    if (count($segments) > 1) return [404, ['error' => 'Not found']];
    $name = $segments ? $segments[0] : '';
    switch ($name) {
        case '': return api_v1_who($db, $ctx, $now);
        case 'chain': return api_v1_chain($db, $ctx);
        case 'signatures': return api_v1_signatures($db, $ctx, $query);
        case 'structures': return api_v1_structures($db, $ctx, $query);
        case 'timers': return api_v1_timers($db, $ctx, $now);
        case 'notes': case 'comments': return api_v1_notes($db, $ctx, $query);
    }
    return [404, ['error' => 'Not found']];
}
