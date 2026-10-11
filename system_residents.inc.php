<?php
//***********************************************************
//	File: 		system_residents.inc.php
//	Author: 	Tripwire fork
//
//	Purpose:	"Set residents": who lives in a system, set by hand and shared by everyone on a mask (Intel panel >
//				Threat & residents). Storage and validation for public/system_residents.php. One row per mask and
//				system in fork_system_residents (created on first use, so no migration is needed; reference DDL in
//				docker/sql/system-residents.sql).
//
//	Names and tickers are never taken from the browser: the browser sends corporation / alliance IDs (quick picks)
//	and names (free entry). Names are resolved with ESI's public POST /universe/ids. Each entity's name and ticker come
//	from what is already stored for the system, else the server's caches (zkill_names, filled from ESI by the zKillboard
//	worker, and the system's cached zKillboard top lists), else ESI's public GET /corporations/{id} or /alliances/{id}
//	(which also proves the ID is of that kind). ESI calls go through esi_request() (shared rate-limit pauses).
//
//	The pure functions and the ESI resolver (with a fake transport) are tested by tests/system_residents_test.php,
//	the storage against the dev database.
//***********************************************************

require_once(__DIR__ . '/esi/esi.inc.php');

if (!defined('SYSTEM_RESIDENTS_MAX')) define('SYSTEM_RESIDENTS_MAX', 10);
if (!defined('SYSTEM_RESIDENTS_NOTE_MAX')) define('SYSTEM_RESIDENTS_NOTE_MAX', 200);
if (!defined('SYSTEM_RESIDENTS_NAME_MAX')) define('SYSTEM_RESIDENTS_NAME_MAX', 50);	// EVE: corporations 50, alliances 50
if (!defined('SYSTEM_RESIDENTS_ESI')) define('SYSTEM_RESIDENTS_ESI', 'https://esi.evetech.net/');

/** Create fork_system_residents if it doesn't exist. Throws PDOException on failure, whatever the error mode. */
function system_residents_ensure_table($mysql) {
	$created = $mysql->exec('CREATE TABLE IF NOT EXISTS fork_system_residents (
		maskID decimal(12,1) NOT NULL,
		systemID int NOT NULL,
		entities text NOT NULL,
		note varchar(' . SYSTEM_RESIDENTS_NOTE_MAX . ') NOT NULL DEFAULT \'\',
		setBy varchar(100) DEFAULT NULL,
		setAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (maskID, systemID)
	) DEFAULT CHARSET=utf8mb4');
	if ($created === false) {
		throw new PDOException('Could not create fork_system_residents: ' . implode(' ', $mysql->errorInfo()));
	}
}

/** Valid solar system ID (k-space, wormholes, Abyssal/void excluded) from a request value, or false */
function system_residents_system_id($value) {
	if (is_int($value)) $value = (string)$value;
	if (!is_string($value) || !preg_match('/^3[0-2][0-9]{6}$/', $value)) return false;
	return (int)$value;
}

/** Valid EVE entity ID (positive, at most 10 digits) or false */
function system_residents_entity_id($value) {
	if (is_int($value)) return $value > 0 && $value <= 2147483647 ? $value : false;
	if (!is_string($value) || !preg_match('/^[1-9][0-9]{0,9}$/', $value)) return false;
	$id = filter_var($value, FILTER_VALIDATE_INT);
	return $id === false || $id > 2147483647 ? false : $id;
}

/** One line of plain text: control characters and whitespace runs become one space, trimmed, at most $max characters */
function system_residents_clean_text($text, $max) {
	if (!is_string($text)) return '';
	if (!mb_check_encoding($text, 'UTF-8')) $text = mb_convert_encoding($text, 'UTF-8', 'UTF-8');
	$text = preg_replace('/\p{Cf}+/u', '', $text);
	if ($text === null) return '';
	$text = preg_replace('/[\p{Cc}\p{Z}\s]+/u', ' ', $text);
	if ($text === null) return '';
	return mb_substr(trim($text), 0, $max, 'UTF-8');
}

/**
 * The browser's picks: JSON [{kind, id}] -> list of ['kind' => 'corporation'|'alliance', 'id' => int], each once, in
 * order; or an error text. Anything else in an entry (names, tickers) is ignored.
 */
function system_residents_parse_picks($json) {
	if ($json === null || $json === '') return array();
	$list = is_string($json) && strlen($json) <= 4000 ? json_decode($json, true) : null;
	if (!is_array($list) || array_values($list) !== $list) return 'entities must be a JSON list';
	$out = array();
	$seen = array();
	foreach ($list as $entry) {
		if (!is_array($entry)) return 'Invalid entity';
		$kind = isset($entry['kind']) ? $entry['kind'] : null;
		$id = isset($entry['id']) ? system_residents_entity_id($entry['id']) : false;
		if (($kind !== 'corporation' && $kind !== 'alliance') || $id === false) return 'Invalid entity';
		if (isset($seen[$kind . ':' . $id])) continue;
		$seen[$kind . ':' . $id] = true;
		$out[] = array('kind' => $kind, 'id' => $id);
	}
	return $out;
}

/** The browser's free-entry names: JSON [string] -> cleaned, non-empty, each once (case-insensitive); or an error text */
function system_residents_parse_names($json) {
	if ($json === null || $json === '') return array();
	$list = is_string($json) && strlen($json) <= 4000 ? json_decode($json, true) : null;
	if (!is_array($list) || array_values($list) !== $list) return 'names must be a JSON list';
	$out = array();
	$seen = array();
	foreach ($list as $name) {
		if (!is_string($name)) return 'Invalid name';
		$clean = system_residents_clean_text($name, 100);
		if ($clean === '') continue;
		if (mb_strlen($clean, 'UTF-8') > SYSTEM_RESIDENTS_NAME_MAX) return 'Name too long: ' . mb_substr($clean, 0, 60, 'UTF-8');
		$key = mb_strtolower($clean, 'UTF-8');
		if (isset($seen[$key])) continue;
		$seen[$key] = true;
		$out[] = $clean;
	}
	return $out;
}

/** Ticker as ESI gives it (letters, digits, space, . _ -; at most 5), else '' */
function system_residents_clean_ticker($ticker) {
	return is_string($ticker) && preg_match('/^[A-Za-z0-9 ._\-]{1,5}$/', $ticker) ? $ticker : '';
}

/**
 * Names -> IDs with POST /universe/ids. @return array ['found' => [['kind', 'id', 'name'], ...] (corporations and
 * alliances only), 'unknown' => [names ESI doesn't know as a corporation or alliance], 'error' => text|null]
 */
function system_residents_resolve_names(array $names) {
	$result = array('found' => array(), 'unknown' => array(), 'error' => null);
	if (!$names) return $result;
	[$status, $body] = esi_request('POST', SYSTEM_RESIDENTS_ESI . 'universe/ids/', array('Accept: application/json', 'Content-Type: application/json'),
		json_encode(array_values($names)), 15);
	if ($status !== 200) {
		$result['error'] = $status === -1 ? (string)$body : 'ESI could not look up the names (' . ($status ? 'HTTP ' . $status : 'no answer') . ')';
		return $result;
	}
	$data = json_decode((string)$body, true);
	if (!is_array($data)) { $result['error'] = 'ESI answered with an unexpected body'; return $result; }
	$byName = array();
	foreach (array('corporations' => 'corporation', 'alliances' => 'alliance') as $key => $kind) {
		foreach (isset($data[$key]) && is_array($data[$key]) ? $data[$key] : array() as $row) {
			$id = is_array($row) && isset($row['id']) ? system_residents_entity_id($row['id']) : false;
			$name = is_array($row) && isset($row['name']) && is_string($row['name']) ? $row['name'] : '';
			if ($id === false || $name === '') continue;
			$k = mb_strtolower($name, 'UTF-8');
			if (!isset($byName[$k])) $byName[$k] = array();
			$byName[$k][] = array('kind' => $kind, 'id' => $id, 'name' => $name);
		}
	}
	foreach ($names as $name) {
		$k = mb_strtolower($name, 'UTF-8');
		if (empty($byName[$k])) { $result['unknown'][] = $name; continue; }
		foreach ($byName[$k] as $entity) $result['found'][] = $entity;	// a corporation and an alliance may share a name
	}
	return $result;
}

/** Name and ticker of one corporation / alliance from ESI. @return ['name', 'ticker'] or null (unknown, or the ID is of another kind), or a string error */
function system_residents_fetch_entity($kind, $id) {
	$url = SYSTEM_RESIDENTS_ESI . ($kind === 'alliance' ? 'alliances/' : 'corporations/') . (int)$id . '/';
	[$status, $body] = esi_request('GET', $url, array('Accept: application/json'), null, 10);
	if ($status === 404 || $status === 400) return null;
	if ($status !== 200) return $status === -1 ? (string)$body : 'ESI could not look up ' . $kind . ' ' . (int)$id . ' (' . ($status ? 'HTTP ' . $status : 'no answer') . ')';
	$data = json_decode((string)$body, true);
	if (!is_array($data) || !isset($data['name']) || !is_string($data['name']) || $data['name'] === '') return 'ESI answered with an unexpected body';
	return array('name' => system_residents_clean_text($data['name'], 100), 'ticker' => system_residents_clean_ticker(isset($data['ticker']) ? $data['ticker'] : ''));
}

/**
 * Entities to store: picks plus resolved names, each once, at most SYSTEM_RESIDENTS_MAX, with name and ticker from
 * $known (the entities stored so far, keyed "kind:id"), else the server's own caches ($local: callable(entities) =>
 * ["kind:id" => ['name', 'ticker']], names whose ESI category matched the kind), else ESI. When ESI can't be asked,
 * a cached name is enough (ticker '').
 * @return array ['entities' => [...], 'unknown' => [names], 'error' => text|null]
 */
function system_residents_resolve(array $picks, array $names, array $known = array(), ?callable $local = null) {
	$out = array('entities' => array(), 'unknown' => array(), 'error' => null);
	$resolved = system_residents_resolve_names($names);
	if ($resolved['error']) { $out['error'] = $resolved['error']; return $out; }
	$out['unknown'] = $resolved['unknown'];
	if ($out['unknown']) return $out;
	$wanted = array();
	foreach (array_merge($picks, $resolved['found']) as $e) {
		$key = $e['kind'] . ':' . $e['id'];
		if (!isset($wanted[$key])) $wanted[$key] = $e;
	}
	if (count($wanted) > SYSTEM_RESIDENTS_MAX) { $out['error'] = 'At most ' . SYSTEM_RESIDENTS_MAX . ' corporations and alliances'; return $out; }
	$cached = $local ? $local(array_values($wanted)) : array();
	foreach ($wanted as $key => $e) {
		if (isset($known[$key])) { $out['entities'][] = $known[$key]; continue; }
		$have = isset($cached[$key]) && is_array($cached[$key]) ? $cached[$key] : array('name' => '', 'ticker' => '');
		$name = system_residents_clean_text(isset($have['name']) ? $have['name'] : '', 100);
		$ticker = system_residents_clean_ticker(isset($have['ticker']) ? $have['ticker'] : '');
		if ($name === '' && isset($e['name'])) $name = system_residents_clean_text($e['name'], 100);	// as /universe/ids spelled it
		if ($name === '' || $ticker === '') {
			$info = system_residents_fetch_entity($e['kind'], $e['id']);
			if (is_array($info)) {
				$name = $info['name'];
				$ticker = $info['ticker'];
			} else if ($name === '') {
				$out['error'] = is_string($info) ? $info : 'Unknown ' . $e['kind'] . ' ' . $e['id'];
				return $out;
			}
		}
		$out['entities'][] = array('kind' => $e['kind'], 'id' => (int)$e['id'], 'name' => $name, 'ticker' => $ticker);
	}
	return $out;
}

/**
 * Names and tickers the server already has, for system_residents_resolve(): names from the ESI name cache
 * (zkill_names, only when its category matches the kind), tickers from the system's cached zKillboard top lists
 * (zkill_system_stats). Missing tables or rows just give nothing.
 * @return array ["kind:id" => ['name', 'ticker']]
 */
function system_residents_local_info($mysql, $systemID, array $entities) {
	$out = array();
	if (!$entities) return $out;
	$ids = array();
	foreach ($entities as $e) $ids[(int)$e['id']] = $e['kind'];
	try {
		$stmt = $mysql->prepare('SELECT id, name, category FROM zkill_names WHERE id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')');
		if ($stmt && $stmt->execute(array_keys($ids))) {
			while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
				$id = (int)$row['id'];
				if (isset($ids[$id]) && $row['category'] === $ids[$id] && is_string($row['name']) && $row['name'] !== '') {
					$out[$ids[$id] . ':' . $id] = array('name' => $row['name'], 'ticker' => '');
				}
			}
		}
		$stmt = $mysql->prepare('SELECT data FROM zkill_system_stats WHERE systemID = ?');
		$data = $stmt && $stmt->execute(array((int)$systemID)) ? json_decode((string)$stmt->fetchColumn(), true) : null;
		foreach (array('corporations' => 'corporation', 'alliances' => 'alliance') as $list => $kind) {
			foreach (is_array($data) && isset($data[$list]) && is_array($data[$list]) ? $data[$list] : array() as $t) {
				$key = $kind . ':' . (int)(isset($t['id']) ? $t['id'] : 0);
				if (!isset($ids[(int)(isset($t['id']) ? $t['id'] : 0)]) || $ids[(int)$t['id']] !== $kind) continue;
				if (!isset($out[$key])) $out[$key] = array('name' => '', 'ticker' => '');
				$out[$key]['ticker'] = isset($t['ticker']) ? (string)$t['ticker'] : '';
			}
		}
	} catch (Throwable $e) {
		// zKillboard tables not there (yet): ESI answers instead
	}
	return $out;
}

/** Entities as stored (JSON) -> validated list (drops anything malformed) */
function system_residents_decode_entities($json) {
	$list = is_string($json) ? json_decode($json, true) : null;
	$out = array();
	foreach (is_array($list) ? $list : array() as $e) {
		if (!is_array($e) || !isset($e['kind'], $e['id']) || ($e['kind'] !== 'corporation' && $e['kind'] !== 'alliance')) continue;
		$id = system_residents_entity_id($e['id']);
		if ($id === false) continue;
		$out[] = array('kind' => $e['kind'], 'id' => $id,
			'name' => system_residents_clean_text(isset($e['name']) ? $e['name'] : '', 100),
			'ticker' => system_residents_clean_ticker(isset($e['ticker']) ? $e['ticker'] : ''));
	}
	return $out;
}

/** The mask's residents of a system: ['systemID', 'entities', 'note', 'setBy', 'setAt' (unix seconds)] or null */
function system_residents_get($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare('SELECT systemID, entities, note, setBy, UNIX_TIMESTAMP(setAt) AS setAt FROM fork_system_residents
		WHERE maskID = :mask AND systemID = :systemID');
	if (!$stmt) throw new PDOException('Could not read fork_system_residents');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not read fork_system_residents: ' . implode(' ', $stmt->errorInfo()));
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	if (!$row) return null;
	return array(
		'systemID' => (int)$row['systemID'],
		'entities' => system_residents_decode_entities($row['entities']),
		'note' => (string)$row['note'],
		'setBy' => $row['setBy'],
		'setAt' => (int)$row['setAt']
	);
}

/** Store the residents (replaces what was set) */
function system_residents_set($mysql, $mask, $systemID, array $entities, $note, $setBy) {
	$stmt = $mysql->prepare('INSERT INTO fork_system_residents (maskID, systemID, entities, note, setBy, setAt)
		VALUES (:mask, :systemID, :entities, :note, :setBy, CURRENT_TIMESTAMP)
		ON DUPLICATE KEY UPDATE entities = VALUES(entities), note = VALUES(note), setBy = VALUES(setBy), setAt = CURRENT_TIMESTAMP');
	if (!$stmt) throw new PDOException('Could not prepare system residents set');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	$stmt->bindValue(':entities', json_encode(array_values(array_slice($entities, 0, SYSTEM_RESIDENTS_MAX))));
	$stmt->bindValue(':note', system_residents_clean_text($note, SYSTEM_RESIDENTS_NOTE_MAX));
	$stmt->bindValue(':setBy', $setBy === null ? null : mb_substr((string)$setBy, 0, 100, 'UTF-8'));
	if (!$stmt->execute()) throw new PDOException('Could not set system residents: ' . implode(' ', $stmt->errorInfo()));
}

/** Remove the residents (no error when there are none) */
function system_residents_clear($mysql, $mask, $systemID) {
	$stmt = $mysql->prepare('DELETE FROM fork_system_residents WHERE maskID = :mask AND systemID = :systemID');
	if (!$stmt) throw new PDOException('Could not prepare system residents clear');
	$stmt->bindValue(':mask', $mask);
	$stmt->bindValue(':systemID', $systemID, PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not clear system residents: ' . implode(' ', $stmt->errorInfo()));
}
