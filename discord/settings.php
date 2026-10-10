<?php
// Fork-owned: per-mask settings of the Discord notifications (see discord/discord.inc.php).
//
// {
//   types: {
//     kspace:    {enabled, webhookID, template, ping, pingSystems: [systemID...], maxJumps, cooldownHours},
//     chainKill: {enabled, webhookID, template, ping, minIsk, includeNpc, excludePods},
//     corpKill:  {...same as chainKill}, corpLoss: {...same as chainKill}
//   },
//   corporations: [corporationID...], alliances: [allianceID...]   ("our" side for corpKill / corpLoss)
// }
// Everything is off until an admin enables a type and picks a webhook.

const DISCORD_DEFAULT_PING_SYSTEMS = [30000142, 30002187];   // Jita, Amarr
const DISCORD_MAX_PING_SYSTEMS = 20;
const DISCORD_MAX_ENTITIES = 20;
const DISCORD_TEMPLATE_MAX = 1500;

/** Defaults; $corporationID / $allianceID seed "our" side (the mask's corporation or the admin's) */
function discord_settings_defaults($corporationID = 0, $allianceID = 0) {
    $templates = discord_default_templates();
    $kill = function ($kind) use ($templates) {
        return ['enabled' => false, 'webhookID' => 0, 'template' => $templates[$kind], 'ping' => '', 'enabledAt' => 0,
            'minIsk' => 0, 'includeNpc' => false, 'excludePods' => false];
    };
    return [
        'types' => [
            'kspace' => ['enabled' => false, 'webhookID' => 0, 'template' => $templates['kspace'], 'ping' => '', 'enabledAt' => 0,
                'pingSystems' => DISCORD_DEFAULT_PING_SYSTEMS, 'maxJumps' => 10, 'cooldownHours' => 6],
            'chainKill' => $kill('chainKill') + ['includeHighsec' => false],
            'corpKill' => $kill('corpKill'),
            'corpLoss' => $kill('corpLoss'),
        ],
        'corporations' => $corporationID > 0 ? [(int) $corporationID] : [],
        'alliances' => $allianceID > 0 ? [(int) $allianceID] : [],
    ];
}

/**
 * Discord notifications belong to a corporation and its Tripwire admins (the corp admin flag, checkAdmin): the
 * corporation mask ('<corp>.2') and custom masks ('<id>.0') owned by a corporation. Never Public (0.0), Private
 * ('<character>.1'), alliance masks or custom masks owned by a character (anyone can create those).
 * By the ID alone: 'corp', 'custom' (still needs its owner checked) or null.
 */
function discord_mask_kind($maskID) {
    if (!preg_match('/^([1-9]\d*)\.([02])$/', (string) $maskID, $m)) return null;
    return $m[2] === '2' ? 'corp' : 'custom';
}

/**
 * The corporation a mask belongs to for Discord notifications, or null when the mask can't have them.
 * $customOwner: [ownerID, ownerType] of a custom mask from the masks table (null = no such mask).
 */
function discord_mask_corporation($maskID, ?array $customOwner = null) {
    $kind = discord_mask_kind($maskID);
    if ($kind === 'corp') return (int) explode('.', (string) $maskID)[0];
    if ($kind === 'custom' && $customOwner && (int) $customOwner[1] === 2 && (int) $customOwner[0] > 0) return (int) $customOwner[0];
    return null;
}

/** discord_mask_corporation() with the custom mask's owner read from the masks table */
function discord_mask_corporation_db(PDO $db, $maskID) {
    $owner = null;
    if (discord_mask_kind($maskID) === 'custom') {
        $stmt = $db->prepare('SELECT ownerID, ownerType FROM masks WHERE maskID = ?');
        $stmt->execute([(string) $maskID]);
        $row = $stmt->fetch(PDO::FETCH_NUM);
        $owner = $row ? [(int) $row[0], (int) $row[1]] : null;
    }
    return discord_mask_corporation($maskID, $owner);
}

/** "Our" side of a mask by default: the corporation the mask belongs to */
function discord_mask_entities($maskCorporationID) {
    return [(int) $maskCorporationID, 0];
}

function discord_int_list($value, $max, callable $valid) {
    $out = [];
    foreach ((is_array($value) ? $value : []) as $id) {
        if (is_string($id) && ctype_digit($id)) $id = (int) $id;
        if (is_int($id) && $valid($id) && !in_array($id, $out, true)) $out[] = $id;
        if (count($out) >= $max) break;
    }
    return $out;
}

/**
 * Validate settings (from the browser or the database) against the defaults. Returns [settings, errors]: invalid
 * values fall back to the defaults and are reported. $webhookIDs = IDs of this mask's webhooks (null = don't check).
 */
function discord_settings_normalise($input, array $defaults, ?array $webhookIDs = null) {
    $errors = [];
    $input = is_array($input) ? $input : [];
    $out = $defaults;
    foreach (DISCORD_KINDS as $kind) {
        $in = is_array($input['types'][$kind] ?? null) ? $input['types'][$kind] : [];
        $type = $defaults['types'][$kind];
        if (array_key_exists('enabled', $in)) $type['enabled'] = $in['enabled'] === true || $in['enabled'] === 1 || $in['enabled'] === '1' || $in['enabled'] === 'true';
        if (array_key_exists('webhookID', $in)) {
            $id = is_numeric($in['webhookID']) ? (int) $in['webhookID'] : 0;
            if ($id > 0 && $webhookIDs !== null && !in_array($id, $webhookIDs, true)) { $errors[] = "$kind: unknown webhook"; $id = 0; }
            $type['webhookID'] = max(0, $id);
        }
        if (array_key_exists('template', $in)) {
            $template = trim(str_replace("\r", '', (string) $in['template']));
            if ($template === '') $template = $defaults['types'][$kind]['template'];
            if (mb_strlen($template) > DISCORD_TEMPLATE_MAX) { $errors[] = "$kind: template longer than " . DISCORD_TEMPLATE_MAX . ' characters'; $template = mb_substr($template, 0, DISCORD_TEMPLATE_MAX); }
            $type['template'] = $template;
        }
        if (array_key_exists('ping', $in)) {
            $ping = discord_ping_normalise($in['ping']);
            if ($ping === null) { $errors[] = "$kind: ping may only contain <@&roleID>, <@userID>, @here or @everyone"; $ping = ''; }
            $type['ping'] = $ping;
        }
        if ($type['enabled'] && $type['webhookID'] <= 0) { $errors[] = "$kind: pick a webhook to enable it"; $type['enabled'] = false; }
        // Set by the server (discord_settings_stamp); kept as stored
        if (isset($in['enabledAt']) && is_numeric($in['enabledAt'])) $type['enabledAt'] = max(0, (int) $in['enabledAt']);
        if ($kind === 'kspace') {
            if (array_key_exists('pingSystems', $in)) {
                $type['pingSystems'] = discord_int_list($in['pingSystems'], DISCORD_MAX_PING_SYSTEMS, function ($id) {
                    $system = discord_system($id);
                    return $system !== null && ($system[3] & 1);
                });
            }
            if (array_key_exists('maxJumps', $in)) $type['maxJumps'] = max(1, min(50, (int) $in['maxJumps']));
            if (array_key_exists('cooldownHours', $in)) $type['cooldownHours'] = max(1, min(48, (int) $in['cooldownHours']));
            if ($type['enabled'] && !$type['pingSystems']) { $errors[] = 'kspace: add at least one ping system'; $type['enabled'] = false; }
        } else {
            if (array_key_exists('minIsk', $in)) $type['minIsk'] = max(0, min(1e15, (float) (is_numeric($in['minIsk']) ? $in['minIsk'] : 0)));
            foreach (['includeNpc', 'excludePods', 'includeHighsec'] as $flag) {
                if (array_key_exists($flag, $in) && array_key_exists($flag, $type)) $type[$flag] = $in[$flag] === true || $in[$flag] === 1 || $in[$flag] === '1' || $in[$flag] === 'true';
            }
        }
        $out['types'][$kind] = $type;
    }
    if (array_key_exists('corporations', $input)) $out['corporations'] = discord_int_list($input['corporations'], DISCORD_MAX_ENTITIES, function ($id) { return $id >= 1000000 && $id < 2147483647; });
    if (array_key_exists('alliances', $input)) $out['alliances'] = discord_int_list($input['alliances'], DISCORD_MAX_ENTITIES, function ($id) { return $id >= 1000000 && $id < 2147483647; });
    if (($out['types']['corpKill']['enabled'] || $out['types']['corpLoss']['enabled']) && !$out['corporations'] && !$out['alliances']) {
        $errors[] = 'corporation kills/losses need at least one corporation or alliance';
        $out['types']['corpKill']['enabled'] = $out['types']['corpLoss']['enabled'] = false;
    }
    return [$out, $errors];
}

/** Stored settings of a mask merged over the defaults (null row = defaults) */
/**
 * enabledAt of each type, from the server's clock only: when a type goes from off to on it is now, while it stays on
 * it is kept, off is 0. Nothing that happened before a type was turned on is announced (old connections and kills).
 */
function discord_settings_stamp(array $new, array $old, $now = null) {
    $now = $now ?? time();
    foreach (DISCORD_KINDS as $kind) {
        $was = $old['types'][$kind] ?? [];
        $new['types'][$kind]['enabledAt'] = !$new['types'][$kind]['enabled'] ? 0
            : (!empty($was['enabled']) && !empty($was['enabledAt']) ? (int) $was['enabledAt'] : (int) $now);
    }
    return $new;
}

function discord_settings_load(PDO $db, $maskID, array $defaults) {
    $stmt = $db->prepare('SELECT settings FROM discord_settings WHERE maskID = ?');
    $stmt->execute([$maskID]);
    $json = $stmt->fetchColumn();
    if ($json === false) return $defaults;
    return discord_settings_normalise(json_decode($json, true), $defaults)[0];
}

function discord_settings_save(PDO $db, $maskID, array $settings, $by) {
    $stmt = $db->prepare('INSERT INTO discord_settings (maskID, settings, updatedBy, updatedAt) VALUES (?, ?, ?, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE settings = VALUES(settings), updatedBy = VALUES(updatedBy), updatedAt = VALUES(updatedAt)');
    $stmt->execute([$maskID, json_encode($settings), substr((string) $by, 0, 100)]);
}

/** Whether a corporation still has at least one Tripwire admin (characters.admin) */
function discord_corporation_has_admin(PDO $db, $corporationID) {
    $stmt = $db->prepare('SELECT 1 FROM characters WHERE corporationID = ? AND admin = 1 LIMIT 1');
    $stmt->execute([(int) $corporationID]);
    return (bool) $stmt->fetchColumn();
}

/**
 * The corporation a mask sends Discord notifications for, or 0 when it can't (any more): not a corporation or
 * corporation-owned custom mask, or the corporation has no Tripwire admin left. Used by the worker and the dispatcher.
 */
function discord_mask_sending_corporation(PDO $db, $maskID) {
    $corporationID = discord_mask_corporation_db($db, $maskID);
    return $corporationID !== null && discord_corporation_has_admin($db, $corporationID) ? $corporationID : 0;
}

/**
 * Worker: every mask with at least one enabled type: maskID => settings (defaults without "our" side). Masks that can
 * no longer have notifications are skipped: not a corporation or corporation-owned custom mask (any more), or their
 * corporation has no Tripwire admin left. Settings stay stored; an admin of the corporation can change them again.
 */
function discord_active_settings(PDO $db) {
    $out = [];
    foreach ($db->query('SELECT maskID, settings FROM discord_settings')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        if (!discord_mask_sending_corporation($db, $row['maskID'])) continue;
        $settings = discord_settings_normalise(json_decode($row['settings'], true), discord_settings_defaults())[0];
        foreach (DISCORD_KINDS as $kind) {
            if ($settings['types'][$kind]['enabled'] && $settings['types'][$kind]['webhookID'] > 0) { $out[(string) $row['maskID']] = $settings; break; }
        }
    }
    return $out;
}

/** Mask names for messages: 'Corp', 'Private', custom mask name... */
function discord_mask_name(PDO $db, $maskID) {
    static $cache = [];
    $maskID = (string) $maskID;
    if (isset($cache[$maskID])) return $cache[$maskID];
    $type = explode('.', $maskID)[1] ?? '';
    $name = ['1' => 'Private', '2' => 'Corp', '3' => 'Alliance'][$type] ?? null;
    if ($name === null) {
        $stmt = $db->prepare('SELECT name FROM masks WHERE maskID = ?');
        $stmt->execute([$maskID]);
        $name = $stmt->fetchColumn() ?: 'Mask ' . $maskID;
    }
    return $cache[$maskID] = $name;
}
