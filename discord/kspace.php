<?php
// Fork-owned: notification type 1, "new k-space near a ping system" (see discord/discord.inc.php).
//
// discord_notify.worker.php polls the wormholes of masks that have the type enabled for signatures changed since
// its last look (signatures.modifiedTime, compared inside MySQL so the app's time zone doesn't matter; it starts
// at the newest existing change, so nothing old is announced). No upstream code is hooked: mapping a hole through
// the UI, the automapper or the API all end up as these rows. For each side of a connection that is a real k-space
// system and was not on the mask's chain before (no other wormhole signature of the mask in that system), it
// looks up the safe gate jumps to the mask's ping systems; within range it queues one message, at most one per
// (mask, system) per cooldown, and each connection is only looked at once.

const DISCORD_KSPACE_OVERLAP = 120;   // seconds re-read before the high-water mark (writes land a little late)

/** Display form of a signature ID: 'abc123' -> 'ABC-123' */
function discord_sig_text($signatureID) {
    $sig = strtoupper(trim((string) $signatureID));
    if ($sig === '') return '???';
    return preg_match('/^[A-Z]{3}\d{3}$/', $sig) ? substr($sig, 0, 3) . '-' . substr($sig, 3) : $sig;
}

/**
 * Candidates in one wormhole row: one per side whose system is k-space. $row: wormholeID, type, parent, a.../b... columns
 * (ID, Sys, Sig, By). @return array [[systemID, sigID (k-space side), via (other side system), viaSig, hole, mapper], ...]
 */
function discord_kspace_candidates(array $row) {
    $out = [];
    foreach (['a' => 'b', 'b' => 'a'] as $side => $other) {
        $systemID = (int) $row[$side . 'Sys'];
        if (!discord_is_kspace($systemID)) continue;
        // The real type sits on the 'parent' side; the far side of the hole is the K162
        $typed = ($row['parent'] === 'initial' && $other === 'a') || ($row['parent'] === 'secondary' && $other === 'b');
        $type = strtoupper(trim((string) $row['type']));
        $hole = $typed ? ($type === '' || $type === '????' ? '' : $type) : 'K162';
        $out[] = [
            'systemID' => $systemID,
            'sigRowID' => (int) $row[$side . 'ID'],
            'via' => (int) $row[$other . 'Sys'],
            'viaSig' => discord_sig_text($row[$other . 'Sig']),
            'hole' => $hole,
            'mapper' => (string) ($row[$side . 'By'] ?: $row[$other . 'By']),
        ];
    }
    return $out;
}

/** Message context of a k-space candidate in range */
function discord_kspace_context(array $candidate, array $hubs, array $type, $maskName) {
    $system = discord_system($candidate['systemID']);
    $via = discord_system($candidate['via']);
    return [
        'kind' => 'kspace', 'template' => $type['template'], 'ping' => $type['ping'], 'mask' => $maskName,
        'systemID' => $candidate['systemID'], 'system' => $system[0], 'security' => $system[1],
        'class' => discord_system_class($candidate['systemID']), 'region' => discord_region_name($system[2]),
        'map' => discord_map_url($candidate['systemID']), 'dotlan' => discord_dotlan_url($candidate['systemID']),
        'hubs' => array_map(function ($h) { return [$h[0], $h[1]]; }, $hubs),
        'sig' => $candidate['viaSig'], 'hole' => $candidate['hole'],
        'from' => $via ? $via[0] : 'unknown system', 'mapper' => $candidate['mapper'] !== '' ? $candidate['mapper'] : 'someone',
        'time' => time(),
    ];
}

/** Newest signature change (the starting high-water mark), as stored ('Y-m-d H:i:s' in the app's time zone) */
function discord_kspace_start(PDO $db) {
    return $db->query("SELECT COALESCE(MAX(modifiedTime), '1970-01-01 00:00:00') FROM signatures WHERE type = 'wormhole'")->fetchColumn();
}

/**
 * One poll. $masks: maskID => settings (kspace enabled). $highWater is advanced to the newest change seen.
 * Returns the number of messages queued.
 */
function discord_kspace_poll(PDO $db, array $masks, &$highWater) {
    $masks = array_filter($masks, function ($s) { return $s['types']['kspace']['enabled'] && $s['types']['kspace']['webhookID'] > 0; });
    if (!$masks) return 0;
    $ids = array_keys($masks);
    $stmt = $db->prepare('SELECT w.id AS wormholeID, w.type, w.parent, w.maskID,
            a.id AS aID, a.systemID AS aSys, a.signatureID AS aSig, a.modifiedByName AS aBy, a.modifiedTime AS aMod,
            b.id AS bID, b.systemID AS bSys, b.signatureID AS bSig, b.modifiedByName AS bBy, b.modifiedTime AS bMod
        FROM wormholes w
        INNER JOIN signatures a ON a.id = w.initialID
        INNER JOIN signatures b ON b.id = w.secondaryID
        WHERE w.maskID IN (' . implode(',', array_fill(0, count($ids), '?')) . ')
            AND (a.modifiedTime >= ? - INTERVAL ' . DISCORD_KSPACE_OVERLAP . ' SECOND OR b.modifiedTime >= ? - INTERVAL ' . DISCORD_KSPACE_OVERLAP . ' SECOND)
        ORDER BY GREATEST(a.modifiedTime, b.modifiedTime), w.id
        LIMIT 500');
    $stmt->execute(array_merge($ids, [$highWater, $highWater]));
    $queued = 0;
    $onChain = $db->prepare("SELECT COUNT(*) FROM signatures WHERE maskID = ? AND systemID = ? AND type = 'wormhole' AND id <> ?");
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        foreach ([$row['aMod'], $row['bMod']] as $mod) if ($mod > $highWater) $highWater = $mod;
        $maskID = (string) $row['maskID'];
        $settings = $masks[$maskID] ?? null;
        if (!$settings) continue;
        $type = $settings['types']['kspace'];
        foreach (discord_kspace_candidates($row) as $candidate) {
            // Each connection (and k-space system on it) is looked at once
            if (!discord_dedupe_once($db, $maskID, 'kspace', 'wh:' . $row['wormholeID'] . ':' . $candidate['systemID'])) continue;
            $onChain->execute([$maskID, $candidate['systemID'], $candidate['sigRowID']]);
            if ((int) $onChain->fetchColumn() > 0) continue;   // already on the chain through another hole
            $hubs = discord_hubs_in_range($candidate['systemID'], $type['pingSystems'], $type['maxJumps']);
            if (!$hubs) continue;
            $ref = 'sys:' . $candidate['systemID'];
            if (!discord_dedupe_cooldown($db, $maskID, 'kspace', $ref, $type['cooldownHours'] * 3600)) continue;
            $context = discord_kspace_context($candidate, $hubs, $type, discord_mask_name($db, $maskID));
            if (discord_enqueue($db, $maskID, $type['webhookID'], 'kspace', $context) === null) {
                discord_dedupe_forget($db, $maskID, 'kspace', $ref);
                continue;
            }
            $queued++;
            discord_log(sprintf('queued k-space %s (%s) for mask %s: %s', $context['system'], $context['class'], $maskID,
                implode(', ', array_map(function ($h) { return $h[0] . ' ' . $h[1]; }, $hubs))));
        }
    }
    return $queued;
}
