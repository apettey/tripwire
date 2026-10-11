<?php
// Fork-owned: keep the session mask canonical and verified on every request.
//
// Mask ids are DECIMAL(12,1) in MySQL: <id>.<type> with type 0 = custom mask, 1 = character, 2 = corporation,
// 3 = alliance. Upstream compares them loosely in PHP, while MySQL compares `maskID = :mask` numerically, so a
// non-canonical spelling of a mask id could pass the PHP checks and still match another mask's rows. Here a mask id
// is only accepted in its canonical spelling ("<digits>.<0-3>", no leading zeros), and access is checked with
// strict string comparisons.
//
// Loaded by docker/db.inc.php (every endpoint) and by lib.inc.php (verifyMask).

if (!function_exists('tripwire_mask_canonical')) {

/** The canonical spelling of a mask id ("12.0"), or null when $mask is not a well-formed mask id. */
function tripwire_mask_canonical($mask) {
	if (!is_string($mask) || !preg_match('/^(\d{1,10})\.([0-3])$/D', $mask, $m)) return null;
	$id = ltrim($m[1], '0');
	if ($id === '') return $m[2] === '0' ? '0.0' : null; // "0.0" is the Public mask (masks.inc.php)
	return $id . '.' . $m[2];
}

/** The id part of a session value (character / corporation / alliance id) as a canonical string, or null. */
function tripwire_mask_session_id($value) {
	if (is_int($value)) $value = (string) $value;
	if (!is_string($value) || !preg_match('/^\d{1,10}$/D', $value)) return null;
	$value = ltrim($value, '0');
	return $value === '' ? null : $value;
}

/** The character's default mask (corporation), as upstream sets on login. */
function tripwire_mask_default(array $session) {
	return ($session['corporationID'] ?? '') . '.2';
}

/**
 * The mask $session may use for $mask: $mask itself (canonical) when it has access, otherwise the same fallback as
 * upstream verifyMask (own character / corporation / alliance mask, corporation mask for custom masks without access,
 * and the corporation mask for anything that is not a well-formed mask id).
 */
function tripwire_mask_allowed($mask, array $session, $mysql) {
	$canonical = tripwire_mask_canonical($mask);
	$characterID = tripwire_mask_session_id($session['characterID'] ?? null);
	$corporationID = tripwire_mask_session_id($session['corporationID'] ?? null);
	$allianceID = tripwire_mask_session_id($session['allianceID'] ?? null);
	$default = tripwire_mask_default($session);
	if ($canonical === null) return $default;

	[$id, $type] = explode('.', $canonical);
	if ($type === '1') return $id === $characterID ? $canonical : $characterID . '.1';
	if ($type === '2') return $id === $corporationID ? $canonical : $default;
	if ($type === '3') {
		if ($allianceID === null) return $default;
		return $id === $allianceID ? $canonical : $allianceID . '.3';
	}

	// Public mask: everyone, as upstream verifyMask
	if ($canonical === '0.0') return $canonical;

	// Custom mask: same access rule as upstream verifyMask
	if (!$mysql) return $default;
	$query = 'SELECT masks.maskID FROM masks INNER JOIN `groups` ON masks.maskID = `groups`.maskID WHERE masks.maskID = :maskID AND ((ownerID = :characterID AND ownerType = 1373) OR (ownerID = :corporationID AND ownerType = 2) OR (ownerID = :allianceID AND ownerType = 3) OR (eveID = :characterID AND eveType = 1373) OR (eveID = :corporationID AND eveType = 2) OR (eveID = :allianceID AND eveType = 3)) LIMIT 1';
	$stmt = $mysql->prepare($query);
	$stmt->bindValue(':maskID', $canonical);
	$stmt->bindValue(':characterID', $characterID ?? 0);
	$stmt->bindValue(':corporationID', $corporationID ?? 0);
	$stmt->bindValue(':allianceID', $allianceID, $allianceID === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
	if (!$stmt->execute()) return $default;
	$found = $stmt->fetchColumn(0);
	return ($found !== false && tripwire_mask_canonical((string) $found) === $canonical) ? $canonical : $default;
}

/** Called on every request with a logged-in session: replaces $_SESSION['mask'] with the mask the character may use. */
function tripwire_mask_guard($mysql) {
	if (session_status() !== PHP_SESSION_ACTIVE || !isset($_SESSION['characterID']) || !array_key_exists('mask', $_SESSION)) return;
	$allowed = tripwire_mask_allowed($_SESSION['mask'], $_SESSION, $mysql);
	if ($allowed !== $_SESSION['mask']) {
		$_SESSION['mask'] = $allowed;
		if (isset($_SESSION['options']) && is_object($_SESSION['options']) && isset($_SESSION['options']->masks) && is_object($_SESSION['options']->masks)) {
			$_SESSION['options']->masks->active = $allowed;
		}
	}
}

}
