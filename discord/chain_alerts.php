<?php
// Fork-owned: notification types 10 "New hole in the chain" (chainHole) and 11 "Home static <1h / EOL" (homeStatic)
// (see discord/discord.inc.php). The in-app pop-ups of the same events are app/js/fork/chain-alerts.js.
//
// discord_notify.worker.php polls the masks with either type on (same leader and 15 s cadence as the watchlist and
// structure timers). Both need the mask's home system (Mask Admin > Discord); without one nothing is posted.
//
// New hole (chainHole): a wormhole of the mask that is live (discord_chain_live_sql) with an end in the home system
// (homeOnly, on by default) or in the chain connected to home (discord/chain.php). What is new is decided from what the
// worker has seen, never from edit times (every edit rewrites the signatures' modifiedTime, see discord/watchlist.php):
//   - every wormhole the worker has looked at is remembered in discord_sent (kind 'chole', ref 'wh:<wormholeID>') for as
//     long as it exists (the rows are not pruned by age; the poll forgets the holes that are gone);
//   - on the first poll after the type was turned on or the home system changed (the stamp '<enabledAt>:<homeID>' in
//     discord_sent kind 'choleBase'), every current hole is recorded without announcing anything;
//   - afterwards a hole not seen before is announced when it is in home (or the chain), else recorded silently (a hole
//     in an old fragment, or outside home with homeOnly, is never news later either). One message per hole.
// Home static (homeStatic): a hole in the home system whose real type, scanned in home, is one of home's statics, when
// it reaches <1h or EOL (the fork's life states, app/js/fork/life-states.js: life 'critical' and the shorter of its two
// signature timers at most 1 h / past). One message per (hole, stage) (discord_sent kind 'hstatic', ref
// 'wh:<id>:<stage>'), only the current stage, only for stages the admin ticked, and not for a stage reached before the
// type was turned on. This file only reads the mask's tables and writes discord_sent / the outbox.

const DISCORD_CHOLE_KIND      = 'chole';       // discord_sent kind: holes seen
const DISCORD_CHOLE_BASE_KIND = 'choleBase';   // discord_sent kind: the baseline's stamp
const DISCORD_HSTATIC_KIND    = 'hstatic';     // discord_sent kind: static stages announced
const DISCORD_CHAIN_ALERTS_MAX_PER_POLL = 10;  // messages per mask and type per poll; the rest wait for the next poll
const DISCORD_PRIORITY_CHAIN_ALERT = 13;       // after structure timers (14), before kills and k-space (10)
const DISCORD_HSTATIC_STAGES  = ['lt1h', 'expired'];

// ---- Pure ----

/** A unix time from a signatures time column (PHP's local time, the clock signatures.php writes with), or null */
function discord_chain_alerts_time($value) {
    if ($value === null || $value === '') return null;
    $time = strtotime((string) $value);
    return $time === false ? null : $time;
}

/**
 * Seconds left on a hole: the shorter of its signatures' timers, null when neither has one. A "never expires" signature
 * (lifeLength 0) whose timer was never set (lifeLeft = lifeTime, lifeStates.remaining) has none.
 * $hole: aLeft, aTime, aLength, bLeft, bTime, bLength (the signatures' lifeLeft, lifeTime, lifeLength).
 */
function discord_chain_alerts_remaining(array $hole, $now) {
    $out = null;
    foreach (['a', 'b'] as $side) {
        $left = discord_chain_alerts_time($hole[$side . 'Left'] ?? null);
        if ($left === null) continue;
        if ((int) ($hole[$side . 'Length'] ?? 1) === 0 && (string) ($hole[$side . 'Left'] ?? '') === (string) ($hole[$side . 'Time'] ?? '')) continue;
        $r = $left - $now;
        if ($out === null || $r < $out) $out = $r;
    }
    return $out;
}

/** The fork's life state of a hole: 'stable', 'lt4h', 'lt1h' or 'expired' (lifeStates.derive) */
function discord_chain_alerts_life($life, $remaining) {
    if ($life !== 'critical') return 'stable';
    if ($remaining === null || $remaining > 3600) return 'lt4h';
    return $remaining > 0 ? 'lt1h' : 'expired';
}

/** The side ('a' / 'b') the real type was scanned on */
function discord_chain_alerts_typed_side(array $hole) {
    return ($hole['parent'] ?? '') === 'secondary' ? 'b' : 'a';
}

/** Whether it is known which side the real type was scanned on (parent 'initial' / 'secondary') */
function discord_chain_alerts_side_known(array $hole) {
    return in_array($hole['parent'] ?? null, ['initial', 'secondary'], true);
}

/** The type seen from a side: the real type on the side it was scanned on, else K162; '' when not known (also when
    neither side's type is known: no parent, so neither side is the K162) */
function discord_chain_alerts_hole_type(array $hole, $side) {
    if (!discord_chain_alerts_side_known($hole)) return '';
    $type = strtoupper(trim((string) ($hole['type'] ?? '')));
    if (discord_chain_alerts_typed_side($hole) !== $side) return 'K162';
    return $type === '' || $type === '????' ? '' : $type;
}

/**
 * Which end of a new hole the message is about: the end in home, else an end in the chain (the initial side first),
 * or null when it is neither in home nor (unless $homeOnly) in the chain. $chain: systemID => true (home included).
 */
function discord_chain_hole_near(array $hole, $homeID, array $chain, $homeOnly) {
    $homeID = (int) $homeID;
    if ($homeID <= 0) return null;
    foreach (['a', 'b'] as $side) if ((int) $hole[$side] === $homeID) return $side;
    if ($homeOnly) return null;
    foreach (['a', 'b'] as $side) if (isset($chain[(int) $hole[$side]])) return $side;
    return null;
}

/**
 * What to do with a mask's holes on one poll (pure). $holes: [{wormholeID, a, b, live, ...}]; $seen: wormholeID => true;
 * $baselined: the baseline's stamp is current. Returns ['forget' => [ids gone], 'record' => [ids to remember silently],
 * 'announce' => [[hole, near side], ...] (oldest first)].
 */
function discord_chain_hole_plan(array $holes, array $seen, $baselined, $homeID, array $chain, $homeOnly) {
    $ids = [];
    foreach ($holes as $hole) $ids[(int) $hole['wormholeID']] = true;
    $out = ['forget' => [], 'record' => [], 'announce' => []];
    foreach (array_keys($seen) as $id) if (!isset($ids[(int) $id])) $out['forget'][] = (int) $id;
    usort($holes, function ($x, $y) { return (int) $x['wormholeID'] - (int) $y['wormholeID']; });
    foreach ($holes as $hole) {
        $id = (int) $hole['wormholeID'];
        if (isset($seen[$id])) continue;
        $near = $baselined && !empty($hole['live']) ? discord_chain_hole_near($hole, $homeID, $chain, $homeOnly) : null;
        if ($near === null) $out['record'][] = $id;
        else $out['announce'][] = [$hole, $near];
    }
    return $out;
}

/** The baseline's stamp: another time the type was turned on, or another home, is another baseline */
function discord_chain_hole_stamp($enabledAt, $homeID) {
    return (int) $enabledAt . ':' . (int) $homeID;
}

/**
 * Whether a hole is a static of home: its real type was scanned in home ($homeID) and is one of $statics. Returns the
 * home side ('a' / 'b') or null.
 */
function discord_home_static_side(array $hole, $homeID, array $statics) {
    if (!discord_chain_alerts_side_known($hole)) return null;
    $side = discord_chain_alerts_typed_side($hole);
    if ((int) $homeID <= 0 || (int) $hole[$side] !== (int) $homeID) return null;
    $type = strtoupper(trim((string) ($hole['type'] ?? '')));
    return $type !== '' && in_array($type, array_map('strtoupper', $statics), true) ? $side : null;
}

/**
 * The stage to announce for a hole of home now, or null (pure): its current life state when it is <1h or EOL, ticked in
 * $stages, and reached at or after $enabledAt (<1h is reached an hour before the timer ends, EOL when it ends).
 */
function discord_home_static_due(array $hole, $now, array $stages, $enabledAt = 0) {
    $remaining = discord_chain_alerts_remaining($hole, $now);
    $stage = discord_chain_alerts_life($hole['life'] ?? 'stable', $remaining);
    if (!in_array($stage, DISCORD_HSTATIC_STAGES, true) || !in_array($stage, $stages, true)) return null;
    $reached = $now + $remaining - ($stage === 'lt1h' ? 3600 : 0);
    if ((int) $enabledAt > 0 && $reached < (int) $enabledAt) return null;
    return $stage;
}

/** "about 40 minutes left" / "past its lifetime, it can collapse any time" */
function discord_home_static_when($stage, $remaining) {
    if ($stage === 'expired') return 'past its lifetime, it can collapse any time';
    $minutes = max(1, intdiv(max(0, (int) $remaining), 60));   // rounded down: <1h never says "60 minutes"
    return 'about ' . $minutes . ' minute' . ($minutes === 1 ? '' : 's') . ' left';
}

/** "J152820 (C5)" / "an unknown system" */
function discord_chain_alerts_far($systemID) {
    $systemID = (int) $systemID;
    if ($systemID < 30000000 || discord_system($systemID) === null) return 'an unknown system';
    $class = discord_system_class($systemID);
    return discord_system_name($systemID) . ($class !== '' ? ' (' . $class . ')' : '');
}

// ---- Messages ----

/** Message context of a new hole ($near: the side in home / the chain; $label: the chain label of that system) */
function discord_chain_hole_context(array $hole, $near, $homeID, array $type, $maskName, $label) {
    $far = $near === 'a' ? 'b' : 'a';
    $systemID = (int) $hole[$near];
    $system = discord_system($systemID);
    $mapper = trim((string) ($hole[$near . 'By'] ?? '')) ?: trim((string) ($hole[$far . 'By'] ?? ''));
    return [
        'kind' => 'chainHole', 'template' => $type['template'], 'ping' => $type['ping'], 'mask' => $maskName,
        'wormholeID' => (int) $hole['wormholeID'], 'systemID' => $systemID, 'system' => $system ? $system[0] : (string) $systemID,
        'class' => discord_system_class($systemID), 'label' => (string) $label,
        'where' => $systemID === (int) $homeID ? 'home' : 'the chain',
        'sig' => discord_sig_text($hole[$near . 'Sig'] ?? ''), 'hole' => discord_chain_alerts_hole_type($hole, $near),
        'to' => discord_chain_alerts_far($hole[$far]), 'mapper' => $mapper !== '' ? $mapper : 'someone',
        'map' => discord_map_url($systemID), 'time' => time(),
    ];
}

/** Message context of a home static reaching a stage */
function discord_home_static_context(array $hole, $side, $stage, $remaining, array $type, $maskName) {
    $far = $side === 'a' ? 'b' : 'a';
    $systemID = (int) $hole[$side];
    $system = discord_system($systemID);
    return [
        'kind' => 'homeStatic', 'template' => $type['template'], 'ping' => $type['ping'], 'mask' => $maskName,
        'wormholeID' => (int) $hole['wormholeID'], 'systemID' => $systemID, 'system' => $system ? $system[0] : (string) $systemID,
        'hole' => strtoupper(trim((string) $hole['type'])), 'sig' => discord_sig_text($hole[$side . 'Sig'] ?? ''),
        'to' => discord_chain_alerts_far($hole[$far]), 'stage' => $stage, 'state' => $stage === 'expired' ? 'EOL' : '<1h',
        'when' => discord_home_static_when($stage, $remaining), 'map' => discord_map_url($systemID), 'time' => time(),
    ];
}

/** The webhook payload of both types (plain text, no embed) */
function discord_chain_alerts_payload(array $ctx) {
    $kind = $ctx['kind'] === 'homeStatic' ? 'homeStatic' : 'chainHole';
    $values = [
        'pings' => $ctx['ping'] ?? '', 'mask' => $ctx['mask'] ?? '', 'system' => $ctx['system'] ?? '',
        'hole' => ($ctx['hole'] ?? '') !== '' ? $ctx['hole'] : 'unknown type', 'sig' => $ctx['sig'] ?? '',
        // "J152820 (C5)": the name escaped, the brackets around our own class text kept plain
        'to' => preg_replace_callback('/^(.*?)( \((?:[A-Za-z0-9 -]+)\))?$/s', function ($m) { return discord_escape($m[1]) . ($m[2] ?? ''); }, (string) ($ctx['to'] ?? '')),
        'map' => isset($ctx['map']) ? '<' . $ctx['map'] . '>' : '',
    ];
    if ($kind === 'chainHole') {
        $values += ['class' => $ctx['class'] ?? '', 'label' => $ctx['label'] ?? '', 'where' => $ctx['where'] ?? 'the chain',
            'labelSystem' => discord_label_system($ctx['label'] ?? '', $ctx['system'] ?? ''), 'mapper' => $ctx['mapper'] ?? ''];
    } else {
        $values += ['state' => ($ctx['state'] ?? '') === 'EOL' ? 'EOL' : '<1h', 'when' => $ctx['when'] ?? ''];
    }
    $raw = ['pings', 'map', 'to', 'state'];   // to: escaped above; state: our own text
    $template = $ctx['template'] ?? '';
    $content = discord_render($template, $values, $raw);
    if ($content === '') {
        $template = discord_default_templates()[$kind];
        $content = discord_render($template, $values, $raw);
    }
    return ['username' => 'Tripwire', 'content' => $content, 'allowed_mentions' => discord_allowed_mentions($template, $ctx['ping'] ?? '')];
}

// ---- Database ----

/** The mask's type when it is turned on with a webhook, else null */
function discord_chain_alerts_type(array $settings, $kind) {
    $type = $settings['types'][$kind] ?? null;
    if (!$type || !$type['enabled'] || $type['webhookID'] <= 0) return null;
    if ($kind === 'homeStatic' && empty($type['stages'])) return null;
    return $type;
}

/**
 * Every hole of a mask with what both types read, plus 'live' (discord_chain_live_sql at $now). Holes whose far side
 * is not known carry the generic placeholder ID (< 30000000) as that side's system.
 */
function discord_chain_alerts_holes(PDO $db, $maskID, $now) {
    $at = date('Y-m-d H:i:s', $now);
    $stmt = $db->prepare("SELECT w.id AS wormholeID, w.type, w.parent, w.life,
            a.systemID AS a, a.signatureID AS aSig, a.modifiedByName AS aBy, a.lifeLeft AS aLeft, a.lifeTime AS aTime, a.lifeLength AS aLength,
            b.systemID AS b, b.signatureID AS bSig, b.modifiedByName AS bBy, b.lifeLeft AS bLeft, b.lifeTime AS bTime, b.lifeLength AS bLength,
            CASE WHEN " . discord_chain_live_sql() . " THEN 1 ELSE 0 END AS live
        FROM wormholes w
        INNER JOIN signatures a ON a.id = w.initialID
        INNER JOIN signatures b ON b.id = w.secondaryID
        WHERE w.maskID = ?
        ORDER BY w.id");
    $stmt->execute([$at, $at, (string) $maskID]);
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $row['wormholeID'] = (int) $row['wormholeID'];
        $row['a'] = (int) $row['a'];
        $row['b'] = (int) $row['b'];
        $row['live'] = (int) $row['live'] === 1;
        $out[] = $row;
    }
    return $out;
}

/** wormholeID => true: the holes the worker has seen for a mask */
function discord_chain_hole_seen(PDO $db, $maskID) {
    $stmt = $db->prepare('SELECT ref FROM discord_sent WHERE maskID = ? AND kind = ?');
    $stmt->execute([(string) $maskID, DISCORD_CHOLE_KIND]);
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $ref) if (preg_match('/^wh:(\d+)$/', (string) $ref, $m)) $out[(int) $m[1]] = true;
    return $out;
}

function discord_chain_hole_baselined(PDO $db, $maskID, $stamp) {
    $stmt = $db->prepare('SELECT 1 FROM discord_sent WHERE maskID = ? AND kind = ? AND ref = ?');
    $stmt->execute([(string) $maskID, DISCORD_CHOLE_BASE_KIND, (string) $stamp]);
    return (bool) $stmt->fetchColumn();
}

/** One poll of the "New hole in the chain" type for one mask. Returns the number of messages queued. */
function discord_chain_hole_poll_mask(PDO $db, $maskID, array $settings, array $type, array $holes, array $chain) {
    $maskID = (string) $maskID;
    $homeID = (int) ($settings['homeSystemID'] ?? 0);
    $stamp = discord_chain_hole_stamp($type['enabledAt'] ?? 0, $homeID);
    $baselined = discord_chain_hole_baselined($db, $maskID, $stamp);
    $plan = discord_chain_hole_plan($holes, discord_chain_hole_seen($db, $maskID), $baselined, $homeID, $chain, !empty($type['homeOnly']));
    $forget = $db->prepare('DELETE FROM discord_sent WHERE maskID = ? AND kind = ? AND ref = ?');
    foreach ($plan['forget'] as $id) $forget->execute([$maskID, DISCORD_CHOLE_KIND, 'wh:' . $id]);
    foreach ($plan['record'] as $id) discord_dedupe_once($db, $maskID, DISCORD_CHOLE_KIND, 'wh:' . $id);
    if (!$baselined) {
        $db->prepare('DELETE FROM discord_sent WHERE maskID = ? AND kind = ?')->execute([$maskID, DISCORD_CHOLE_BASE_KIND]);
        discord_dedupe_once($db, $maskID, DISCORD_CHOLE_BASE_KIND, $stamp);
        return 0;
    }
    $queued = 0;
    foreach ($plan['announce'] as [$hole, $near]) {
        if ($queued >= DISCORD_CHAIN_ALERTS_MAX_PER_POLL) break;   // not recorded: the next poll announces it
        $context = discord_chain_hole_context($hole, $near, $homeID, $type, discord_mask_name($db, $maskID), discord_chain_label($db, $maskID, $hole[$near]));
        $ref = 'wh:' . $hole['wormholeID'];
        $claim = function () use ($db, $maskID, $ref) { return discord_dedupe_once($db, $maskID, DISCORD_CHOLE_KIND, $ref); };
        if (discord_enqueue_once($db, $maskID, $type['webhookID'], 'chainHole', $context, $claim, DISCORD_PRIORITY_CHAIN_ALERT) === null) continue;
        $queued++;
        discord_log(sprintf('queued new hole %s in %s for mask %s', $context['sig'], $context['system'], $maskID));
    }
    return $queued;
}

/** One poll of the "Home static <1h / EOL" type for one mask. Returns the number of messages queued. */
function discord_home_static_poll_mask(PDO $db, $maskID, array $settings, array $type, array $holes, $now, array $data) {
    $maskID = (string) $maskID;
    $homeID = (int) ($settings['homeSystemID'] ?? 0);
    $statics = $data['systems'][$homeID]['statics'] ?? [];
    if ($homeID <= 0 || !$statics) return 0;
    $queued = 0;
    foreach ($holes as $hole) {
        if ($queued >= DISCORD_CHAIN_ALERTS_MAX_PER_POLL) break;
        $side = discord_home_static_side($hole, $homeID, $statics);
        if ($side === null) continue;
        $stage = discord_home_static_due($hole, $now, $type['stages'], $type['enabledAt'] ?? 0);
        if ($stage === null) continue;
        $ref = 'wh:' . $hole['wormholeID'] . ':' . $stage;
        $check = $db->prepare('SELECT 1 FROM discord_sent WHERE maskID = ? AND kind = ? AND ref = ?');
        $check->execute([$maskID, DISCORD_HSTATIC_KIND, $ref]);
        if ($check->fetchColumn()) continue;   // nothing is built for what was already sent
        $context = discord_home_static_context($hole, $side, $stage, discord_chain_alerts_remaining($hole, $now), $type, discord_mask_name($db, $maskID));
        $claim = function () use ($db, $maskID, $ref) { return discord_dedupe_once($db, $maskID, DISCORD_HSTATIC_KIND, $ref); };
        if (discord_enqueue_once($db, $maskID, $type['webhookID'], 'homeStatic', $context, $claim, DISCORD_PRIORITY_CHAIN_ALERT) === null) continue;
        $queued++;
        discord_log(sprintf('queued home static %s %s in %s for mask %s', $context['hole'], $context['state'], $context['system'], $maskID));
    }
    return $queued;
}

/**
 * One poll over the masks with either type on ($masks: maskID => settings; $now: unix time, default now). Reads each
 * mask's holes once for both types. Returns the number of messages queued.
 */
function discord_chain_alerts_poll(PDO $db, array $masks, $now = null) {
    $now = $now ?? time();
    $work = [];
    foreach ($masks as $maskID => $settings) {
        $hole = discord_chain_alerts_type($settings, 'chainHole');
        $static = discord_chain_alerts_type($settings, 'homeStatic');
        if (!$hole && !$static) continue;
        if ((int) ($settings['homeSystemID'] ?? 0) <= 0) continue;   // no home: nothing is ours (the page warns)
        $work[(string) $maskID] = [$settings, $hole, $static];
    }
    if (!$work) return 0;
    $homes = [];
    foreach ($work as $maskID => [$settings, $hole]) if ($hole) $homes[$maskID] = (int) $settings['homeSystemID'];
    $chains = $homes ? discord_chain_systems($db, $homes, $now) : [];
    $data = null;
    $queued = 0;
    foreach ($work as $maskID => [$settings, $hole, $static]) {
        $holes = discord_chain_alerts_holes($db, $maskID, $now);
        if ($hole) $queued += discord_chain_hole_poll_mask($db, $maskID, $settings, $hole, $holes, $chains[$maskID] ?? []);
        if ($static) {
            $data = $data ?? watchlist_data();
            $queued += discord_home_static_poll_mask($db, $maskID, $settings, $static, $holes, $now, $data);
        }
    }
    return $queued;
}
