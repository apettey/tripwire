<?php
// Fork-owned: notification type 1, "new k-space near a ping system" (see discord/discord.inc.php).
//
// discord_notify.worker.php polls the wormholes of masks that have the type enabled for signatures changed since
// its last look (signatures.modifiedTime, compared inside MySQL so the app's time zone doesn't matter; it starts
// at the newest existing change and keeps moving with it even while no mask has the type on, so nothing old is
// announced; changes from before a mask turned the type on are ignored too). No upstream code is hooked: mapping a
// hole through the UI, the automapper or the API all end up as these rows. For each side of a connection that is a
// real k-space system and was not on the mask's chain before (no other wormhole signature of the mask in that
// system), it looks up the safe gate jumps to the mask's ping systems; within range it queues one message, at most
// one per (mask, system) per cooldown, and each connection is only looked at once.

const DISCORD_KSPACE_OVERLAP = 120;   // seconds re-read before the high-water mark (writes land a little late)
const DISCORD_KSPACE_PAGE    = 500;   // rows per query
const DISCORD_KSPACE_PAGES   = 20;    // pages per poll; anything beyond is read on the next poll

/** Display form of a signature ID: 'abc123' -> 'ABC-123' */
function discord_sig_text($signatureID) {
    $sig = strtoupper(trim((string) $signatureID));
    if ($sig === '') return '???';
    return preg_match('/^[A-Z]{3}\d{3}$/', $sig) ? substr($sig, 0, 3) . '-' . substr($sig, 3) : $sig;
}

/**
 * Candidates in one wormhole row: one per side whose system is k-space. $row: wormholeID, type, parent, a.../b... columns
 * (ID, Sys, Sig, By, Name). @return array [[systemID, sigID (k-space side), via (other side system), viaSig, hole, mapper,
 * label (name of the other side's signature)], ...]
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
            // The chain label (as discord_chain_label): the name of the hole leading in, i.e. the other side's signature
            'label' => discord_chain_label_clean($row[$other . 'Name'] ?? ''),
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
        'label' => $candidate['label'] ?? '',
        'time' => time(),
    ];
}

/** Newest signature change (the high-water mark), as stored ('Y-m-d H:i:s' in the app's time zone) */
function discord_kspace_start(PDO $db) {
    return $db->query("SELECT COALESCE(MAX(modifiedTime), '1970-01-01 00:00:00') FROM signatures WHERE type = 'wormhole'")->fetchColumn();
}

/** A unix time the way signatures.modifiedTime stores times: 'Y-m-d H:i:s' in the app's time zone (TZ, default UTC) */
function discord_app_time($unix, $tz = null) {
    $tz = $tz ?? (getenv('TZ') ?: 'UTC');
    try { $zone = new DateTimeZone($tz); } catch (Exception $e) { $zone = new DateTimeZone('UTC'); }
    return (new DateTime('@' . (int) $unix))->setTimezone($zone)->format('Y-m-d H:i:s');
}

/** Whether a change (row 'changed', app time) counts for a type turned on at $enabledAt (unix; 0 = unknown, counts) */
function discord_kspace_after_enable($changed, $enabledAt, $tz = null) {
    return (int) $enabledAt <= 0 || (string) $changed >= discord_app_time($enabledAt, $tz);
}

/**
 * One poll. $masks: maskID => settings. $highWater moves to the newest change seen and, once everything up to now was
 * read, to the newest change overall (also when no mask has the type on), so turning the type on later never
 * announces old connections. Pages through by (change time, wormhole ID). Returns the number of messages queued.
 */
function discord_kspace_poll(PDO $db, array $masks, &$highWater) {
    $latest = discord_kspace_start($db);   // read first: later writes are still found through the overlap
    $masks = array_filter($masks, function ($s) { return $s['types']['kspace']['enabled'] && $s['types']['kspace']['webhookID'] > 0; });
    if (!$masks) {
        if ($latest > $highWater) $highWater = $latest;
        return 0;
    }
    $ids = array_map('strval', array_keys($masks));
    $base = 'SELECT w.id AS wormholeID, w.type, w.parent, w.maskID,
            a.id AS aID, a.systemID AS aSys, a.signatureID AS aSig, a.modifiedByName AS aBy, a.name AS aName,
            b.id AS bID, b.systemID AS bSys, b.signatureID AS bSig, b.modifiedByName AS bBy, b.name AS bName,
            GREATEST(a.modifiedTime, b.modifiedTime) AS changed
        FROM wormholes w
        INNER JOIN signatures a ON a.id = w.initialID
        INNER JOIN signatures b ON b.id = w.secondaryID
        WHERE w.maskID IN (' . implode(',', array_fill(0, count($ids), '?')) . ')
            AND GREATEST(a.modifiedTime, b.modifiedTime) >= ? - INTERVAL ' . DISCORD_KSPACE_OVERLAP . ' SECOND';
    $order = ' ORDER BY changed, w.id LIMIT ' . DISCORD_KSPACE_PAGE;
    $first = $db->prepare($base . $order);
    $next = $db->prepare($base . ' AND (GREATEST(a.modifiedTime, b.modifiedTime) > ?
        OR (GREATEST(a.modifiedTime, b.modifiedTime) = ? AND w.id > ?))' . $order);
    $since = $highWater;
    $cursor = null;
    $complete = false;
    $queued = 0;
    $onChain = $db->prepare("SELECT COUNT(*) FROM signatures WHERE maskID = ? AND systemID = ? AND type = 'wormhole' AND id <> ?");
    for ($page = 0; $page < DISCORD_KSPACE_PAGES; $page++) {
        if ($cursor === null) $first->execute(array_merge($ids, [$since]));
        else $next->execute(array_merge($ids, [$since, $cursor[0], $cursor[0], $cursor[1]]));
        $rows = ($cursor === null ? $first : $next)->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            $cursor = [$row['changed'], (int) $row['wormholeID']];
            if ($row['changed'] > $highWater) $highWater = $row['changed'];
            $maskID = (string) $row['maskID'];
            $settings = $masks[$maskID] ?? null;
            if (!$settings) continue;
            $type = $settings['types']['kspace'];
            if (!discord_kspace_after_enable($row['changed'], $type['enabledAt'] ?? 0)) continue;   // from before it was turned on
            foreach (discord_kspace_candidates($row) as $candidate) {
                // Each connection (and k-space system on it) is looked at once
                if (!discord_dedupe_once($db, $maskID, 'kspace', 'wh:' . $row['wormholeID'] . ':' . $candidate['systemID'])) continue;
                $onChain->execute([$maskID, $candidate['systemID'], $candidate['sigRowID']]);
                if ((int) $onChain->fetchColumn() > 0) continue;   // already on the chain through another hole
                $hubs = discord_hubs_in_range($candidate['systemID'], $type['pingSystems'], $type['maxJumps']);
                if (!$hubs) continue;
                $context = discord_kspace_context($candidate, $hubs, $type, discord_mask_name($db, $maskID));
                $cooldown = function () use ($db, $maskID, $candidate, $type) {
                    return discord_dedupe_cooldown($db, $maskID, 'kspace', 'sys:' . $candidate['systemID'], $type['cooldownHours'] * 3600);
                };
                if (discord_enqueue_once($db, $maskID, $type['webhookID'], 'kspace', $context, $cooldown) === null) continue;
                $queued++;
                discord_log(sprintf('queued k-space %s (%s) for mask %s: %s', $context['system'], $context['class'], $maskID,
                    implode(', ', array_map(function ($h) { return $h[0] . ' ' . $h[1]; }, $hubs))));
            }
        }
        if (count($rows) < DISCORD_KSPACE_PAGE) { $complete = true; break; }
    }
    if ($complete && $latest > $highWater) $highWater = $latest;
    return $queued;
}
