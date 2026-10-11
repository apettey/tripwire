<?php
// Fork-owned: several mask admins, removing/blocking members and mask-wide default settings (see docker/README.md#mask-admins).
//
// Who is "admin of a custom mask" (X.0) is decided in three layers, strongest first:
//   owner       the character that owns the mask (masks.ownerType 1373), or
//   corp-admin  a Tripwire admin of the corporation that owns it (characters.admin = 1, masks.ownerType 2) - the two
//               upstream checks checkOwner() / checkAdmin() (lib.inc.php);
//   granted     a character the owner or a corp admin made mask admin (fork_mask_admins). checkAdmin() accepts these too
//               (one line in lib.inc.php), so everything that asks "is this an admin of the mask" - Mask Admin, the Discord /
//               Watchlist / Fight here tabs - honours them. Only owner and corp-admin ("managers") grant and revoke, and
//               a granted admin can't delete the mask (public/masks.php asks maskadmin_corp_admin() for that).
// Blocking: fork_mask_blocks. A blocked character's session drops to the corp mask on the next request, whichever
// endpoint it is (docker/db.inc.php calls maskadmin_enforce_session(), and every endpoint loads db.inc.php), and the mask
// is hidden from their mask list.
// Defaults: fork_mask_defaults holds a JSON object {optionsKey: value}; the browser (app/js/fork/mask-defaults.js) uses it
// for keys a member has no setting of their own for.
//
// Everything here takes the mask and the character explicitly (the session only in the *_session wrappers), so the PHP tests
// can run it without a web server. The mask of every call to the endpoint (public/mask_admins.php) is the session's mask,
// never a request value.

require_once(__DIR__ . '/../mask-guard.inc.php');   // tripwire_mask_canonical

const MASKADMIN_DDL = [
    "CREATE TABLE IF NOT EXISTS `fork_mask_admins` (
      `maskID` decimal(12,1) NOT NULL,
      `characterID` int NOT NULL,
      `grantedBy` int NOT NULL,
      `grantedByName` varchar(50) NOT NULL DEFAULT '',
      `grantedAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`, `characterID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_mask_blocks` (
      `maskID` decimal(12,1) NOT NULL,
      `characterID` int NOT NULL,
      `characterName` varchar(50) NOT NULL DEFAULT '',
      `reason` varchar(200) NOT NULL DEFAULT '',
      `blockedBy` int NOT NULL,
      `blockedByName` varchar(50) NOT NULL DEFAULT '',
      `blockedAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`, `characterID`),
      KEY `character` (`characterID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_mask_defaults` (
      `maskID` decimal(12,1) NOT NULL,
      `defaults` mediumtext NOT NULL,
      `updatedBy` varchar(50) NOT NULL DEFAULT '',
      `updatedAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
    "CREATE TABLE IF NOT EXISTS `fork_mask_audit` (
      `id` int NOT NULL AUTO_INCREMENT,
      `maskID` decimal(12,1) NOT NULL,
      `at` datetime NOT NULL,
      `actorID` int NOT NULL,
      `actorName` varchar(50) NOT NULL DEFAULT '',
      `action` varchar(20) NOT NULL,
      `targetID` int NOT NULL DEFAULT 0,
      `targetName` varchar(50) NOT NULL DEFAULT '',
      `detail` varchar(200) NOT NULL DEFAULT '',
      PRIMARY KEY (`id`),
      KEY `mask` (`maskID`, `id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

const MASKADMIN_MEMBER_LIMIT = 300;
const MASKADMIN_AUDIT_SHOW = 50;
const MASKADMIN_AUDIT_KEEP = 500;
const MASKADMIN_REASON_MAX = 200;
const MASKADMIN_DEFAULTS_MAX_BYTES = 16384;
const MASKADMIN_DEFAULTS_MAX_KEYS = 40;
// The only options a mask default may carry: the top-level options keys the fork's Settings rows store (forkSettings.register
// with a `key`). The browser has the same list (maskDefaults.ALLOWED); a mocha test keeps both equal to the keys the rows use.
const MASKADMIN_DEFAULTS_ALLOW = ['autoMass', 'chainKillFeed', 'favouritesRouteStrip', 'highsecRegion', 'holeNaming', 'intelScans', 'jumpReturn',
    'killReporting', 'lootBuyers', 'preserveMass', 'rollPlan', 'rolling', 'rollingCalc', 'routeHoleFilters', 'sigAge', 'sigInline', 'sigAnomalies', 'sizeTags', 'skyhooksPanel', 'smartNotes',
    'soundMute', 'structures', 'systemKillFeed', 'systemResidents', 'systemThreat', 'theraRoute', 'watchlist'];

function maskadmin_ensure_schema(PDO $db) {
    foreach (MASKADMIN_DDL as $ddl) $db->exec($ddl);
}

/** Run $fn; if a fork table is missing, create the tables and run it once more (tables are created on first use) */
function maskadmin_run(PDO $db, callable $fn) {
    try {
        return $fn();
    } catch (PDOException $e) {
        if ($e->getCode() !== '42S02') throw $e;
        maskadmin_ensure_schema($db);
        return $fn();
    }
}

/** Custom masks (X.0, X > 0) are the ones with an owner, an access list, admins and blocks */
function maskadmin_is_custom($mask) {
    return is_string($mask) && preg_match('/^[1-9][0-9]{0,9}\.0$/', $mask) === 1;
}

/** The mask's key as the tables store it ("12.0" -> "12.0") or null if it isn't a mask id at all */
function maskadmin_mask_key($mask) {
    return is_string($mask) && preg_match('/^[0-9]{1,10}\.[0-3]$/', $mask) === 1 ? $mask : null;
}

function maskadmin_mask_row(PDO $db, $mask) {
    if (!maskadmin_is_custom($mask)) return null;
    $stmt = $db->prepare('SELECT maskID, name, ownerID, ownerType FROM masks WHERE maskID = ?');
    $stmt->execute([$mask]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function maskadmin_character(PDO $db, $characterID) {
    $stmt = $db->prepare('SELECT characterID, characterName, corporationID, corporationName, admin FROM characters WHERE characterID = ?');
    $stmt->execute([(int) $characterID]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

/**
 * The strongest of 'owner' / 'corp-admin' (upstream's two checks, from the database) the character has on the mask, or null.
 * The corp mask (C.2) counts too: its corp admins. Other default masks have no admins.
 */
function maskadmin_base_level(PDO $db, $mask, $characterID) {
    $character = maskadmin_character($db, $characterID);
    if (!$character) return null;
    if (is_string($mask) && preg_match('/^([0-9]+)\.2$/', $mask, $m)) {
        return ((int) $m[1] === (int) $character['corporationID'] && (int) $character['admin'] === 1) ? 'corp-admin' : null;
    }
    $row = maskadmin_mask_row($db, $mask);
    if (!$row) return null;
    if ((int) $row['ownerType'] === 1373 && (int) $row['ownerID'] === (int) $character['characterID']) return 'owner';
    if ((int) $row['ownerType'] === 2 && (int) $row['ownerID'] === (int) $character['corporationID'] && (int) $character['admin'] === 1) return 'corp-admin';
    return null;
}

function maskadmin_is_granted(PDO $db, $mask, $characterID) {
    if (!maskadmin_is_custom($mask)) return false;
    return maskadmin_run($db, function () use ($db, $mask, $characterID) {
        $stmt = $db->prepare('SELECT 1 FROM fork_mask_admins WHERE maskID = ? AND characterID = ?');
        $stmt->execute([$mask, (int) $characterID]);
        return (bool) $stmt->fetchColumn();
    });
}

function maskadmin_is_blocked(PDO $db, $mask, $characterID) {
    if (!maskadmin_is_custom($mask)) return false;
    return maskadmin_run($db, function () use ($db, $mask, $characterID) {
        $stmt = $db->prepare('SELECT 1 FROM fork_mask_blocks WHERE maskID = ? AND characterID = ?');
        $stmt->execute([$mask, (int) $characterID]);
        return (bool) $stmt->fetchColumn();
    });
}

/** 'owner' | 'corp-admin' | 'granted' | null. A blocked character has no level (blocking is refused for admins, this is the safety net). */
function maskadmin_level(PDO $db, $mask, $characterID, $allianceID = null) {
    $base = maskadmin_base_level($db, $mask, $characterID);
    if ($base) return $base;
    if (maskadmin_is_blocked($db, $mask, $characterID)) return null;
    if (!maskadmin_is_granted($db, $mask, $characterID)) return null;
    // a grant counts only while the character still has access to the mask (their corporation / alliance may have lost it)
    $character = maskadmin_character($db, $characterID);
    return $character && maskadmin_has_access($db, $mask, $characterID, $character['corporationID'], $allianceID) ? 'granted' : null;
}

/** Access to a custom mask by the same rule as upstream's verifyMask(): owner or an access-list entry for the character, corporation or alliance */
function maskadmin_has_access(PDO $db, $mask, $characterID, $corporationID, $allianceID = null) {
    if (!maskadmin_is_custom($mask)) return false;
    $stmt = $db->prepare('SELECT 1 FROM masks m LEFT JOIN `groups` g ON g.maskID = m.maskID WHERE m.maskID = :m AND ('
        . '(m.ownerType = 1373 AND m.ownerID = :c) OR (m.ownerType = 2 AND m.ownerID = :corp) OR (m.ownerType = 3 AND m.ownerID = :ally)'
        . ' OR (g.eveType = 1373 AND g.eveID = :c2) OR (g.eveType = 2 AND g.eveID = :corp2) OR (g.eveType = 3 AND g.eveID = :ally2)) LIMIT 1');
    $stmt->execute([':m' => $mask, ':c' => (int) $characterID, ':corp' => (int) $corporationID, ':ally' => (int) $allianceID,
        ':c2' => (int) $characterID, ':corp2' => (int) $corporationID, ':ally2' => (int) $allianceID]);
    return (bool) $stmt->fetchColumn();
}

/** May grant/revoke admins: the owner and the owning corporation's admins, not granted admins */
function maskadmin_is_manager(PDO $db, $mask, $characterID) {
    return maskadmin_base_level($db, $mask, $characterID) !== null && maskadmin_is_custom($mask);
}

/** May block, unblock, remove members and set the mask defaults: every admin level. The corp mask: its admins (defaults only). */
function maskadmin_is_admin(PDO $db, $mask, $characterID, $allianceID = null) {
    return maskadmin_level($db, $mask, $characterID, $allianceID) !== null;
}

// ---- the session wrappers upstream's code calls ----

/** lib.inc.php checkAdmin() falls back to this: is the session's character a granted admin of $mask */
function maskadmin_session_granted($mask, $fresh = false) {
    global $mysql;
    static $cache = [];
    if (!maskadmin_is_custom($mask) || empty($_SESSION['characterID']) || !($mysql instanceof PDO)) return false;
    $key = $mask . '|' . $_SESSION['characterID'];
    if ($fresh || !isset($cache[$key])) {
        try {
            $cache[$key] = maskadmin_is_granted($mysql, $mask, $_SESSION['characterID'])
                && !maskadmin_is_blocked($mysql, $mask, $_SESSION['characterID'])
                && maskadmin_has_access($mysql, $mask, $_SESSION['characterID'], isset($_SESSION['corporationID']) ? $_SESSION['corporationID'] : 0,
                    isset($_SESSION['allianceID']) ? $_SESSION['allianceID'] : null);
        } catch (PDOException $e) {
            error_log('maskadmin_session_granted: ' . $e->getMessage());
            $cache[$key] = false;
        }
    }
    return $cache[$key];
}

/** masks.inc.php hides a blocked mask from the mask list */
function maskadmin_session_blocked($mask) {
    global $mysql;
    if (!maskadmin_is_custom((string) $mask) || empty($_SESSION['characterID']) || !($mysql instanceof PDO)) return false;
    try {
        return maskadmin_is_blocked($mysql, (string) $mask, $_SESSION['characterID']);
    } catch (PDOException $e) {
        error_log('maskadmin_session_blocked: ' . $e->getMessage());
        return false;
    }
}

/** What upstream's checkAdmin() decided before the fork's addition: only the corporation's Tripwire admins (the mask delete uses it) */
function maskadmin_corp_admin($mask) {
    global $mysql;
    if (empty($_SESSION['characterID']) || !($mysql instanceof PDO)) return false;
    return maskadmin_base_level($mysql, (string) $mask, $_SESSION['characterID']) === 'corp-admin';
}

/**
 * The one spelling of a mask id the rest of the code (and this feature's tables) must see. Upstream compares and stores mask ids
 * loosely: MySQL turns "12.00", " 12.0", "012.0" or "12.0abc" into the decimal 12.0, so a session mask of any of those would
 * read the data of mask 12.0 while escaping a lookup by the exact string "12.0" (our block check). Only `digits.0-3` is accepted
 * (leading zeros dropped); anything else, or anything that is not a string/number, becomes the character's corp mask.
 */
function maskadmin_canonical_mask($mask, $corporationID) {
    $canonical = tripwire_mask_canonical($mask);   // mask-guard.inc.php (the hotfix that canonicalises the session mask)
    return $canonical !== null ? $canonical : ((int) $corporationID) . '.2';
}

/**
 * The mask a character may use: $mask itself, or their corp mask if $mask is a custom mask they are blocked from.
 * (Access to a mask they are not blocked from is upstream's verifyMask().) Fails closed for a custom mask if the
 * blocks can't be read.
 */
function maskadmin_enforced_mask(PDO $db, $mask, $characterID, $corporationID) {
    $mask = maskadmin_canonical_mask($mask, $corporationID);
    if (!maskadmin_is_custom((string) $mask)) return $mask;
    try {
        return maskadmin_is_blocked($db, (string) $mask, $characterID) ? ((int) $corporationID . '.2') : $mask;
    } catch (PDOException $e) {
        error_log('maskadmin_enforced_mask: ' . $e->getMessage());
        return ((int) $corporationID . '.2');
    }
}

/** docker/db.inc.php: runs on every request that loads the database, before the endpoint reads $_SESSION['mask'] */
function maskadmin_enforce_session(PDO $db) {
    if (!isset($_SESSION) || !is_array($_SESSION) || !isset($_SESSION['mask'], $_SESSION['characterID'], $_SESSION['corporationID'])) return;
    $mask = maskadmin_enforced_mask($db, is_string($_SESSION['mask']) || is_int($_SESSION['mask']) ? (string) $_SESSION['mask'] : null, $_SESSION['characterID'], $_SESSION['corporationID']);
    if (!is_string($_SESSION['mask']) || (string) $mask !== $_SESSION['mask']) {
        $_SESSION['mask'] = $mask;
        if (isset($_SESSION['options']) && is_object($_SESSION['options']) && isset($_SESSION['options']->masks)) {
            $_SESSION['options']->masks->active = $mask;
        }
    }
}

// ---- members, targets ----

/**
 * Characters that have, or had, a way into the mask: its corporation/character entries, characters that used it (the
 * alliance entries are not enumerable: Tripwire stores no alliance per character) and the blocked. Returns
 * [rows, truncated]; each row has characterID, characterName, corporationName, admin.
 */
function maskadmin_members(PDO $db, $mask, $search = '') {
    $sql = 'SELECT c.characterID, c.characterName, c.corporationID, c.corporationName, c.admin FROM characters c WHERE ('
        . 'c.corporationID IN (SELECT eveID FROM `groups` WHERE maskID = :m1 AND eveType = 2 AND joined = 1)'
        . ' OR c.corporationID IN (SELECT ownerID FROM masks WHERE maskID = :m2 AND ownerType = 2)'
        . ' OR c.characterID IN (SELECT eveID FROM `groups` WHERE maskID = :m3 AND eveType = 1373 AND joined = 1)'
        . ' OR c.characterID IN (SELECT ownerID FROM masks WHERE maskID = :m4 AND ownerType = 1373)'
        . ' OR c.characterID IN (SELECT characterID FROM statistics WHERE maskID = :m5)'
        . ' OR c.characterID IN (SELECT characterID FROM fork_mask_blocks WHERE maskID = :m6))';
    $search = trim((string) $search);
    if ($search !== '') $sql .= ' AND c.characterName LIKE :q ESCAPE \'\\\\\'';
    $sql .= ' ORDER BY c.characterName LIMIT ' . (MASKADMIN_MEMBER_LIMIT + 1);
    return maskadmin_run($db, function () use ($db, $sql, $mask, $search) {
        $stmt = $db->prepare($sql);
        foreach (['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] as $p) $stmt->bindValue(':' . $p, $mask);
        if ($search !== '') $stmt->bindValue(':q', '%' . addcslashes($search, '\\%_') . '%');
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $truncated = count($rows) > MASKADMIN_MEMBER_LIMIT;
        return [array_slice($rows, 0, MASKADMIN_MEMBER_LIMIT), $truncated];
    });
}

/** Has the character a way into the mask (as maskadmin_members lists it), by id */
function maskadmin_is_member(PDO $db, $mask, $characterID) {
    $character = maskadmin_character($db, $characterID);
    if (!$character) return false;
    return maskadmin_run($db, function () use ($db, $mask, $character) {
        $stmt = $db->prepare('SELECT 1 FROM characters c WHERE c.characterID = :c AND ('
            . 'c.corporationID IN (SELECT eveID FROM `groups` WHERE maskID = :m1 AND eveType = 2 AND joined = 1)'
            . ' OR c.corporationID IN (SELECT ownerID FROM masks WHERE maskID = :m2 AND ownerType = 2)'
            . ' OR c.characterID IN (SELECT eveID FROM `groups` WHERE maskID = :m3 AND eveType = 1373 AND joined = 1)'
            . ' OR c.characterID IN (SELECT ownerID FROM masks WHERE maskID = :m4 AND ownerType = 1373)'
            . ' OR c.characterID IN (SELECT characterID FROM statistics WHERE maskID = :m5)'
            . ' OR c.characterID IN (SELECT characterID FROM fork_mask_blocks WHERE maskID = :m6))');
        $stmt->bindValue(':c', (int) $character['characterID']);
        foreach (['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] as $p) $stmt->bindValue(':' . $p, $mask);
        $stmt->execute();
        return (bool) $stmt->fetchColumn();
    });
}

/** Does the character have a direct (character) entry in the access list - the only kind "remove" can take away */
function maskadmin_direct_entry(PDO $db, $mask, $characterID) {
    $stmt = $db->prepare('SELECT 1 FROM `groups` WHERE maskID = ? AND eveType = 1373 AND eveID = ?');
    $stmt->execute([$mask, (int) $characterID]);
    return (bool) $stmt->fetchColumn();
}

/** One line of user text: control characters and runs of spaces become one space, trimmed, cut to $max characters */
function maskadmin_clean_text($text, $max) {
    $text = preg_replace('/[\x00-\x1F\x7F\x{2028}\x{2029}]+/u', ' ', (string) $text);
    if ($text === null) return '';   // invalid UTF-8
    $text = trim(preg_replace('/\s+/u', ' ', $text));
    return mb_substr($text, 0, $max, 'UTF-8');
}

// ---- actions. Each returns [ok, message, httpStatus]. $actor = ['id', 'name'] of the logged-in character. ----

function maskadmin_audit(PDO $db, $mask, array $actor, $action, $targetID, $targetName, $detail = '') {
    $stmt = $db->prepare('INSERT INTO fork_mask_audit (maskID, at, actorID, actorName, action, targetID, targetName, detail) VALUES (?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?)');
    $stmt->execute([$mask, (int) $actor['id'], mb_substr((string) $actor['name'], 0, 50), $action, (int) $targetID, mb_substr((string) $targetName, 0, 50), maskadmin_clean_text($detail, 200)]);
    // keep the newest MASKADMIN_AUDIT_KEEP entries per mask
    $stmt = $db->prepare('DELETE FROM fork_mask_audit WHERE maskID = ? AND id <= (SELECT id FROM (SELECT id FROM fork_mask_audit WHERE maskID = ? ORDER BY id DESC LIMIT 1 OFFSET ' . MASKADMIN_AUDIT_KEEP . ') t)');
    $stmt->execute([$mask, $mask]);
}

/** Why $targetID can't be the target of a grant/block/remove on $mask: their level makes them untouchable, or null */
function maskadmin_protected_reason(PDO $db, $mask, $targetID) {
    $base = maskadmin_base_level($db, $mask, $targetID);
    if ($base === 'owner') return 'That is the owner of the mask';
    if ($base === 'corp-admin') return 'That is a Tripwire admin of the corporation that owns the mask';
    return null;
}

function maskadmin_grant(PDO $db, $mask, array $actor, $targetID) {
    if (!maskadmin_is_custom($mask)) return [false, 'Admins can only be set on custom masks', 400];
    if (!maskadmin_is_manager($db, $mask, $actor['id'])) return [false, 'Only the mask owner or the owning corporation\'s admins can grant mask admin', 403];
    $target = maskadmin_character($db, $targetID);
    if (!$target) return [false, 'Unknown character', 404];
    if ($reason = maskadmin_protected_reason($db, $mask, $targetID)) return [false, $reason . ': they are admin already', 400];
    if (!maskadmin_is_member($db, $mask, $targetID)) return [false, 'That character has no access to this mask', 404];
    if (maskadmin_is_blocked($db, $mask, $targetID)) return [false, 'Unblock the character first', 409];
    $stmt = $db->prepare('INSERT IGNORE INTO fork_mask_admins (maskID, characterID, grantedBy, grantedByName, grantedAt) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())');
    $stmt->execute([$mask, (int) $target['characterID'], (int) $actor['id'], mb_substr((string) $actor['name'], 0, 50)]);
    if ($stmt->rowCount()) maskadmin_audit($db, $mask, $actor, 'grant', $target['characterID'], $target['characterName']);
    return [true, '', 200];
}

function maskadmin_revoke(PDO $db, $mask, array $actor, $targetID) {
    if (!maskadmin_is_custom($mask)) return [false, 'Admins can only be set on custom masks', 400];
    if (!maskadmin_is_manager($db, $mask, $actor['id'])) return [false, 'Only the mask owner or the owning corporation\'s admins can revoke mask admin', 403];
    if ($reason = maskadmin_protected_reason($db, $mask, $targetID)) return [false, $reason . ': that can\'t be revoked', 400];
    $target = maskadmin_character($db, $targetID);
    $stmt = $db->prepare('DELETE FROM fork_mask_admins WHERE maskID = ? AND characterID = ?');
    $stmt->execute([$mask, (int) $targetID]);
    if (!$stmt->rowCount()) return [false, 'That character is not a granted admin', 404];
    maskadmin_audit($db, $mask, $actor, 'revoke', $targetID, $target ? $target['characterName'] : '');
    return [true, '', 200];
}

function maskadmin_block(PDO $db, $mask, array $actor, $targetID, $reason) {
    if (!maskadmin_is_custom($mask)) return [false, 'Members can only be blocked from custom masks', 400];
    if (!maskadmin_is_admin($db, $mask, $actor['id'], isset($actor['alliance']) ? $actor['alliance'] : null)) return [false, 'Only mask admins can block members', 403];
    $target = maskadmin_character($db, $targetID);
    if (!$target) return [false, 'Unknown character', 404];
    if ((int) $target['characterID'] === (int) $actor['id']) return [false, 'You can\'t block yourself', 400];
    if ($why = maskadmin_protected_reason($db, $mask, $targetID)) return [false, $why . ': they can\'t be blocked', 400];
    if (maskadmin_is_granted($db, $mask, $targetID)) return [false, 'That character is a mask admin: revoke that first', 409];
    if (!maskadmin_is_member($db, $mask, $targetID)) return [false, 'That character has no access to this mask', 404];
    $reason = maskadmin_clean_text($reason, MASKADMIN_REASON_MAX);
    if ($reason === '') return [false, 'A reason is required', 400];
    $stmt = $db->prepare('INSERT INTO fork_mask_blocks (maskID, characterID, characterName, reason, blockedBy, blockedByName, blockedAt) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())'
        . ' ON DUPLICATE KEY UPDATE reason = VALUES(reason), blockedBy = VALUES(blockedBy), blockedByName = VALUES(blockedByName), blockedAt = VALUES(blockedAt)');
    $stmt->execute([$mask, (int) $target['characterID'], $target['characterName'], $reason, (int) $actor['id'], mb_substr((string) $actor['name'], 0, 50)]);
    maskadmin_audit($db, $mask, $actor, 'block', $target['characterID'], $target['characterName'], $reason);
    return [true, '', 200];
}

function maskadmin_unblock(PDO $db, $mask, array $actor, $targetID) {
    if (!maskadmin_is_custom($mask)) return [false, 'Members can only be blocked from custom masks', 400];
    if (!maskadmin_is_admin($db, $mask, $actor['id'], isset($actor['alliance']) ? $actor['alliance'] : null)) return [false, 'Only mask admins can unblock members', 403];
    $stmt = $db->prepare('SELECT characterName FROM fork_mask_blocks WHERE maskID = ? AND characterID = ?');
    $stmt->execute([$mask, (int) $targetID]);
    $name = $stmt->fetchColumn();
    if ($name === false) return [false, 'That character is not blocked', 404];
    $db->prepare('DELETE FROM fork_mask_blocks WHERE maskID = ? AND characterID = ?')->execute([$mask, (int) $targetID]);
    maskadmin_audit($db, $mask, $actor, 'unblock', $targetID, $name);
    return [true, '', 200];
}

/** Take a character's own entry out of the access list. Access through the corporation or alliance can only be blocked. */
function maskadmin_remove(PDO $db, $mask, array $actor, $targetID) {
    if (!maskadmin_is_custom($mask)) return [false, 'Access can only be removed from custom masks', 400];
    if (!maskadmin_is_admin($db, $mask, $actor['id'], isset($actor['alliance']) ? $actor['alliance'] : null)) return [false, 'Only mask admins can remove members', 403];
    $target = maskadmin_character($db, $targetID);
    if (!$target) return [false, 'Unknown character', 404];
    if ($why = maskadmin_protected_reason($db, $mask, $targetID)) return [false, $why . ': their access can\'t be removed', 400];
    if (maskadmin_is_granted($db, $mask, $targetID)) return [false, 'That character is a mask admin: revoke that first', 409];
    if (!maskadmin_direct_entry($db, $mask, $targetID)) return [false, 'This character has access through their corporation or alliance: block them instead', 409];
    $db->prepare('DELETE FROM `groups` WHERE maskID = ? AND eveType = 1373 AND eveID = ?')->execute([$mask, (int) $targetID]);
    maskadmin_audit($db, $mask, $actor, 'remove', $target['characterID'], $target['characterName']);
    return [true, '', 200];
}

// ---- mask defaults ----

/** The deepest nesting and the longest string a default may have */
const MASKADMIN_DEFAULTS_DEPTH = 5;
const MASKADMIN_DEFAULTS_STRING = 200;

function maskadmin_valid_value($value, $depth) {
    if ($depth > MASKADMIN_DEFAULTS_DEPTH) return false;
    if (is_bool($value) || is_int($value) || is_null($value)) return true;
    if (is_float($value)) return is_finite($value);
    if (is_string($value)) return mb_strlen($value, 'UTF-8') <= MASKADMIN_DEFAULTS_STRING && !preg_match('/[<>\x00-\x08\x0B\x0C\x0E-\x1F]/', $value);
    if (is_array($value)) {
        if (count($value) > 50) return false;
        foreach ($value as $k => $v) {
            if (!is_int($k) && !preg_match('/^[A-Za-z0-9_\-. ]{1,60}$/', (string) $k)) return false;
            if ($k === '__proto__' || $k === 'constructor' || $k === 'prototype') return false;
            if (!maskadmin_valid_value($v, $depth + 1)) return false;
        }
        return true;
    }
    return false;
}

/** Validate the JSON object an admin saves as the mask defaults (decoded as arrays). Returns [clean array|null, error] */
function maskadmin_validate_defaults($in) {
    if (!is_array($in) || (count($in) > 0 && array_keys($in) === range(0, count($in) - 1))) return [null, 'Defaults must be an object'];
    if (count($in) > MASKADMIN_DEFAULTS_MAX_KEYS) return [null, 'At most ' . MASKADMIN_DEFAULTS_MAX_KEYS . ' settings'];
    foreach ($in as $key => $value) {
        $key = (string) $key;
        if (!preg_match('/^[A-Za-z][A-Za-z0-9_]{0,39}$/', $key)) return [null, 'Invalid setting name'];
        if (!in_array($key, MASKADMIN_DEFAULTS_ALLOW, true)) return [null, 'The setting "' . $key . '" can\'t have a mask default'];
        if (!maskadmin_valid_value($value, 1)) return [null, 'Invalid value for "' . $key . '"'];
    }
    if (strlen(json_encode($in)) > MASKADMIN_DEFAULTS_MAX_BYTES) return [null, 'Defaults too large'];
    return [$in, ''];
}

function maskadmin_defaults_load(PDO $db, $mask) {
    $mask = maskadmin_mask_key($mask);
    if ($mask === null) return ['defaults' => new stdClass(), 'updatedBy' => '', 'updatedAt' => null];
    return maskadmin_run($db, function () use ($db, $mask) {
        $stmt = $db->prepare('SELECT `defaults`, updatedBy, updatedAt FROM fork_mask_defaults WHERE maskID = ?');
        $stmt->execute([$mask]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $defaults = $row ? json_decode($row['defaults']) : null;
        $allowed = new stdClass();   // only allow-listed keys leave the server, whatever the table holds
        if (is_object($defaults)) {
            foreach (MASKADMIN_DEFAULTS_ALLOW as $k) if (property_exists($defaults, $k)) $allowed->$k = $defaults->$k;
        }
        return [
            'defaults' => $allowed,
            'updatedBy' => $row ? $row['updatedBy'] : '',
            'updatedAt' => $row ? $row['updatedAt'] : null,
        ];
    });
}

/** Admins of a custom mask or the corp mask set the defaults. $defaults: decoded array, [] clears them. */
function maskadmin_defaults_save(PDO $db, $mask, array $actor, $defaults) {
    if (!maskadmin_is_custom($mask) && !preg_match('/^[0-9]+\.2$/', (string) $mask)) return [false, 'Mask defaults are for custom masks and the corp mask', 400];
    if (!maskadmin_is_admin($db, $mask, $actor['id'], isset($actor['alliance']) ? $actor['alliance'] : null)) return [false, 'Only mask admins can set the mask defaults', 403];
    list($clean, $error) = maskadmin_validate_defaults($defaults);
    if ($clean === null) return [false, $error, 400];
    if (!$clean) {
        $db->prepare('DELETE FROM fork_mask_defaults WHERE maskID = ?')->execute([$mask]);
        maskadmin_audit($db, $mask, $actor, 'defaults', 0, '', 'cleared');
        return [true, '', 200];
    }
    $stmt = $db->prepare('INSERT INTO fork_mask_defaults (maskID, `defaults`, updatedBy, updatedAt) VALUES (?, ?, ?, UTC_TIMESTAMP())'
        . ' ON DUPLICATE KEY UPDATE `defaults` = VALUES(`defaults`), updatedBy = VALUES(updatedBy), updatedAt = VALUES(updatedAt)');
    $stmt->execute([$mask, json_encode($clean), mb_substr((string) $actor['name'], 0, 50)]);
    maskadmin_audit($db, $mask, $actor, 'defaults', 0, '', implode(', ', array_slice(array_keys($clean), 0, 12)));
    return [true, '', 200];
}

// ---- what the Mask Admin tab shows ----

function maskadmin_state(PDO $db, $mask, $viewerID, $search = '', $allianceID = null) {
    $level = maskadmin_level($db, $mask, $viewerID, $allianceID);
    $custom = maskadmin_is_custom($mask);
    $out = ['custom' => $custom, 'level' => $level, 'canManage' => $custom && maskadmin_is_manager($db, $mask, $viewerID), 'canAdmin' => $level !== null];
    if ($level === null) return $out;
    $defaults = maskadmin_defaults_load($db, $mask);
    $out['defaults'] = $defaults['defaults'];
    $out['defaultsBy'] = $defaults['updatedBy'];
    $out['defaultsAt'] = $defaults['updatedAt'];
    $out['audit'] = maskadmin_run($db, function () use ($db, $mask) {
        $stmt = $db->prepare('SELECT at, actorName, action, targetID, targetName, detail FROM fork_mask_audit WHERE maskID = ? ORDER BY id DESC LIMIT ' . MASKADMIN_AUDIT_SHOW);
        $stmt->execute([$mask]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    });
    if (!$custom) return $out;

    $row = maskadmin_mask_row($db, $mask);
    $out['mask'] = ['id' => $mask, 'name' => $row ? $row['name'] : '', 'ownerType' => $row ? (int) $row['ownerType'] : 0, 'ownerID' => $row ? (int) $row['ownerID'] : 0];
    $granted = maskadmin_run($db, function () use ($db, $mask) {
        $stmt = $db->prepare('SELECT a.characterID, IFNULL(c.characterName, \'\') AS characterName, a.grantedByName, a.grantedAt FROM fork_mask_admins a LEFT JOIN characters c ON c.characterID = a.characterID WHERE a.maskID = ? ORDER BY a.grantedAt');
        $stmt->execute([$mask]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    });
    $blocked = maskadmin_run($db, function () use ($db, $mask) {
        $stmt = $db->prepare('SELECT characterID, characterName, reason, blockedByName, blockedAt FROM fork_mask_blocks WHERE maskID = ? ORDER BY blockedAt DESC');
        $stmt->execute([$mask]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    });
    $blockedIDs = array_map('intval', array_column($blocked, 'characterID'));
    $grantedIDs = array_map('intval', array_column($granted, 'characterID'));
    list($members, $truncated) = maskadmin_members($db, $mask, $search);
    $ownerType = $row ? (int) $row['ownerType'] : 0;
    $ownerID = $row ? (int) $row['ownerID'] : 0;
    // the level upstream's checks give a character, from the row (same rules as maskadmin_base_level)
    $baseOf = function ($c) use ($ownerType, $ownerID) {
        if ($ownerType === 1373 && $ownerID === (int) $c['characterID']) return 'owner';
        if ($ownerType === 2 && $ownerID === (int) $c['corporationID'] && (int) $c['admin'] === 1) return 'corp-admin';
        return null;
    };
    $stmt = $db->prepare('SELECT eveID FROM `groups` WHERE maskID = ? AND eveType = 1373');
    $stmt->execute([$mask]);
    $directIDs = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    // the owner and the owning corporation's admins: always listed, whatever the member search or limit
    if ($ownerType === 1373) {
        $stmt = $db->prepare('SELECT characterID, characterName, corporationID, admin FROM characters WHERE characterID = ?');
    } else {
        $stmt = $db->prepare('SELECT characterID, characterName, corporationID, admin FROM characters WHERE corporationID = ? AND admin = 1 ORDER BY characterName LIMIT 100');
    }
    $stmt->execute([$ownerID]);
    $owners = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $c) {
        if ($baseOf($c)) $owners[] = ['characterID' => (int) $c['characterID'], 'characterName' => $c['characterName'], 'kind' => $baseOf($c)];
    }
    $members = array_map(function ($m) use ($baseOf, $blockedIDs, $grantedIDs, $directIDs) {
        $id = (int) $m['characterID'];
        return [
            'characterID' => $id, 'characterName' => $m['characterName'], 'corporationName' => $m['corporationName'],
            'blocked' => in_array($id, $blockedIDs, true), 'granted' => in_array($id, $grantedIDs, true),
            'protected' => $baseOf($m) !== null, 'direct' => in_array($id, $directIDs, true),
        ];
    }, $members);
    $out['owners'] = $owners;      // the owner and the owning corporation's admins (not editable)
    $out['granted'] = $granted;
    $out['blocked'] = $blocked;
    $out['members'] = $members;
    $out['truncated'] = $truncated;
    return $out;
}
