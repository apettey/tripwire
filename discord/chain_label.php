<?php
// Fork-owned: chain labels (see docker/README.md#discord-notifications).
//
// The chain label of a system is the name of the wormhole signature leading into it, as the chain map shows it (the
// fork's hole naming: A, AB, AABCA...). Used by the rally point (discord/rally.php, rally_discord.inc.php), new
// k-space (discord/kspace.php) and the kill messages (discord/kills.php). discord_chain_label() looks up one system
// (one query); discord_chain_labels() every labelled system of several masks at once (one query, done with the kill
// notifications' 60 s refresh so the kill feed never waits on a query per kill). Both pick with discord_chain_label_pick.

/**
 * The chain label of a system in a mask's chain, as the chain map shows it (app/js/chain-map.js, sigNameLocation):
 * the trimmed name of the wormhole signature *leading into* the system, i.e. the signature on the far side of the
 * wormhole, in the neighbouring system (chain-map.js: node.child.name = the parent system's signature's name).
 * '' when there is none (home, k-space without a named hole, no wormhole, or the lookup fails).
 *
 * The chain map picks the inbound hole by walking out from the active chain tab's home system(s), which are each
 * user's own option, so the server can't repeat that walk. It uses the rule the Add Signature dialog uses without a
 * home tab (holeNaming.incomingFromWormholes, app/js/fork/hole-naming.js): a wormhole of the mask touching the system
 * leads into it when its far-side signature has a name starting with a letter or digit (its leading token, so not a
 * return bookmark) and its near-side signature (in the system) has none or is a
 * return bookmark ("!C", or the older "<C": discord_is_return_bookmark); a named near side is a hole out of the
 * system. With several (a system reached more than
 * once, loops) the one closest to home wins: the shortest leading name token ("AB" before "ABC"), then the lowest
 * wormhole id. One query (both directions of the wormhole, UNION ALL), prepared.
 */
function discord_chain_label(PDO $db, $maskID, $systemID) {
    $systemID = (int) $systemID;
    if ($systemID <= 0) return '';
    $side = "SELECT w.id AS wormholeID, n.name AS nearName, f.name AS farName, f.systemID AS farSystem
        FROM signatures n INNER JOIN wormholes w ON w.%s = n.id AND w.maskID = n.maskID INNER JOIN signatures f ON f.id = w.%s
        WHERE n.systemID = ? AND n.maskID = ? AND n.type = 'wormhole'";
    try {
        $stmt = $db->prepare(sprintf($side, 'initialID', 'secondaryID') . ' UNION ALL ' . sprintf($side, 'secondaryID', 'initialID'));
        if (!$stmt || !$stmt->execute([$systemID, (string) $maskID, $systemID, (string) $maskID])) return '';
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        return '';   // e.g. no such tables (tests, a fresh database)
    }
    return discord_chain_label_pick($rows, $systemID);
}

/**
 * Every chain label of some masks at once: maskID => [systemID => label], only systems that have one. The same rows
 * and rule as discord_chain_label (discord_chain_label_pick), from one query over the masks' wormholes.
 * [] when the lookup fails (e.g. no tables yet).
 */
function discord_chain_labels(PDO $db, array $maskIDs) {
    $maskIDs = array_values(array_unique(array_map('strval', $maskIDs)));
    if (!$maskIDs) return [];
    $in = implode(',', array_fill(0, count($maskIDs), '?'));
    try {
        // Each wormhole once with both signatures; a side is a "near" side (discord_chain_label's n) when it is a
        // wormhole signature of the wormhole's mask
        $stmt = $db->prepare("SELECT w.id AS wormholeID, w.maskID AS maskID,
                a.systemID AS aSystem, a.name AS aName, (a.type = 'wormhole' AND a.maskID = w.maskID) AS aNear,
                b.systemID AS bSystem, b.name AS bName, (b.type = 'wormhole' AND b.maskID = w.maskID) AS bNear
            FROM wormholes w INNER JOIN signatures a ON a.id = w.initialID INNER JOIN signatures b ON b.id = w.secondaryID
            WHERE w.maskID IN ($in)");
        if (!$stmt || !$stmt->execute($maskIDs)) return [];
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $error) {
        return [];
    }
    // decimal(12,1) maskIDs come back as e.g. '98000001.2'; map them to the IDs asked for (as discord_chain_links)
    $byNumber = [];
    foreach ($maskIDs as $maskID) $byNumber[number_format((float) $maskID, 1, '.', '')] = $maskID;
    $candidates = [];   // maskID => systemID => rows as discord_chain_label reads them
    foreach ($rows as $row) {
        $maskID = $byNumber[number_format((float) $row['maskID'], 1, '.', '')] ?? (string) $row['maskID'];
        foreach ([['a', 'b'], ['b', 'a']] as [$near, $far]) {
            if (!(int) $row[$near . 'Near']) continue;
            $candidates[$maskID][(int) $row[$near . 'System']][] = ['wormholeID' => (int) $row['wormholeID'],
                'nearName' => $row[$near . 'Name'], 'farName' => $row[$far . 'Name'], 'farSystem' => (int) $row[$far . 'System']];
        }
    }
    $out = [];
    foreach ($candidates as $maskID => $systems) {
        foreach ($systems as $systemID => $sides) {
            $label = $systemID > 0 ? discord_chain_label_pick($sides, $systemID) : '';
            if ($label !== '') $out[$maskID][$systemID] = $label;
        }
    }
    return $out;
}

/** The label from discord_chain_label's rows (wormholeID, nearName, farName, farSystem): see there for the rule */
function discord_chain_label_pick(array $rows, $systemID) {
    $best = null;
    foreach ($rows as $row) {
        if ((int) $row['farSystem'] === (int) $systemID) continue;
        $far = discord_chain_label_clean($row['farName']);
        if ($far === '') continue;
        $near = discord_chain_label_clean($row['nearName']);
        if ($near !== '' && !discord_is_return_bookmark($near)) continue;   // a hole out of the system
        if (!preg_match('/^[A-Za-z0-9]+/', $far, $m)) continue;   // no name token (e.g. a return bookmark "!C"), as holeNaming
        $rank = [strlen($m[0]), (int) $row['wormholeID']];
        if ($best === null || $rank < $best[0]) $best = [$rank, $far];
    }
    return $best ? $best[1] : '';
}

/** True for a return bookmark name: "!" + the hole's name ("!AB"), or the older "<AB". Mirrors holeNaming.isReturnBookmark
 * (app/js/fork/hole-naming.js, RETURN_PREFIXES). */
function discord_is_return_bookmark($name) {
    $name = trim((string) $name);
    return $name !== '' && strpos('!<', $name[0]) !== false;
}

/** A signature name as a label: one line, trimmed, at most 100 characters (the column's size). Escaped when rendered. */
function discord_chain_label_clean($name) {
    $name = trim(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string) $name) ?? '');
    return mb_substr($name, 0, 100);
}
