<?php
// Fork-owned: flares with a reason and a lifetime (changes/2026-11-15-flare-reason-life), ported from upstream
// Tripwire 2.0 (db-update.php diffs "flare reason", "flares - fix clean event", "flares - remove default lifetime";
// public/flares.php; app/js/dialogs/flare-dialog.js). Storage for public/flares.php and the flare list in
// public/refresh.php. Tests: flares/tests/flares_test.php.
//
// Schema: upstream's `flares` table gets two columns, `lifeLength` (seconds; NULL = until removed) and `reason`. A fresh
// install has them from .docker/mysql/tripwire.sql; an older database gets them from flares_ensure_schema() the first
// time a flare is set (public/flares.php; at most once per container, or per cooldown after a failure; no migration
// step), which also rewrites the flaresClean event so it deletes each flare when its own lifetime is over instead of
// after a fixed 24 hours. Until then the list (public/refresh.php) reads the old columns.

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
	$restart = ($in['restart'] ?? '') === '1';	// sent by the dialog: the user set the flare again, its lifetime starts again
	return [['systemID' => $systemID, 'flare' => $colour, 'lifeLength' => FLARES_LIFETIMES[$life], 'reason' => $reason === '' ? null : $reason,
		'restart' => $restart], null];
}

/**
 * Add the columns an older `flares` table lacks and make the flaresClean event use each flare's lifetime. Returns
 * ['columns' => bool, 'event' => bool, 'errors' => [messages]]; never throws for a missing privilege (ALTER for the
 * columns, EVENT for the event). Use flares_ensure_schema_once(), which runs this at most once per cooldown.
 * The event is changed with ALTER EVENT (atomic: no moment without it) when it exists, created only when it is missing.
 * Without the EVENT privilege flares still expire on time in the app (the list leaves expired ones out), but a flare set
 * to last until removed is deleted after 24 hours by the old event. docker/README.md#flares says what to run by hand.
 */
function flares_ensure_schema(PDO $db) {
	$out = ['columns' => true, 'event' => true, 'errors' => []];
	try {
		$have = array_flip(array_map('strtolower', $db->query('SHOW COLUMNS FROM flares')->fetchAll(PDO::FETCH_COLUMN)));
		foreach (FLARES_ADDED_COLUMNS as $column => $definition) {
			if (isset($have[strtolower($column)])) continue;
			try {
				$db->exec("ALTER TABLE flares ADD COLUMN `$column` $definition");
			} catch (PDOException $error) {
				if ($error->getCode() !== '42S21') throw $error;   // duplicate column: another request just added it
			}
		}
	} catch (PDOException $error) {
		$out['columns'] = false;
		$out['errors'][] = 'reason / lifetime columns: ' . $error->getMessage();
	}
	try {
		$stmt = $db->query("SELECT EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'flaresClean'");
		$definition = $stmt ? $stmt->fetchColumn() : false;
		if ($definition === false) {
			// missing (or not visible without the EVENT privilege: then this fails, and nothing was dropped)
			$db->exec('CREATE EVENT IF NOT EXISTS `flaresClean` ON SCHEDULE EVERY 1 HOUR STARTS CURRENT_TIMESTAMP ON COMPLETION NOT PRESERVE ENABLE DO ' . FLARES_CLEAN_SQL);
		} elseif (stripos((string) $definition, 'lifeLength') === false) {
			// in place; the app user becomes its definer, as for the events the schema import created
			$db->exec('ALTER EVENT `flaresClean` DO ' . FLARES_CLEAN_SQL);
		}
	} catch (PDOException $error) {
		$out['event'] = false;
		$out['errors'][] = 'flaresClean event: ' . $error->getMessage();
	}
	return $out;
}

const FLARES_SCHEMA_VERSION = 1;		// bump when flares_ensure_schema() has something new to do
const FLARES_SCHEMA_COOLDOWN = 3600;	// seconds before a failed attempt is tried again

function flares_schema_state_file() {
	return dirname(__DIR__) . '/cache/flares-schema.json';
}

/**
 * flares_ensure_schema() at most once: when the state file (in cache/, so once per container) says it is done, nothing is
 * queried; after a failure (no ALTER / EVENT privilege) it is tried again only after FLARES_SCHEMA_COOLDOWN, logged once
 * per attempt. $force: run it although the state says done (a query found a column missing: the database was
 * replaced), but still not within the cooldown of a failure. Returns whether the columns are there.
 */
function flares_ensure_schema_once(PDO $db, $force = false, $file = null, $now = null) {
	$file = $file ?: flares_schema_state_file();
	$now = $now ?? time();
	$state = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
	$state = is_array($state) && ($state['version'] ?? null) === FLARES_SCHEMA_VERSION ? $state : null;
	if ($state && !empty($state['columns']) && !empty($state['event']) && !$force) return true;
	if ($state && !empty($state['failedAt']) && $now - (int) $state['failedAt'] < FLARES_SCHEMA_COOLDOWN) return !empty($state['columns']) && !$force;
	$result = flares_ensure_schema($db);
	$ok = $result['columns'] && $result['event'];
	@file_put_contents($file, json_encode(['version' => FLARES_SCHEMA_VERSION, 'columns' => $result['columns'], 'event' => $result['event'],
		'failedAt' => $ok ? null : $now]), LOCK_EX);
	foreach ($result['errors'] as $message) {
		error_log('[flares] could not update the schema (see docker/README.md#flares), next try in ' . FLARES_SCHEMA_COOLDOWN . ' s: ' . $message);
	}
	return $result['columns'];
}

/**
 * The list for public/refresh.php, which every open page calls every few seconds. It never changes the schema (that is
 * public/flares.php's job when a flare is set): on a table without the added columns it reads the flares as upstream 1.x
 * did (1 day each, no reason).
 */
function flares_list_for_refresh(PDO $db, $mask) {
	try {
		return flares_list($db, $mask);
	} catch (PDOException $error) {
		if ($error->getCode() !== '42S22') throw $error;
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

/**
 * Set (or replace) a flare on the mask. $flare['restart'] (the dialog: the user set it again) starts its lifetime again;
 * a re-colour keeps the time it was set, unless that flare's lifetime was already over (then it is a new flare).
 * `time` is assigned first: ON DUPLICATE KEY UPDATE sees the old lifeLength only before it is replaced.
 */
function flares_set(PDO $db, $mask, array $flare) {
	$stmt = $db->prepare('INSERT INTO flares (maskID, systemID, flare, lifeLength, reason, `time`) VALUES (:mask, :systemID, :flare, :lifeLength, :reason, CURRENT_TIMESTAMP)
		ON DUPLICATE KEY UPDATE `time` = IF(:restart = 1 OR (lifeLength IS NOT NULL AND `time` < NOW() - INTERVAL lifeLength SECOND), CURRENT_TIMESTAMP, `time`),
		flare = VALUES(flare), lifeLength = VALUES(lifeLength), reason = VALUES(reason)');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $flare['systemID'], PDO::PARAM_INT);
	$stmt->bindValue(':flare', $flare['flare']);
	$stmt->bindValue(':lifeLength', $flare['lifeLength'], $flare['lifeLength'] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
	$stmt->bindValue(':reason', $flare['reason'], $flare['reason'] === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
	$stmt->bindValue(':restart', empty($flare['restart']) ? 0 : 1, PDO::PARAM_INT);
	return $stmt->execute();
}

/** flares_set() for public/flares.php: makes sure of the schema first (once), and again if a column turns out missing */
function flares_set_with_schema(PDO $db, $mask, array $flare) {
	flares_ensure_schema_once($db);
	try {
		return flares_set($db, $mask, $flare);
	} catch (PDOException $error) {
		if ($error->getCode() !== '42S22') throw $error;
		if (!flares_ensure_schema_once($db, true)) throw $error;
		return flares_set($db, $mask, $flare);
	}
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
