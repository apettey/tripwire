<?php
// Fork-owned: notification types 2-4, kills (see discord/discord.inc.php).
//
// zkill_feed.worker.php hands every killmail it streams from R2Z2 to discord_on_killmail() (never back-filled
// ones). Only kills that happened in the last DISCORD_KILL_MAX_AGE seconds count, so a worker catching up after
// downtime never posts old kills. Per mask with a kill type enabled:
//   chainKill  the kill is in a system on the mask's chain (a system with one of the mask's wormhole signatures)
//   corpKill   one of the attackers is in "our" corporations/alliances (and the victim is not)
//   corpLoss   the victim is in "our" corporations/alliances
// Each (mask, type, killID) is queued once. When several matching types post to the same webhook, only the most
// specific one is sent (loss > kill > chain). Names are resolved later by the dispatcher (zkill_names cache).

const DISCORD_KILL_MAX_AGE  = 900;   // seconds: older kills are history, not news
const DISCORD_KILL_REFRESH  = 60;    // seconds between reloads of settings, webhooks and chain systems
const DISCORD_POD_TYPES     = [670, 33328];   // Capsule, Capsule - Genolution 'Auroral' 197-variant

/** The facts of a killmail (R2Z2 shape {killmail_id, zkb, esi} or API shape) the notifications need, or null */
function discord_kill_facts(array $kill) {
    $esi = isset($kill['esi']) && is_array($kill['esi']) ? $kill['esi'] : $kill;
    $zkb = isset($kill['zkb']) && is_array($kill['zkb']) ? $kill['zkb'] : [];
    $killID = $kill['killmail_id'] ?? ($esi['killmail_id'] ?? null);
    if (!is_numeric($killID) || !isset($esi['solar_system_id'], $esi['killmail_time']) || !is_array($esi['victim'] ?? null)) return null;
    $time = strtotime($esi['killmail_time']);
    if ($time === false) return null;
    $int = function ($source, $key) { return is_array($source) && isset($source[$key]) && is_numeric($source[$key]) ? (int) $source[$key] : 0; };
    $victim = $esi['victim'];
    $attackers = [];
    $finalBlow = null;
    foreach (is_array($esi['attackers'] ?? null) ? $esi['attackers'] : [] as $a) {
        if (!is_array($a)) continue;
        $entry = ['character' => $int($a, 'character_id'), 'corporation' => $int($a, 'corporation_id'),
            'alliance' => $int($a, 'alliance_id'), 'ship' => $int($a, 'ship_type_id')];
        $attackers[] = $entry;
        if (!empty($a['final_blow'])) $finalBlow = $entry;
    }
    return [
        'killID' => (int) $killID,
        'systemID' => (int) $esi['solar_system_id'],
        'time' => $time,
        'hash' => (string) ($kill['hash'] ?? ($zkb['hash'] ?? '')),
        'victim' => ['character' => $int($victim, 'character_id'), 'corporation' => $int($victim, 'corporation_id'),
            'alliance' => $int($victim, 'alliance_id'), 'ship' => $int($victim, 'ship_type_id')],
        'attackers' => $attackers,
        'finalBlow' => $finalBlow,
        'pilots' => count(array_filter($attackers, function ($a) { return $a['character'] > 0; })),
        'value' => is_numeric($zkb['totalValue'] ?? null) ? (float) $zkb['totalValue'] : 0.0,
        'npc' => !empty($zkb['npc']),
    ];
}

/** Whether a kill is recent enough to announce */
function discord_kill_is_live(array $facts, $now = null) {
    $now = $now ?? time();
    return $facts['time'] >= $now - DISCORD_KILL_MAX_AGE && $facts['time'] <= $now + 300;
}

/** Whether a party (victim or attacker) is on "our" side */
function discord_is_ours(array $party, array $settings) {
    return ($party['corporation'] > 0 && in_array($party['corporation'], $settings['corporations'], true))
        || ($party['alliance'] > 0 && in_array($party['alliance'], $settings['alliances'], true));
}

/**
 * Types to send for a kill and one mask: kind => webhookID. $chainSystems: systemID => true (the mask's chain).
 * Applies each type's filters (NPC kills, pods, minimum value) and the one-message-per-webhook rule.
 */
function discord_classify_kill(array $facts, array $settings, array $chainSystems) {
    $matches = [];
    $ours = function ($p) use ($settings) { return discord_is_ours($p, $settings); };
    $victimOurs = $ours($facts['victim']);
    $attackerOurs = false;
    foreach ($facts['attackers'] as $a) { if ($ours($a)) { $attackerOurs = true; break; } }
    $candidates = [
        'corpLoss' => $victimOurs,
        'corpKill' => $attackerOurs && !$victimOurs,
        'chainKill' => isset($chainSystems[$facts['systemID']]),
    ];
    $usedWebhooks = [];
    foreach ($candidates as $kind => $match) {   // most specific first
        $type = $settings['types'][$kind];
        if (!$match || !$type['enabled'] || $type['webhookID'] <= 0) continue;
        if ($facts['npc'] && !$type['includeNpc']) continue;
        if ($type['excludePods'] && in_array($facts['victim']['ship'], DISCORD_POD_TYPES, true)) continue;
        if ($facts['value'] < $type['minIsk']) continue;
        if (isset($usedWebhooks[$type['webhookID']])) continue;
        $usedWebhooks[$type['webhookID']] = true;
        $matches[$kind] = $type['webhookID'];
    }
    return $matches;
}

/** Outbox data of a kill notification: IDs (names are resolved when it is sent) plus the type's template/ping */
function discord_kill_data($kind, array $facts, array $type, $maskName) {
    $fb = $facts['finalBlow'] ?? ['character' => 0, 'corporation' => 0, 'alliance' => 0, 'ship' => 0];
    return [
        'kind' => $kind, 'template' => $type['template'], 'ping' => $type['ping'], 'mask' => $maskName,
        'killID' => $facts['killID'], 'systemID' => $facts['systemID'], 'time' => $facts['time'],
        'victimID' => $facts['victim']['character'], 'corpID' => $facts['victim']['corporation'],
        'allianceID' => $facts['victim']['alliance'], 'shipTypeID' => $facts['victim']['ship'],
        'finalBlowID' => $fb['character'], 'finalBlowCorpID' => $fb['corporation'],
        'attackers' => $facts['pilots'], 'value' => $facts['value'],
    ];
}

/** IDs whose names a kill message needs */
function discord_kill_name_ids(array $data) {
    return array_values(array_filter([$data['victimID'] ?? 0, $data['corpID'] ?? 0, $data['allianceID'] ?? 0,
        $data['shipTypeID'] ?? 0, $data['finalBlowID'] ?? 0, $data['finalBlowCorpID'] ?? 0]));
}

/** Message context of a kill from its outbox data and the names known so far */
function discord_kill_context(array $data, array $names) {
    $name = function ($id, $fallback) use ($names) { return $id && isset($names[$id]) ? $names[$id] : ($id ? $fallback : ''); };
    $system = discord_system($data['systemID']);
    return [
        'kind' => $data['kind'], 'template' => $data['template'], 'ping' => $data['ping'], 'mask' => $data['mask'],
        'systemID' => $data['systemID'], 'system' => $system ? $system[0] : (string) $data['systemID'],
        'security' => $system ? $system[1] : 0, 'class' => discord_system_class($data['systemID']),
        'region' => $system ? discord_region_name($system[2]) : '',
        'map' => discord_map_url($data['systemID']), 'dotlan' => discord_dotlan_url($data['systemID']),
        'killID' => $data['killID'], 'time' => $data['time'],
        'victimID' => $data['victimID'], 'victim' => $data['victimID'] ? $name($data['victimID'], 'Unknown pilot') : 'Structure / NPC',
        'shipTypeID' => $data['shipTypeID'], 'ship' => $name($data['shipTypeID'], 'ship'),
        'corp' => $name($data['corpID'], 'Unknown corporation'), 'alliance' => $name($data['allianceID'], ''),
        'finalblow' => $data['finalBlowID'] ? $name($data['finalBlowID'], 'Unknown pilot') : 'NPC',
        'attackercorp' => $name($data['finalBlowCorpID'], ''),
        'attackers' => $data['attackers'], 'value' => $data['value'],
        'zkill' => 'https://zkillboard.com/kill/' . (int) $data['killID'] . '/',
    ];
}

/** Settings, webhooks and chain systems of masks with a kill type enabled (reloaded every DISCORD_KILL_REFRESH s) */
function discord_kill_state(PDO $db, $force = false) {
    static $state = null, $loaded = 0;
    if (!$force && $state !== null && time() - $loaded < DISCORD_KILL_REFRESH) return $state;
    $state = ['masks' => [], 'chains' => []];
    $loaded = time();
    $webhooks = [];
    foreach ($db->query("SELECT id, maskID FROM discord_webhooks WHERE status = 'ok'")->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $webhooks[(int) $row['id']] = (string) $row['maskID'];
    }
    foreach (discord_active_settings($db) as $maskID => $settings) {
        $any = false;
        foreach (['chainKill', 'corpKill', 'corpLoss'] as $kind) {
            $type = &$settings['types'][$kind];
            if ($type['enabled'] && ($webhooks[$type['webhookID']] ?? null) !== (string) $maskID) $type['enabled'] = false;
            $any = $any || $type['enabled'];
            unset($type);
        }
        if ($any) $state['masks'][(string) $maskID] = $settings;
    }
    $chainMasks = array_keys(array_filter($state['masks'], function ($s) { return $s['types']['chainKill']['enabled']; }));
    if ($chainMasks) {
        $stmt = $db->prepare("SELECT DISTINCT maskID, systemID FROM signatures WHERE type = 'wormhole' AND systemID >= 30000000
            AND maskID IN (" . implode(',', array_fill(0, count($chainMasks), '?')) . ')');
        $stmt->execute($chainMasks);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) $state['chains'][(string) $row['maskID']][(int) $row['systemID']] = true;
    }
    return $state;
}

/**
 * zkill_feed.worker.php: a killmail streamed from R2Z2. Queues the matching notifications; returns how many.
 * Never throws: errors are logged (at most once a minute) so the kill stream is never held up.
 */
function discord_on_killmail(PDO $db, array $kill) {
    static $lastError = 0;
    try {
        $facts = discord_kill_facts($kill);
        if ($facts === null || !discord_kill_is_live($facts)) return 0;
        $state = discord_with_schema($db, 'discord_kill_state');
        if (!$state['masks']) return 0;
        $queued = 0;
        foreach ($state['masks'] as $maskID => $settings) {
            foreach (discord_classify_kill($facts, $settings, $state['chains'][$maskID] ?? []) as $kind => $webhookID) {
                if (!discord_dedupe_once($db, $maskID, 'kill:' . $kind, (string) $facts['killID'])) continue;
                $data = discord_kill_data($kind, $facts, $settings['types'][$kind], discord_mask_name($db, $maskID));
                if (function_exists('zk_names_lookup')) zk_names_lookup($db, discord_kill_name_ids($data));   // the worker resolves them meanwhile
                if (discord_enqueue($db, $maskID, $webhookID, $kind, $data) !== null) {
                    $queued++;
                    discord_log("queued $kind {$facts['killID']} for mask $maskID");
                }
            }
        }
        return $queued;
    } catch (Throwable $error) {
        if (time() - $lastError >= 60) {
            $lastError = time();
            discord_log('kill notification error: ' . $error->getMessage());
        }
        return 0;
    }
}
