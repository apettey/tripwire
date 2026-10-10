<?php
// Fork-owned: which systems are "the chain" of a mask right now (see docker/README.md#discord-notifications).
//
// The chain is every system connected to the mask's home system (set in Mask Admin > Discord) through the mask's
// LIVE wormholes, walked outward from home (breadth-first; through k-space too, like the chain map). It includes home
// and the k-space exits. Old fragments (holes that are still in the mask but no longer connect to home, e.g. after
// the connecting hole collapsed and was deleted, or after the corporation moved home) are not part of it.
//
// A wormhole is live when:
//   - its row in `wormholes` and BOTH of its signatures exist, all in the same mask, and both are wormhole signatures;
//   - neither signature is past its life: lifeLeft >= now (PHP's local time, the clock signatures.php writes lifeLeft
//     with), unless lifeLength is 0 (no expiry known). Critical (EOL) and mass-critical holes still count until their
//     lifeLeft passes. Upstream's wormholeClean event only deletes holes at lifeLeft + 10 % of their life, so a hole
//     nobody deleted stops counting here up to that long before it disappears from the database.
//   - both ends are real systems (systemID >= 30000000). A signature whose far side is unknown carries a generic
//     placeholder ID, which is never walked through (two unknown ends must not join two chains).
//
// discord/kills.php uses it for "Chain kills". It's written for any per-mask matcher (the Watchlist's Discord matcher
// can switch to it): discord_chain_systems() for many masks at once (one query), discord_chain_systems_cached() for
// one mask with a DISCORD_CHAIN_CACHE seconds cache.

const DISCORD_CHAIN_CACHE = 60;   // seconds a cached chain is reused (the kill notifications refresh every minute too)

/** The live wormhole links of some masks: maskID => [[systemA, systemB], ...] (see the rule above) */
function discord_chain_links(PDO $db, array $maskIDs, $now = null) {
    $maskIDs = array_values(array_unique(array_map('strval', $maskIDs)));
    if (!$maskIDs) return [];
    $at = date('Y-m-d H:i:s', $now ?? time());
    $in = implode(',', array_fill(0, count($maskIDs), '?'));
    $stmt = $db->prepare("SELECT w.maskID AS maskID, a.systemID AS a, b.systemID AS b
        FROM wormholes w
        INNER JOIN signatures a ON a.id = w.initialID AND a.maskID = w.maskID AND a.type = 'wormhole'
        INNER JOIN signatures b ON b.id = w.secondaryID AND b.maskID = w.maskID AND b.type = 'wormhole'
        WHERE w.maskID IN ($in) AND a.systemID >= 30000000 AND b.systemID >= 30000000
            AND (a.lifeLength = 0 OR a.lifeLeft >= ?) AND (b.lifeLength = 0 OR b.lifeLeft >= ?)");
    $stmt->execute(array_merge($maskIDs, [$at, $at]));
    // decimal(12,1) maskIDs come back as e.g. '98000001.2'; map them to the IDs asked for
    $byNumber = [];
    foreach ($maskIDs as $maskID) $byNumber[number_format((float) $maskID, 1, '.', '')] = $maskID;
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $maskID = $byNumber[number_format((float) $row['maskID'], 1, '.', '')] ?? (string) $row['maskID'];
        $out[$maskID][] = [(int) $row['a'], (int) $row['b']];
    }
    return $out;
}

/** Breadth-first walk from home over links [[a, b], ...] (both directions): systemID => true, home included */
function discord_chain_walk(array $links, $homeID) {
    $homeID = (int) $homeID;
    if ($homeID <= 0) return [];
    $next = [];
    foreach ($links as [$a, $b]) {
        $next[(int) $a][] = (int) $b;
        $next[(int) $b][] = (int) $a;
    }
    $seen = [$homeID => true];
    $queue = [$homeID];
    for ($i = 0; $i < count($queue); $i++) {
        foreach ($next[$queue[$i]] ?? [] as $to) {
            if (isset($seen[$to])) continue;
            $seen[$to] = true;
            $queue[] = $to;
        }
    }
    return $seen;
}

/**
 * The chain of each mask: $homes maskID => home systemID. Returns maskID => [systemID => true]; a mask without a home
 * (0) gets an empty chain (nothing counts as its chain, never "everything"). One query for all masks.
 */
function discord_chain_systems(PDO $db, array $homes, $now = null) {
    $withHome = array_filter($homes, function ($home) { return (int) $home > 0; });
    $links = $withHome ? discord_chain_links($db, array_map('strval', array_keys($withHome)), $now) : [];
    $out = [];
    foreach ($homes as $maskID => $home) {
        $out[(string) $maskID] = (int) $home > 0 ? discord_chain_walk($links[(string) $maskID] ?? [], $home) : [];
    }
    return $out;
}

/** discord_chain_systems() for one mask, reused for DISCORD_CHAIN_CACHE seconds (per process) */
function discord_chain_systems_cached(PDO $db, $maskID, $homeID, $now = null) {
    static $cache = [];
    $now = $now ?? time();
    $key = $maskID . '|' . (int) $homeID;
    if (isset($cache[$key]) && $now - $cache[$key][0] < DISCORD_CHAIN_CACHE) return $cache[$key][1];
    $chain = discord_chain_systems($db, [(string) $maskID => (int) $homeID], $now)[(string) $maskID];
    $cache[$key] = [$now, $chain];
    return $chain;
}
