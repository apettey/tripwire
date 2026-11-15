<?php
// Fork-owned: flares with a reason and a lifetime (changes/2026-11-15-flare-reason-life), ported from upstream
// Tripwire 2.0 (db-update.php diffs "flare reason", "flares - fix clean event", "flares - remove default lifetime";
// public/flares.php; app/js/dialogs/flare-dialog.js). Storage for public/flares.php and the flare list in
// public/refresh.php. Tests: flares/tests/flares_test.php.
//
// Schema: upstream's `flares` table gets two columns, `lifeLength` (seconds; NULL = until removed) and `reason`. A fresh
// install has them from .docker/mysql/tripwire.sql; an older database gets them from flares_ensure_schema() the first
// time a flare is set or the list is read (no migration step), which also rewrites the flaresClean event so it deletes
// each flare when its own lifetime is over instead of after a fixed 24 hours.

const FLARES_COLOURS = ['red', 'yellow', 'green'];
const FLARES_REASON_MAX = 200;			// characters, after cleaning (the column is varchar(255))
const FLARES_DAY = 86400;
// Lifetimes a client may ask for: request value => stored lifeLength (NULL = until removed). A missing value is one day,
// so a client that knows nothing of lifetimes (an older page during a deploy) keeps upstream's 24 hours.
const FLARES_LIFETIMES = ['86400' => FLARES_DAY, 'forever' => null];

// The columns added to upstream's table, name => definition. DEFAULT 86400: rows from before keep their 24 hours.
const FLARES_ADDED_COLUMNS = [
	'lifeLength' => 'int NULL DEFAULT 86400',
	'reason'     => 'varchar(255) CHARACTER SET utf8mb4 NULL DEFAULT NULL',
];

// The flaresClean event body: a flare goes when its own lifetime is over; NULL lives until someone removes it.
const FLARES_CLEAN_SQL = 'DELETE FROM flares WHERE lifeLength IS NOT NULL AND `time` < NOW() - INTERVAL lifeLength SECOND';

/** Reason as stored: control characters and runs of whitespace become one space, zero-width / direction marks go, trimmed.
	Not HTML-escaped: it is stored as text and escaped where it is shown. Not a string: ''. */
function flares_clean_reason($text) {
	if (!is_string($text)) return '';
	if (!mb_check_encoding($text, 'UTF-8')) $text = mb_convert_encoding($text, 'UTF-8', 'UTF-8');
	$text = preg_replace('/\p{Cf}+/u', '', $text);
	if ($text === null) return '';
	$text = preg_replace('/[\p{Cc}\p{Z}\s]+/u', ' ', $text);
	if ($text === null) return '';
	return trim($text);
}

/** Valid system ID from a request value (positive int), or false */
function flares_system_id($value) {
	if (is_int($value)) return $value > 0 && $value <= 2147483647 ? $value : false;
	if (!is_string($value) || !preg_match('/^[1-9][0-9]{0,9}$/', $value)) return false;
	$id = filter_var($value, FILTER_VALIDATE_INT);
	return $id === false || $id > 2147483647 ? false : $id;
}

/**
 * Read a set request ($_POST-like: systemID, flare, lifeLength?, reason?). Returns [flare, null] with flare =
 * {systemID, flare, lifeLength (int or null), reason (string or null)}, or [null, error message].
 */
function flares_parse_set(array $in) {
	$systemID = flares_system_id($in['systemID'] ?? null);
	if ($systemID === false) return [null, 'Invalid system'];
	$colour = $in['flare'] ?? null;
	if (!is_string($colour) || !in_array($colour, FLARES_COLOURS, true)) return [null, 'Invalid flare colour'];
	$life = $in['lifeLength'] ?? null;
	if ($life === null || $life === '') $life = (string) FLARES_DAY;
	if (!is_string($life) && !is_int($life)) return [null, 'Invalid flare lifetime'];
	$life = (string) $life;
	if (!array_key_exists($life, FLARES_LIFETIMES)) return [null, 'Invalid flare lifetime'];
	$reason = flares_clean_reason($in['reason'] ?? '');
	if (mb_strlen($reason, 'UTF-8') > FLARES_REASON_MAX) return [null, 'The reason can be at most ' . FLARES_REASON_MAX . ' characters'];
	return [['systemID' => $systemID, 'flare' => $colour, 'lifeLength' => FLARES_LIFETIMES[$life], 'reason' => $reason === '' ? null : $reason], null];
}

/**
 * Add the columns an older `flares` table lacks and make the flaresClean event use each flare's lifetime. Cheap when
 * nothing is missing (SHOW COLUMNS + one information_schema read). The event needs the EVENT privilege on the database
 * (the app user has it: it imported the schema, events included); without it the error is logged and flares still
 * expire on time for everyone, because the flare list leaves expired ones out (flares_list), but a flare set to last
 * until removed would be deleted after 24 hours by the old event. docker/README.md#flares says what to run by hand.
 */
function flares_ensure_schema(PDO $db) {
	$have = array_flip(array_map('strtolower', $db->query('SHOW COLUMNS FROM flares')->fetchAll(PDO::FETCH_COLUMN)));
	foreach (FLARES_ADDED_COLUMNS as $column => $definition) {
		if (isset($have[strtolower($column)])) continue;
		try {
			$db->exec("ALTER TABLE flares ADD COLUMN `$column` $definition");
		} catch (PDOException $error) {
			if ($error->getCode() !== '42S21') throw $error;   // duplicate column: another request just added it
		}
	}
	try {
		$stmt = $db->query("SELECT EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'flaresClean'");
		$definition = $stmt ? $stmt->fetchColumn() : false;
		if ($definition === false || stripos((string) $definition, 'lifeLength') === false) {
			// DROP + CREATE (not ALTER): it may be missing; the app user becomes its definer, as for the imported events
			$db->exec('DROP EVENT IF EXISTS `flaresClean`');
			$db->exec('CREATE EVENT `flaresClean` ON SCHEDULE EVERY 1 HOUR STARTS CURRENT_TIMESTAMP ON COMPLETION NOT PRESERVE ENABLE DO ' . FLARES_CLEAN_SQL);
		}
	} catch (PDOException $error) {
		error_log('[flares] could not update the flaresClean event (see docker/README.md#flares): ' . $error->getMessage());
	}
}

/** Run $fn($db); if a column added since (42S22) is missing, add it and run it once more */
function flares_with_schema(PDO $db, callable $fn) {
	try {
		return $fn($db);
	} catch (PDOException $error) {
		if ($error->getCode() !== '42S22') throw $error;
		flares_ensure_schema($db);
		return $fn($db);
	}
}

/**
 * The list for public/refresh.php, which every open page calls every few seconds: never fails because of the schema. When
 * the columns are missing and cannot be added (no ALTER privilege), it logs that and reads the flares as upstream 1.x
 * did (1 day each, no reason).
 */
function flares_list_for_refresh(PDO $db, $mask) {
	try {
		return flares_with_schema($db, function($db) use ($mask) { return flares_list($db, $mask); });
	} catch (PDOException $error) {
		if ($error->getCode() !== '42S22' && $error->getCode() !== '42000') throw $error;
		error_log('[flares] reason / lifetime columns missing and could not be added (see docker/README.md#flares): ' . $error->getMessage());
		return flares_list_legacy($db, $mask);
	}
}

/** The list from a table without the added columns (upstream 1.x): 1 day each, no reason, same fields as flares_list */
function flares_list_legacy(PDO $db, $mask) {
	$stmt = $db->prepare('SELECT systemID, flare, `time`, UNIX_TIMESTAMP(`time`) AS setAt FROM flares
		WHERE maskID = :mask AND `time` >= NOW() - INTERVAL 1 DAY ORDER BY `time` DESC');
	$stmt->bindValue(':mask', $mask);
	$stmt->execute();
	$rows = $stmt->fetchAll(PDO::FETCH_OBJ);
	foreach ($rows as $row) {
		$row->systemID = (int) $row->systemID;
		$row->lifeLength = FLARES_DAY;
		$row->reason = null;
		$row->setAt = (int) $row->setAt;
	}
	return $rows;
}

/** Set (or replace) a flare on the mask. Setting it again starts its lifetime again. */
function flares_set(PDO $db, $mask, array $flare) {
	$stmt = $db->prepare('INSERT INTO flares (maskID, systemID, flare, lifeLength, reason, `time`) VALUES (:mask, :systemID, :flare, :lifeLength, :reason, CURRENT_TIMESTAMP)
		ON DUPLICATE KEY UPDATE flare = VALUES(flare), lifeLength = VALUES(lifeLength), reason = VALUES(reason), `time` = CURRENT_TIMESTAMP');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $flare['systemID'], PDO::PARAM_INT);
	$stmt->bindValue(':flare', $flare['flare']);
	$stmt->bindValue(':lifeLength', $flare['lifeLength'], $flare['lifeLength'] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
	$stmt->bindValue(':reason', $flare['reason'], $flare['reason'] === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
	return $stmt->execute();
}

function flares_remove(PDO $db, $mask, $systemID) {
	$stmt = $db->prepare('DELETE FROM flares WHERE maskID = :mask AND systemID = :systemID');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	return $stmt->execute();
}

/**
 * The mask's flares that are still alive, newest first: objects {systemID, flare, time, lifeLength (int or null), reason
 * (string or null), setAt (unix seconds)}. An expired flare is left out even before the hourly event deletes it.
 */
function flares_list(PDO $db, $mask) {
	$stmt = $db->prepare('SELECT systemID, flare, `time`, lifeLength, reason, UNIX_TIMESTAMP(`time`) AS setAt FROM flares
		WHERE maskID = :mask AND (lifeLength IS NULL OR `time` >= NOW() - INTERVAL lifeLength SECOND) ORDER BY `time` DESC');
	$stmt->bindValue(':mask', $mask);
	$stmt->execute();
	$rows = $stmt->fetchAll(PDO::FETCH_OBJ);
	foreach ($rows as $row) {
		$row->systemID = (int) $row->systemID;
		$row->lifeLength = $row->lifeLength === null ? null : (int) $row->lifeLength;
		$row->setAt = (int) $row->setAt;
	}
	return $rows;
}
