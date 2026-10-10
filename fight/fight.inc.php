<?php
// Fork-owned: "Fight here" (the chain map's rally point, renamed) with fleet comps (see docker/README.md#fight-here).
//
// A corporation's Tripwire admins keep a list of fleet comps per mask (the corp mask and corporation-owned custom masks,
// the same masks and admins as Mask Admin > Discord): a name, a colour from a fixed palette, an optional short note and
// an optional Discord mention. Every member of the mask reads the list (public/rally.php, without the mentions) and can
// pick a comp when they set the fight point (chain map right-click > Fight here > <comp>); public/fight.php is the
// admins' page (Mask Admin > Fight here).
//
// The fight point itself is still the rally point: one row per mask in fork_rally (public/rally.php). The chosen comp is
// stored with it as a copy (compID, compName, compColour, compNote, compMention), so a comp an admin removes or renames
// later keeps showing as it was on the fight until the fight is cleared or moved. The columns are added to fork_rally
// on first use (fight_rally_read), like the fork tables are created on first use; no migration.

require_once(__DIR__ . '/../discord/template.php');   // discord_ping_normalise: the mention field, as Mask Admin > Discord

const FIGHT_MAX_COMPS = 20;
const FIGHT_NAME_MAX = 40;
const FIGHT_NOTE_MAX = 140;

const FIGHT_DDL = [
    // Fleet comps per mask: a JSON list of {id, name, colour, note, mention}, in the admins' order (fight_normalise_comps).
    // One row per mask; admins change it in a transaction (SELECT ... FOR UPDATE).
    "CREATE TABLE IF NOT EXISTS `fork_fight_comps` (
      `maskID` decimal(12,1) NOT NULL,
      `comps` mediumtext NOT NULL,
      `updatedBy` varchar(100) NOT NULL DEFAULT '',
      `updatedAt` datetime NOT NULL,
      PRIMARY KEY (`maskID`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
];

/** The colours a comp can have: key => hex. Keys are what is stored; the browser has the same list (fightComps.PALETTE). */
function fight_palette() {
    return [
        'green' => '#39ff14', 'red' => '#ff4747', 'orange' => '#ff9f1a', 'yellow' => '#ffe14d', 'blue' => '#4da6ff',
        'purple' => '#b57cff', 'pink' => '#ff6ec7', 'cyan' => '#2ee6d6', 'white' => '#e6e6e6',
    ];
}

function fight_ensure_schema(PDO $db) {
    foreach (FIGHT_DDL as $ddl) $db->exec($ddl);
}

/** One line of user text: control characters and runs of spaces become one space, trimmed */
function fight_clean_text($text) {
    $text = preg_replace('/[\x00-\x1F\x7F\x{2028}\x{2029}]+/u', ' ', (string) $text);
    if ($text === null) return '';   // invalid UTF-8
    return trim(preg_replace('/\s+/u', ' ', $text));
}

function fight_new_id(array $used) {
    do { $id = 'c' . bin2hex(random_bytes(5)); } while (in_array($id, $used, true));
    return $id;
}

/**
 * Validate a comp an admin saves. $in: {id?, name, colour, note?, mention?}; $others: the mask's other comps (for
 * unique names). Returns [comp, errors]; a new comp (no or unknown id) gets a new id. Lengths count characters.
 */
function fight_validate_comp($in, array $others) {
    $in = is_array($in) ? $in : [];
    $errors = [];
    $name = fight_clean_text(is_string($in['name'] ?? null) ? $in['name'] : '');
    if ($name === '') $errors[] = 'Give the comp a name';
    elseif (mb_strlen($name) > FIGHT_NAME_MAX) $errors[] = 'The name can be at most ' . FIGHT_NAME_MAX . ' characters';
    foreach ($others as $other) {
        if ($name !== '' && mb_strtolower($other['name']) === mb_strtolower($name)) { $errors[] = 'There is already a comp called "' . $other['name'] . '"'; break; }
    }
    $colour = is_string($in['colour'] ?? null) ? $in['colour'] : '';
    if (!array_key_exists($colour, fight_palette())) $errors[] = 'Pick one of the colours';
    $note = fight_clean_text(is_string($in['note'] ?? null) ? $in['note'] : '');
    if (mb_strlen($note) > FIGHT_NOTE_MAX) $errors[] = 'The note can be at most ' . FIGHT_NOTE_MAX . ' characters';
    $mention = discord_ping_normalise(is_string($in['mention'] ?? null) ? $in['mention'] : '');
    if ($mention === null) { $errors[] = 'The Discord mention may only contain <@&roleID>, <@userID>, @here or @everyone'; $mention = ''; }
    $used = array_map(function ($c) { return $c['id']; }, $others);
    $id = is_string($in['id'] ?? null) && preg_match('/^c[0-9a-f]{10}$/', $in['id']) && !in_array($in['id'], $used, true) ? $in['id'] : fight_new_id($used);
    return [['id' => $id, 'name' => $name, 'colour' => $colour, 'note' => $note, 'mention' => $mention], $errors];
}

/** Stored comps, validated again (an invalid or duplicate entry is dropped), at most FIGHT_MAX_COMPS */
function fight_normalise_comps($list) {
    $out = [];
    foreach (is_array($list) ? $list : [] as $entry) {
        if (count($out) >= FIGHT_MAX_COMPS) break;
        if (!is_array($entry) || !is_string($entry['id'] ?? null) || !preg_match('/^c[0-9a-f]{10}$/', $entry['id'])) continue;
        [$comp, $errors] = fight_validate_comp($entry, $out);
        if ($errors || $comp['id'] !== $entry['id']) continue;
        $out[] = $comp;
    }
    return $out;
}

/** Comps for the browser: everyone gets id, name, colour, note; the mention only for the admins' page */
function fight_public_comps(array $comps, $withMention = false) {
    return array_map(function ($c) use ($withMention) {
        $out = ['id' => $c['id'], 'name' => $c['name'], 'colour' => $c['colour'], 'note' => $c['note']];
        if ($withMention) $out['mention'] = $c['mention'];
        return $out;
    }, array_values($comps));
}

/** $comps in the order of $ids (every id exactly once), or null when $ids isn't a permutation of the comps */
function fight_reorder(array $comps, $ids) {
    if (!is_array($ids) || count($ids) !== count($comps)) return null;
    $byID = [];
    foreach ($comps as $c) $byID[$c['id']] = $c;
    $out = [];
    foreach ($ids as $id) {
        if (!is_string($id) || !isset($byID[$id])) return null;
        $out[] = $byID[$id];
        unset($byID[$id]);
    }
    return $out;
}

function fight_find_comp(array $comps, $id) {
    foreach ($comps as $c) if ($c['id'] === $id) return $c;
    return null;
}

// ---- Storage ----

/** A mask's comps ([] when none, or the table doesn't exist yet) */
function fight_comps_load(PDO $db, $maskID, $forUpdate = false) {
    try {
        $stmt = $db->prepare('SELECT comps FROM fork_fight_comps WHERE maskID = ?' . ($forUpdate ? ' FOR UPDATE' : ''));
        $stmt->execute([(string) $maskID]);
        $json = $stmt->fetchColumn();
    } catch (PDOException $error) {
        if ($error->getCode() === '42S02' && !$forUpdate) return [];   // no table yet: no comps
        throw $error;
    }
    return $json === false || $json === null ? [] : fight_normalise_comps(json_decode($json, true));
}

function fight_comps_save(PDO $db, $maskID, array $comps, $by) {
    $stmt = $db->prepare('INSERT INTO fork_fight_comps (maskID, comps, updatedBy, updatedAt) VALUES (?, ?, ?, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE comps = VALUES(comps), updatedBy = VALUES(updatedBy), updatedAt = VALUES(updatedAt)');
    $stmt->execute([(string) $maskID, json_encode(array_values($comps)), mb_substr((string) $by, 0, 100)]);
}

// ---- The fight point (fork_rally) ----

/** fork_rally with the comp columns (new databases); older ones get them from fight_rally_add_columns */
function fight_rally_ensure_table(PDO $db) {
    $db->exec('CREATE TABLE IF NOT EXISTS fork_rally (
        maskID decimal(12,1) NOT NULL,
        systemID int NOT NULL,
        setBy varchar(100) DEFAULT NULL,
        setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        compID varchar(16) DEFAULT NULL,
        compName varchar(64) DEFAULT NULL,
        compColour varchar(16) DEFAULT NULL,
        compNote varchar(255) DEFAULT NULL,
        compMention varchar(320) DEFAULT NULL,
        PRIMARY KEY (maskID)
    ) DEFAULT CHARSET=utf8mb4');
}

/** Add the comp columns to a fork_rally from before Fight here (another request may just have done it: ignored) */
function fight_rally_add_columns(PDO $db) {
    try {
        $db->exec('ALTER TABLE fork_rally ADD COLUMN compID varchar(16) DEFAULT NULL, ADD COLUMN compName varchar(64) CHARACTER SET utf8mb4 DEFAULT NULL,
            ADD COLUMN compColour varchar(16) DEFAULT NULL, ADD COLUMN compNote varchar(255) CHARACTER SET utf8mb4 DEFAULT NULL,
            ADD COLUMN compMention varchar(320) DEFAULT NULL');
    } catch (PDOException $error) {
        if ($error->getCode() !== '42S21') throw $error;   // duplicate column: already there
    }
}

/** The comp stored with a fight point row: ['id', 'name', 'colour', 'note', 'mention'] or null */
function fight_row_comp(array $row) {
    $name = (string) ($row['compName'] ?? '');
    if ($name === '') return null;
    $colour = (string) ($row['compColour'] ?? '');
    return ['id' => (string) ($row['compID'] ?? ''), 'name' => $name,
        'colour' => array_key_exists($colour, fight_palette()) ? $colour : 'green',
        'note' => (string) ($row['compNote'] ?? ''), 'mention' => (string) ($row['compMention'] ?? '')];
}

/**
 * The fight point of a mask as stored: ['systemID', 'setBy', 'setAt', 'age' (seconds since it was set, null when
 * unknown), 'comp' (null or fight_row_comp)], or null when there is none (also with no fork_rally table at all, 42S02).
 * Reads every column (SELECT *), so a table from before Fight here (no comp columns) reads as "no comp"; the columns are
 * added when a fight point is stored (fight_rally_store). The age comes from the database's own clock (setAt and
 * CURRENT_TIMESTAMP are in the same time zone). Throws on other database errors.
 */
function fight_rally_read(PDO $db, $maskID) {
    try {
        $stmt = $db->prepare('SELECT *, CURRENT_TIMESTAMP AS dbNow FROM fork_rally WHERE maskID = ?');
        $stmt->execute([(string) $maskID]);
    } catch (PDOException $error) {
        if ($error->getCode() === '42S02') return null;   // no fork_rally yet: no fight point
        throw $error;
    }
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    $setAt = isset($row['setAt']) ? strtotime((string) $row['setAt']) : false;
    $now = isset($row['dbNow']) ? strtotime((string) $row['dbNow']) : false;
    return ['systemID' => (int) $row['systemID'], 'setBy' => $row['setBy'] ?? null, 'setAt' => $row['setAt'] ?? null,
        'age' => $setAt !== false && $now !== false ? max(0, $now - $setAt) : null, 'comp' => fight_row_comp($row)];
}

/** Whether setting the fight point to $systemID with $comp (null = none) changes what $previous (fight_rally_read) shows */
function fight_rally_changes($previous, $systemID, $comp) {
    if (!$previous || (int) $previous['systemID'] !== (int) $systemID) return true;
    $was = $previous['comp'] ?? null;
    if (!$comp || !$was) return (bool) $comp !== (bool) $was;
    foreach (['id', 'name', 'colour', 'note', 'mention'] as $field) {
        if ((string) $was[$field] !== (string) $comp[$field]) return true;
    }
    return false;
}

/** Store the fight point of a mask (MySQL): $comp (a comp of the mask, or null) is copied into the row. A table from
    before Fight here gets the comp columns first (unknown column, 42S22). */
function fight_rally_store(PDO $db, $maskID, $systemID, $setBy, $comp) {
    $sql = 'INSERT INTO fork_rally (maskID, systemID, setBy, setAt, compID, compName, compColour, compNote, compMention)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE systemID = VALUES(systemID), setBy = VALUES(setBy), setAt = CURRENT_TIMESTAMP, compID = VALUES(compID),
            compName = VALUES(compName), compColour = VALUES(compColour), compNote = VALUES(compNote), compMention = VALUES(compMention)';
    $values = [(string) $maskID, (int) $systemID, $setBy,
        $comp ? $comp['id'] : null, $comp ? $comp['name'] : null, $comp ? $comp['colour'] : null,
        $comp && $comp['note'] !== '' ? $comp['note'] : null, $comp && $comp['mention'] !== '' ? $comp['mention'] : null];
    try {
        $db->prepare($sql)->execute($values);
    } catch (PDOException $error) {
        if ($error->getCode() !== '42S22') throw $error;
        fight_rally_add_columns($db);
        $db->prepare($sql)->execute($values);
    }
}

/** The fight point for the browser: no mention (admin configuration) */
function fight_rally_public($rally) {
    if (!$rally) return null;
    $comp = $rally['comp'] ? ['id' => $rally['comp']['id'], 'name' => $rally['comp']['name'], 'colour' => $rally['comp']['colour'], 'note' => $rally['comp']['note']] : null;
    return ['systemID' => $rally['systemID'], 'setBy' => $rally['setBy'], 'setAt' => $rally['setAt'], 'age' => $rally['age'], 'comp' => $comp];
}
