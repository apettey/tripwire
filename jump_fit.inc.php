<?php
//***********************************************************
//	File: 		jump_fit.inc.php
//	Author: 	Tripwire fork (auto-mass-logging)
//
//	Purpose:	Fitted mass and hot/cold of logged wormhole jumps.
//				Upstream logs each tracked jump through a mapped hole in `jumps` (trigger jumpHistory on
//				`tracking`) with only the hull type and the chain map's hot/Higgs toggles. The tracking
//				character's browser reports the ship's fitted mass (from ESI assets) for that jump to
//				public/jump_fit.php, stored here in fork_jump_fits next to the upstream row
//				(key: maskID, wormholeID, characterID, jump time). public/mass.php adds it to the jump log.
//	The table is created on first use, so existing databases need no migration.
//***********************************************************

const JUMP_FIT_DDL = 'CREATE TABLE IF NOT EXISTS fork_jump_fits (
	maskID decimal(12,1) NOT NULL,
	wormholeID int NOT NULL,
	characterID int NOT NULL,
	jumpTime timestamp NOT NULL,
	shipTypeID int DEFAULT NULL,
	fitSource enum(\'assets\',\'hull\') NOT NULL DEFAULT \'hull\',
	baseMass bigint DEFAULT NULL,
	propTypeID int DEFAULT NULL,
	propMass bigint DEFAULT NULL,
	higgsMult decimal(5,2) DEFAULT NULL,
	fitTime datetime DEFAULT NULL,
	hot tinyint(1) DEFAULT NULL,
	updated timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	PRIMARY KEY (maskID, wormholeID, characterID, jumpTime),
	KEY jumpTime (jumpTime)
)';

// How long after the upstream jump row a report may still attach to it, and how long fits are kept (holes live <= 48 h)
const JUMP_FIT_MATCH_MINUTES = 10;
const JUMP_FIT_KEEP_DAYS = 3;

function jump_fit_ensure_table($mysql) {
	static $done = false;
	if ($done) return;
	if ($mysql->exec(JUMP_FIT_DDL) === false) {
		throw new PDOException('Could not create fork_jump_fits: ' . implode(' ', $mysql->errorInfo()));
	}
	$done = true;
}

function jump_fit_int($value, $min, $max) {
	if ($value === null || $value === '' || is_array($value)) return null;
	$v = filter_var($value, FILTER_VALIDATE_INT);
	if ($v === false || $v < $min || $v > $max) return null;
	return $v;
}

/**
 * Validate a jump report (POST mode=report). Pure: no database.
 * @return array [errorMessage|null, cleaned values]
 */
function jump_fit_clean_report(array $in, $now = null) {
	$now = $now === null ? time() : $now;
	$r = array();
	$r['characterID'] = jump_fit_int(isset($in['characterID']) ? $in['characterID'] : null, 1, 2147483647);
	$r['fromID'] = jump_fit_int(isset($in['fromID']) ? $in['fromID'] : null, 30000000, 32999999);
	$r['toID'] = jump_fit_int(isset($in['toID']) ? $in['toID'] : null, 30000000, 32999999);
	if ($r['characterID'] === null || $r['fromID'] === null || $r['toID'] === null || $r['fromID'] === $r['toID']) {
		return array('Invalid character or systems', null);
	}
	$r['shipTypeID'] = jump_fit_int(isset($in['shipTypeID']) ? $in['shipTypeID'] : null, 1, 2147483647);
	$r['hot'] = isset($in['hot']) && ($in['hot'] === '1' || $in['hot'] === 1 || $in['hot'] === 'true') ? 1 : 0;
	$source = isset($in['fitSource']) ? $in['fitSource'] : 'hull';
	if ($source !== 'assets' && $source !== 'hull') return array('Invalid fitSource', null);
	$r['fitSource'] = $source;
	$r['baseMass'] = $r['propTypeID'] = $r['propMass'] = $r['higgsMult'] = $r['fitTime'] = null;
	if ($source === 'assets') {
		// The heaviest thing that jumps (a titan with plates) is about 2,500,000 t; prop modules add at most 500,000 t
		$r['baseMass'] = jump_fit_int(isset($in['baseMass']) ? $in['baseMass'] : null, 1, 5000000000);
		$r['propMass'] = jump_fit_int(isset($in['propMass']) ? $in['propMass'] : 0, 0, 1000000000);
		$r['propTypeID'] = jump_fit_int(isset($in['propTypeID']) ? $in['propTypeID'] : null, 1, 2147483647);
		$mult = isset($in['higgsMult']) && is_numeric($in['higgsMult']) ? (float)$in['higgsMult'] : 1.0;
		$r['higgsMult'] = ($mult >= 1 && $mult <= 4) ? round($mult, 2) : null;
		$fitTime = jump_fit_int(isset($in['fitTime']) ? $in['fitTime'] : null, $now - 7 * 86400, $now + 3600);
		$r['fitTime'] = $fitTime;
		if ($r['baseMass'] === null || $r['propMass'] === null || $r['higgsMult'] === null) {
			return array('Invalid fit mass', null);
		}
	}
	return array(null, $r);
}

/** Validate a hot/cold change (POST mode=hot). Pure. @return array [errorMessage|null, cleaned values] */
function jump_fit_clean_hot(array $in) {
	$r = array();
	$r['wormholeID'] = jump_fit_int(isset($in['wormholeID']) ? $in['wormholeID'] : null, 1, 2147483647);
	$r['characterID'] = jump_fit_int(isset($in['characterID']) ? $in['characterID'] : null, 1, 2147483647);
	$time = isset($in['time']) && is_string($in['time']) ? $in['time'] : '';
	if (!preg_match('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/', $time)) $time = null;
	$r['time'] = $time;
	$hot = isset($in['hot']) ? (string)$in['hot'] : '';
	$r['hot'] = $hot === '1' ? 1 : ($hot === '0' ? 0 : null);
	if ($r['wormholeID'] === null || $r['characterID'] === null || $r['time'] === null || $r['hot'] === null) {
		return array('Invalid jump', null);
	}
	return array(null, $r);
}

/** Whether the character is one of this user's ESI (tracking) characters */
function jump_fit_owns_character($mysql, $userID, $characterID) {
	$stmt = $mysql->prepare('SELECT 1 FROM esi WHERE userID = :userID AND characterID = :characterID');
	$stmt->bindValue(':userID', $userID);
	$stmt->bindValue(':characterID', $characterID, PDO::PARAM_INT);
	$stmt->execute();
	return (bool)$stmt->fetchColumn();
}

/**
 * Attach a report to the character's latest upstream jump row between the two systems in this mask.
 * @return array|null ['wormholeID' => int, 'time' => 'Y-m-d H:i:s'] or null when no such jump was logged (yet)
 */
function jump_fit_report($mysql, $maskID, array $r) {
	jump_fit_ensure_table($mysql);
	$stmt = $mysql->prepare('SELECT wormholeID, time FROM jumps
		WHERE maskID = :maskID AND characterID = :characterID AND fromID = :fromID AND toID = :toID
		AND time >= NOW() - INTERVAL ' . JUMP_FIT_MATCH_MINUTES . ' MINUTE ORDER BY time DESC LIMIT 1');
	$stmt->bindValue(':maskID', $maskID);
	$stmt->bindValue(':characterID', $r['characterID'], PDO::PARAM_INT);
	$stmt->bindValue(':fromID', $r['fromID'], PDO::PARAM_INT);
	$stmt->bindValue(':toID', $r['toID'], PDO::PARAM_INT);
	$stmt->execute();
	$jump = $stmt->fetch(PDO::FETCH_ASSOC);
	if (!$jump) return null;

	// A repeated report updates the fit but keeps a hot/cold the pilot already chose
	$stmt = $mysql->prepare('INSERT INTO fork_jump_fits (maskID, wormholeID, characterID, jumpTime, shipTypeID, fitSource, baseMass, propTypeID, propMass, higgsMult, fitTime, hot)
		VALUES (:maskID, :wormholeID, :characterID, :jumpTime, :shipTypeID, :fitSource, :baseMass, :propTypeID, :propMass, :higgsMult, FROM_UNIXTIME(:fitTime), :hot)
		ON DUPLICATE KEY UPDATE shipTypeID = VALUES(shipTypeID), fitSource = VALUES(fitSource), baseMass = VALUES(baseMass),
		propTypeID = VALUES(propTypeID), propMass = VALUES(propMass), higgsMult = VALUES(higgsMult), fitTime = VALUES(fitTime),
		hot = IFNULL(hot, VALUES(hot))');
	$stmt->bindValue(':maskID', $maskID);
	$stmt->bindValue(':wormholeID', $jump['wormholeID'], PDO::PARAM_INT);
	$stmt->bindValue(':characterID', $r['characterID'], PDO::PARAM_INT);
	$stmt->bindValue(':jumpTime', $jump['time']);
	foreach (array('shipTypeID', 'baseMass', 'propTypeID', 'propMass') as $k) {
		$stmt->bindValue(':' . $k, $r[$k], $r[$k] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
	}
	$stmt->bindValue(':fitSource', $r['fitSource']);
	$stmt->bindValue(':higgsMult', $r['higgsMult'] === null ? null : (string)$r['higgsMult'], $r['higgsMult'] === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
	$stmt->bindValue(':fitTime', $r['fitTime'], $r['fitTime'] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
	$stmt->bindValue(':hot', $r['hot'], PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not save the jump fit: ' . implode(' ', $stmt->errorInfo()));

	$mysql->exec('DELETE FROM fork_jump_fits WHERE jumpTime < NOW() - INTERVAL ' . JUMP_FIT_KEEP_DAYS . ' DAY');
	return array('wormholeID' => (int)$jump['wormholeID'], 'time' => $jump['time']);
}

/** Set hot/cold of a logged jump in this mask (any mask member may correct it). @return bool false if no such jump */
function jump_fit_set_hot($mysql, $maskID, array $r) {
	jump_fit_ensure_table($mysql);
	$stmt = $mysql->prepare('SELECT wormholeID, characterID, time, shipTypeID FROM jumps
		WHERE maskID = :maskID AND wormholeID = :wormholeID AND characterID = :characterID AND time = :time LIMIT 1');
	$stmt->bindValue(':maskID', $maskID);
	$stmt->bindValue(':wormholeID', $r['wormholeID'], PDO::PARAM_INT);
	$stmt->bindValue(':characterID', $r['characterID'], PDO::PARAM_INT);
	$stmt->bindValue(':time', $r['time']);
	$stmt->execute();
	$jump = $stmt->fetch(PDO::FETCH_ASSOC);
	if (!$jump) return false;

	$stmt = $mysql->prepare('INSERT INTO fork_jump_fits (maskID, wormholeID, characterID, jumpTime, shipTypeID, fitSource, hot)
		VALUES (:maskID, :wormholeID, :characterID, :jumpTime, :shipTypeID, \'hull\', :hot)
		ON DUPLICATE KEY UPDATE hot = VALUES(hot)');
	$stmt->bindValue(':maskID', $maskID);
	$stmt->bindValue(':wormholeID', $jump['wormholeID'], PDO::PARAM_INT);
	$stmt->bindValue(':characterID', $jump['characterID'], PDO::PARAM_INT);
	$stmt->bindValue(':jumpTime', $jump['time']);
	$stmt->bindValue(':shipTypeID', $jump['shipTypeID'], $jump['shipTypeID'] === null ? PDO::PARAM_NULL : PDO::PARAM_INT);
	$stmt->bindValue(':hot', $r['hot'], PDO::PARAM_INT);
	if (!$stmt->execute()) throw new PDOException('Could not save hot/cold: ' . implode(' ', $stmt->errorInfo()));
	return true;
}

/**
 * The jump log of a hole for public/mass.php: upstream's columns plus characterID and the fork's fit columns.
 * Returns $fallback (upstream's own result) if anything goes wrong, so the dialog never loses its log.
 */
function jump_fit_jumps($mysql, $maskID, $wormholeID, $fallback) {
	try {
		jump_fit_ensure_table($mysql);
		$stmt = $mysql->prepare('SELECT j.characterName, j.toID, j.shipTypeID, j.shipType, j.time, j.characterID,
			f.fitSource, f.baseMass, f.propTypeID, f.propMass, f.higgsMult, UNIX_TIMESTAMP(f.fitTime) AS fitTime, f.hot
			FROM jumps j LEFT JOIN fork_jump_fits f
			ON f.maskID = j.maskID AND f.wormholeID = j.wormholeID AND f.characterID = j.characterID AND f.jumpTime = j.time
			WHERE j.maskID = :maskID AND j.wormholeID = :wormholeID ORDER BY j.time DESC');
		$stmt->bindValue(':maskID', $maskID);
		$stmt->bindValue(':wormholeID', $wormholeID);
		if (!$stmt->execute()) return $fallback;
		return $stmt->fetchAll(PDO::FETCH_CLASS);
	} catch (Throwable $e) {
		error_log('jump_fit_jumps: ' . $e->getMessage());
		return $fallback;
	}
}
