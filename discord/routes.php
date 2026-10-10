<?php
// Fork-owned: static system data and safe gate routes for the Discord notifications (see discord/discord.inc.php).
// discord/gate_graph.php is generated from the browser's own data (appData in public/js/combine.js) by
// discord/tools/generate-gate-graph.js.

const DISCORD_ZARZAKH = 30100000;

/** The generated data: ['systems' => id => [name, security, regionID, flags, class, [neighbours]], 'regions' => id => name] */
function discord_graph(?array $set = null) {
    static $graph = null;
    if ($set !== null) $graph = $set;
    if ($graph === null) $graph = require(__DIR__ . '/gate_graph.php');
    return $graph;
}

/** [name, security, regionID, flags (1 k-space, 2 high-sec, 4 Pochven), class, neighbours] or null */
function discord_system($id) {
    $graph = discord_graph();
    return $graph['systems'][(int) $id] ?? null;
}

function discord_system_name($id) {
    $system = discord_system($id);
    return $system ? $system[0] : (string) $id;
}

function discord_region_name($regionID) {
    return discord_graph()['regions'][(int) $regionID] ?? '';
}

function discord_is_kspace($id) {
    $system = discord_system($id);
    return $system !== null && ($system[3] & 1) === 1;
}

/** Short type like the app's systemTypeName: HS / LS / NS / Trig / C1..C6 / Thera (C12) ... */
function discord_system_class($id) {
    $system = discord_system($id);
    if (!$system) return '';
    if ($system[4]) return $system[4] == 12 ? 'Thera' : 'C' . $system[4];
    if ($system[3] & 4) return 'Trig';
    if ($system[1] >= 0.45) return 'HS';
    return $system[1] > 0.0 ? 'LS' : 'NS';
}

/**
 * Whether a safe route may pass through a system (not as its start or destination): high-sec as the app shows
 * it (security >= 0.45, not Pochven) and never Zarzakh. Same rule as favouritesPanel.passable(system, safe).
 */
function discord_passable($id) {
    if ((int) $id === DISCORD_ZARZAKH) return false;
    $system = discord_system($id);
    return $system !== null && ($system[3] & 2) === 2;
}

/**
 * Safe gate jumps from $fromID to every system reachable (breadth-first): start and destination may be any
 * security, every system in between is high-sec (never Zarzakh). Gates go both ways, so the distances from a ping
 * system are also the distances to it. Memoised per start. @return array systemID => jumps
 */
function discord_safe_distances($fromID) {
    static $cache = [];
    $fromID = (int) $fromID;
    if (isset($cache[$fromID])) return $cache[$fromID];
    $graph = discord_graph();
    $dist = [];
    if (isset($graph['systems'][$fromID])) {
        $dist[$fromID] = 0;
        $queue = [$fromID];
        for ($i = 0; $i < count($queue); $i++) {
            $current = $queue[$i];
            foreach ($graph['systems'][$current][5] as $next) {
                if (isset($dist[$next])) continue;
                $dist[$next] = $dist[$current] + 1;              // reachable as a destination...
                if (discord_passable($next)) $queue[] = $next;   // ...and onwards only through high-sec
            }
        }
    }
    if (count($cache) > 64) $cache = [];
    return $cache[$fromID] = $dist;
}

/** Ping systems within $maxJumps safe jumps of $systemID, closest first: [[name, jumps, hubID], ...] */
function discord_hubs_in_range($systemID, array $pingSystems, $maxJumps) {
    $out = [];
    foreach ($pingSystems as $hub) {
        $dist = discord_safe_distances($hub);
        if (isset($dist[(int) $systemID]) && $dist[(int) $systemID] < $maxJumps) {
            $out[] = [discord_system_name($hub), $dist[(int) $systemID], (int) $hub];
        }
    }
    usort($out, function ($a, $b) { return $a[1] <=> $b[1] ?: strcmp($a[0], $b[0]); });
    return $out;
}

/** Dotlan map link of a system */
function discord_dotlan_url($systemID) {
    $system = discord_system($systemID);
    if (!$system) return 'https://evemaps.dotlan.net/';
    $region = str_replace(' ', '_', discord_region_name($system[2]));
    return 'https://evemaps.dotlan.net/map/' . rawurlencode($region) . '/' . rawurlencode(str_replace(' ', '_', $system[0]));
}

/** Tripwire link to a system */
function discord_map_url($systemID) {
    return discord_app_url() . '?system=' . rawurlencode(discord_system_name($systemID));
}
