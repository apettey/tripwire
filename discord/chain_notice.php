<?php
// Fork-owned: "chain kills are paused" notice (see docker/README.md#discord-notifications).
//
// Chain kills (discord/kills.php) only count systems connected to the mask's home system (discord/chain.php). With
// chain kills on and no home set nothing is posted, and the channel just goes quiet. discord_notify.worker.php calls
// discord_chain_notice_poll() every 15 s with the masks that have chain kills on and a working webhook:
//   - no home: one 'chainPaused' message to the chain kill channel, once per episode. The episode is a discord_sent row
//     (kind 'nohome', ref 'wh:<webhookID>'): it is the dedupe of the notice, is not pruned while the episode lasts
//     (discord_outbox_prune) and its time is shown in Mask Admin > Discord (discord_chain_notice_status).
//   - the episode ends when the mask gets a home, chain kills are turned off or moved to another channel, or the mask
//     or its webhook can no longer send: the row is deleted. When chain kills still go to that channel, now with a
//     home, one 'chainResumed' message says so. Removing the home again later starts a new episode (a new notice).
// Same rule as discord_chain_systems(): only "no home" (0) pauses chain kills. A home that has no live holes on the map
// is still a chain of one system (kills there are posted), and a home ID that isn't a known system is dropped when the
// settings are loaded (discord_settings_normalise), so it counts as no home.
// Both messages are fixed text: no template, no pings (allowed_mentions empty), the mask and system names escaped.

const DISCORD_NOTICE_KIND = 'nohome';   // discord_sent kind of a "no home" episode

/** discord_sent ref of a "no home" episode on a webhook */
function discord_chain_notice_ref($webhookID) {
    return 'wh:' . (int) $webhookID;
}

/**
 * One pass. $masks: maskID => settings of the masks with chain kills on and a working webhook (the worker's
 * dn_type_masks($db, 'chainKill')). Queues the notices due and ends the episodes that are over; returns how many
 * messages were queued. Safe to run in several processes at once: the dedupe row decides who queues.
 */
function discord_chain_notice_poll(PDO $db, array $masks) {
    $paused = [];   // maskID => chain kill webhookID, for the masks without a home
    foreach ($masks as $maskID => $settings) {
        if ((int) $settings['homeSystemID'] <= 0) $paused[(string) $maskID] = (int) $settings['types']['chainKill']['webhookID'];
    }
    $queued = 0;
    // Episodes that are over: delete the row; if chain kills still go to that channel, with a home now, say so
    $stmt = $db->prepare('SELECT maskID, ref FROM discord_sent WHERE kind = ?');
    $stmt->execute([DISCORD_NOTICE_KIND]);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $maskID = (string) $row['maskID'];
        $webhookID = (int) substr((string) $row['ref'], 3);
        if (isset($paused[$maskID]) && $paused[$maskID] === $webhookID) continue;   // still paused, already told
        $end = function () use ($db, $maskID, $row) {
            $delete = $db->prepare('DELETE FROM discord_sent WHERE maskID = ? AND kind = ? AND ref = ?');
            $delete->execute([$maskID, DISCORD_NOTICE_KIND, $row['ref']]);
            return $delete->rowCount() > 0;
        };
        $settings = $masks[$maskID] ?? null;
        $home = $settings ? (int) $settings['homeSystemID'] : 0;
        if ($home > 0 && (int) $settings['types']['chainKill']['webhookID'] === $webhookID) {
            $system = discord_system($home);
            $data = ['kind' => 'chainResumed', 'mask' => discord_mask_name($db, $maskID), 'home' => $system ? $system[0] : (string) $home];
            if (discord_enqueue_once($db, $maskID, $webhookID, 'chainResumed', $data, $end) !== null) {
                $queued++;
                discord_log("queued chainResumed for mask $maskID (home $home)");
            }
        } else {
            $end();
        }
    }
    // New episodes: one notice each (INSERT IGNORE of the row is the claim, so later passes queue nothing)
    foreach ($paused as $maskID => $webhookID) {
        $claim = function () use ($db, $maskID, $webhookID) { return discord_dedupe_once($db, $maskID, DISCORD_NOTICE_KIND, discord_chain_notice_ref($webhookID)); };
        $data = ['kind' => 'chainPaused', 'mask' => discord_mask_name($db, $maskID)];
        if (discord_enqueue_once($db, $maskID, $webhookID, 'chainPaused', $data, $claim) !== null) {
            $queued++;
            discord_log("queued chainPaused for mask $maskID (no home system)");
        }
    }
    return $queued;
}

/** The webhook payload of a notice ($ctx: kind 'chainPaused' / 'chainResumed', mask, home) */
function discord_chain_notice_payload(array $ctx) {
    $mask = discord_escape($ctx['mask'] ?? '');
    $content = ($ctx['kind'] ?? '') === 'chainResumed'
        ? 'Chain kills resumed for the **' . $mask . '** mask (home: ' . discord_escape($ctx['home'] ?? '') . ').'
        : 'Chain kills are paused: no home system is set for the **' . $mask . '** mask. An admin can set it in Tripwire > Mask Admin > Discord.';
    return ['username' => 'Tripwire', 'content' => discord_truncate($content, DISCORD_CONTENT_MAX), 'allowed_mentions' => ['parse' => []]];
}

/**
 * For Mask Admin > Discord: the notice of the current "no home" episode, or null when there is none:
 * ['status' => 'queued'|'sent'|'failed'|'old' (outbox row already pruned), 'at' => ISO time it was sent, else queued].
 */
function discord_chain_notice_status(PDO $db, $maskID) {
    $stmt = $db->prepare('SELECT createdAt FROM discord_sent WHERE maskID = ? AND kind = ? ORDER BY createdAt DESC LIMIT 1');
    $stmt->execute([$maskID, DISCORD_NOTICE_KIND]);
    $since = $stmt->fetchColumn();
    if ($since === false) return null;
    $stmt = $db->prepare("SELECT status, sentAt, createdAt FROM discord_outbox WHERE maskID = ? AND kind = 'chainPaused' AND createdAt >= ? ORDER BY id DESC LIMIT 1");
    $stmt->execute([$maskID, $since]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return ['status' => 'old', 'at' => discord_iso($since)];
    return ['status' => $row['status'], 'at' => discord_iso($row['status'] === 'sent' && $row['sentAt'] ? $row['sentAt'] : $row['createdAt'])];
}
