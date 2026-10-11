<?php
// Fork-owned: tests for the "Structure timers" Discord type (discord/structure_timers.php): settings, the lead rules
// (dedupe, most recent due lead, enabledAt / timerSetAt skips, grace), the message (template, escaping, mentions) and the
// poll against the dev database with a mask no real user has (rows removed afterwards). No network: nothing is sent.
//   docker compose -f docker-compose.dev.yml exec -T app php discord/tests/structure_timers_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../../public');
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/../../db.inc.php');
require_once(__DIR__ . '/../discord.inc.php');
require_once(__DIR__ . '/../../structures/structures.inc.php');

$failures = 0;
$count = 0;
function check($name, $actual, $expected) {
    global $failures, $count;
    $count++;
    if ($actual !== $expected) {
        $failures++;
        fwrite(STDERR, "FAIL $name\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
    }
}
discord_log_sink(function ($m) { });

$tpl = discord_default_templates();

// --- settings ---
$d = discord_settings_defaults(98000001)['types']['structureTimer'];
check('defaults: off, all four leads, hostileOnly off', [$d['enabled'], $d['webhookID'], $d['leads'], $d['hostileOnly'], $d['ping']], [false, 0, [1440, 60, 15, 0], false, '']);
check('defaults: fields', array_keys($d), ['enabled', 'webhookID', 'template', 'ping', 'enabledAt', 'leads', 'hostileOnly']);
check('kind is registered', in_array('structureTimer', DISCORD_KINDS, true), true);
[$s, $err] = discord_settings_normalise(['types' => ['structureTimer' => ['enabled' => true, 'webhookID' => 5, 'leads' => ['15', 1440, 7, 15, 0], 'hostileOnly' => '1', 'ping' => '@here']]],
    discord_settings_defaults(), [5]);
check('settings: leads filtered, longest first, no repeats; hostile only', [$s['types']['structureTimer']['leads'], $s['types']['structureTimer']['hostileOnly'], $s['types']['structureTimer']['enabled'], $err],
    [[1440, 15, 0], true, true, []]);
check('settings: no lead ticked cannot be enabled', discord_settings_normalise(['types' => ['structureTimer' => ['enabled' => true, 'webhookID' => 5, 'leads' => []]]], discord_settings_defaults(), [5])[1],
    ['structureTimer: tick at least one reminder']);
check('settings: missing leads keep the defaults', discord_settings_normalise(['types' => ['structureTimer' => ['enabled' => false]]], discord_settings_defaults())[0]['types']['structureTimer']['leads'], [1440, 60, 15, 0]);
check('settings: stamped like the other types', discord_settings_stamp($s, discord_settings_defaults(), 4000)['types']['structureTimer']['enabledAt'], 4000);
check('type: only on with a webhook and a lead', [discord_structure_timer_type($s) !== null, discord_structure_timer_type(discord_settings_defaults())], [true, null]);
check('placeholders are listed for the settings page', array_keys(discord_placeholders()['structureTimer']),
    ['pings', 'mask', 'system', 'chainLabel', 'structure', 'type', 'owner', 'timer', 'endsEve', 'endsRelative', 'lead', 'setBy', 'note', 'map']);

// --- the lead rules (pure) ---
$end = 1800003600;
$all = [1440, 60, 15, 0];
check('lead text', array_map('discord_structure_timer_lead_text', [1440, 60, 90, 15, 0]), ['in 24h', 'in 1h', 'in 1h 30m', 'in 15m', 'now']);
check('due: not yet', discord_structure_timer_due_lead($end, 0, $all, $end - 1441 * 60, 0), null);
check('due: 24 h', discord_structure_timer_due_lead($end, 0, $all, $end - 1440 * 60, 0), 1440);
check('due: still 24 h until the next lead', discord_structure_timer_due_lead($end, 0, $all, $end - 61 * 60, 0), 1440);
check('due: 1 h then 15 m then the end', [discord_structure_timer_due_lead($end, 0, $all, $end - 3600, 0), discord_structure_timer_due_lead($end, 0, $all, $end - 900, 0), discord_structure_timer_due_lead($end, 0, $all, $end, 0)], [60, 15, 0]);
check('due: only the most recent of several due leads (a late poll)', discord_structure_timer_due_lead($end, 0, $all, $end - 100, 0), 15);
check('due: 5 minutes after the end is too late, 4:59 still fires', [discord_structure_timer_due_lead($end, 0, $all, $end + 300, 0), discord_structure_timer_due_lead($end, 0, $all, $end + 299, 0)], [null, 0]);
check('due: set 30 minutes before the end: 15 m, not 24 h and 1 h', discord_structure_timer_due_lead($end, $end - 1800, $all, $end - 900, 0), 15);
check('due: set 10 minutes before the end: only the end', [discord_structure_timer_due_lead($end, $end - 600, $all, $end - 590, 0), discord_structure_timer_due_lead($end, $end - 600, $all, $end, 0)], [null, 0]);
check('due: leads that fell due before the type was turned on are skipped', discord_structure_timer_due_lead($end, 0, $all, $end - 900, $end - 1800), 15);
check('due: only some leads ticked', discord_structure_timer_due_lead($end, 0, [60, 0], $end - 900, 0), 60);
check('due: no leads', discord_structure_timer_due_lead($end, 0, [], $end, 0), null);

check('chain text: label, home, in chain, not in chain, no home', [
    discord_structure_timer_chain_text(5, 1, [1 => true, 5 => true], 'AB'), discord_structure_timer_chain_text(1, 1, [1 => true], ''),
    discord_structure_timer_chain_text(5, 1, [1 => true, 5 => true], ''), discord_structure_timer_chain_text(9, 1, [1 => true], 'AB'),
    discord_structure_timer_chain_text(1, 0, [], ''),
], ['AB', 'home', 'in chain', '', '']);

// --- the message ---
$ctx = ['kind' => 'structureTimer', 'template' => $tpl['structureTimer'], 'ping' => '<@&111111111111111111>', 'mask' => 'Corp', 'systemID' => 31001880, 'system' => 'J152820',
    'chainLabel' => 'AB', 'structure' => 'J152820 - Fort Knox', 'type' => 'Fortizar', 'owner' => '[HSTL] Hostile Haulers', 'timer' => 'Hull timer',
    'timerAt' => gmmktime(18, 30, 0, 10, 12, 2026), 'lead' => 15, 'setBy' => 'Scout', 'note' => 'n', 'map' => discord_map_url(31001880), 'time' => 1];
$p = discord_payload($ctx);
check('message: default text', $p['content'], '<@&111111111111111111> ' . "\u{23F0}" . ' Hull timer in 15m: Fortizar "J152820 \\- Fort Knox" (\\[HSTL\\] Hostile Haulers) in J152820 (AB), ends 2026-10-12 18:30 EVE (<t:'
    . gmmktime(18, 30, 0, 10, 12, 2026) . ':R>)');
check('message: pings only what the admin wrote', $p['allowed_mentions'], discord_allowed_mentions($tpl['structureTimer'], '<@&111111111111111111>'));
check('message: not in the chain', strpos(discord_payload(['chainLabel' => ''] + $ctx)['content'], 'in J152820 (not in chain)') !== false, true);
check('message: at the end', strpos(discord_payload(['lead' => 0] + $ctx)['content'], 'Hull timer now:') !== false, true);
$evil = discord_payload(['structure' => '@everyone <@&222222222222222222>', 'owner' => '@here', 'note' => '**x**', 'template' => '{pings} {structure} {owner} {note}', 'ping' => ''] + $ctx);
check('message: game text cannot ping or format', [strpos($evil['content'], '@everyone') === false || strpos($evil['content'], "@\u{200B}everyone") !== false, strpos($evil['content'], '<@&222') === false, $evil['allowed_mentions']['parse'] ?? null, $evil['allowed_mentions']['roles'] ?? null],
    [true, true, [], null]);
check('message: an empty template falls back to the default', discord_payload(['template' => ''] + $ctx)['content'], $p['content']);

// --- the poll, against the dev database ---
$db = $mysql;
const MASK = '999999994.2';
const OTHER = '999999994.1';
function cleanup($db) {
    $db->exec('DELETE FROM fork_structures WHERE maskID IN (' . MASK . ', ' . OTHER . ')');
    $db->exec("DELETE FROM discord_outbox WHERE maskID IN ('" . MASK . "', '" . OTHER . "')");
    $db->exec("DELETE FROM discord_sent WHERE maskID IN ('" . MASK . "', '" . OTHER . "')");
}
discord_ensure_schema($db);
structures_schema($db);
cleanup($db);
$now = gmmktime(12, 0, 0, 10, 12, 2026);
$ins = function ($systemID, $at, $setAt, array $o = []) use ($db, $now) {
    $row = $o + ['maskID' => MASK, 'typeName' => 'Fortizar', 'kind' => 'upwell', 'name' => 'J152820 - Fort Knox', 'ownerID' => null, 'ownerType' => null, 'ownerName' => null,
        'ownerTicker' => null, 'ownerText' => null, 'timerKind' => 'hull', 'note' => '', 'goneAt' => null];
    $db->prepare('INSERT INTO fork_structures (maskID, systemID, typeID, typeName, kind, name, ownerID, ownerType, ownerName, ownerTicker, ownerText, state, timerKind, timerAt, timerSetBy, timerSetAt,
        note, firstSeenAt, lastSeenAt, updatedAt, goneAt) VALUES (?, ?, 35833, ?, ?, ?, ?, ?, ?, ?, ?, \'reinforced\', ?, ?, \'Scout\', ?, ?, ?, ?, ?, ?)')
        ->execute([$row['maskID'], $systemID, $row['typeName'], $row['kind'], $row['name'], $row['ownerID'], $row['ownerType'], $row['ownerName'], $row['ownerTicker'], $row['ownerText'],
            $row['timerKind'], gmdate('Y-m-d H:i:s', $at), gmdate('Y-m-d H:i:s', $setAt), $row['note'], gmdate('Y-m-d H:i:s', $now - 86400), gmdate('Y-m-d H:i:s', $now - 86400), gmdate('Y-m-d H:i:s', $now - 86400),
            $row['goneAt']]);
    return (int) $db->lastInsertId();
};
$settings = function (array $over = []) {
    $s = discord_settings_defaults(98000001);
    $s['types']['structureTimer'] = $over + ['enabled' => true, 'webhookID' => 7, 'enabledAt' => 1] + $s['types']['structureTimer'];
    return $s;
};
$queuedKinds = function () use ($db) {
    return array_map(function ($r) { return json_decode($r, true); }, $db->query("SELECT data FROM discord_outbox WHERE maskID = '" . MASK . "' AND kind = 'structureTimer' ORDER BY id")->fetchAll(PDO::FETCH_COLUMN));
};

$a = $ins(31001880, $now + 3600, $now - 86400);           // ends in 1 h: the 1 h reminder (24 h is more than the lead window... it is due too: most recent wins)
check('poll: nothing without the type on', discord_structure_timer_poll($db, [], $now), 0);
check('poll: a type that is off', discord_structure_timer_poll($db, [MASK => $settings(['enabled' => false])], $now), 0);
check('poll: the 1 h reminder', discord_structure_timer_poll($db, [MASK => $settings()], $now), 1);
$q = $queuedKinds();
check('poll: queued message', [count($q), $q[0]['kind'], $q[0]['lead'], $q[0]['type'], $q[0]['system'], $q[0]['chainLabel'], $q[0]['timerAt'], $q[0]['owner']], [1, 'structureTimer', 60, 'Fortizar', 'J152820', '', $now + 3600, 'unknown owner']);
check('poll: once only (dedupe row)', discord_structure_timer_poll($db, [MASK => $settings()], $now + 60), 0);
check('poll: the next lead is a new message', discord_structure_timer_poll($db, [MASK => $settings()], $now + 3600 - 900), 1);
check('poll: ... and the end', discord_structure_timer_poll($db, [MASK => $settings()], $now + 3600), 1);
check('poll: nothing 5 minutes after the end', discord_structure_timer_poll($db, [MASK => $settings()], $now + 3600 + 300), 0);
check('poll: three messages so far', array_map(function ($m) { return $m['lead']; }, $queuedKinds()), [60, 15, 0]);
check('poll: dedupe refs', $db->query("SELECT ref FROM discord_sent WHERE maskID = '" . MASK . "' AND kind = 'stimer' ORDER BY ref")->fetchAll(PDO::FETCH_COLUMN),
    ["$a:" . ($now + 3600) . ':0', "$a:" . ($now + 3600) . ':15', "$a:" . ($now + 3600) . ':60']);

// A changed timer end fires afresh
$db->prepare('UPDATE fork_structures SET timerAt = ?, timerSetAt = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', $now + 7200), gmdate('Y-m-d H:i:s', $now), $a]);
check('poll: a changed end is a new timer (2 h away: the 24 h lead fell due before it was set, 1 h not yet)', discord_structure_timer_poll($db, [MASK => $settings()], $now), 0);
check('poll: ... its 1 h reminder', discord_structure_timer_poll($db, [MASK => $settings()], $now + 3600), 1);

// Missed leads, enabledAt, hostile only, gone, other masks, outside the window
cleanup($db);
$b = $ins(31001880, $now + 1800, $now - 60);              // set a minute ago, ends in 30 min
check('missed leads: a timer set 30 minutes before its end sends the 15 m reminder, not 24 h / 1 h', [discord_structure_timer_poll($db, [MASK => $settings()], $now), count($queuedKinds())], [0, 0]);
check('... at 15 m', [discord_structure_timer_poll($db, [MASK => $settings()], $now + 900), $queuedKinds()[0]['lead'] ?? null], [1, 15]);
cleanup($db);
$ins(31001880, $now + 3000, $now - 86400);
check('enabledAt: leads before the type was turned on are skipped', [discord_structure_timer_poll($db, [MASK => $settings(['enabledAt' => $now - 60])], $now), discord_structure_timer_poll($db, [MASK => $settings(['enabledAt' => $now - 60])], $now + 2100)], [0, 1]);
cleanup($db);
$ins(31001880, $now + 3600, $now - 86400, ['ownerID' => 98000001, 'ownerType' => 'corporation', 'ownerName' => 'Ours', 'ownerTicker' => 'OURS']);
$ins(31001880, $now + 3600, $now - 86400, ['name' => 'J152820 - Theirs', 'ownerID' => 98000002, 'ownerType' => 'corporation', 'ownerName' => 'Hostile Haulers', 'ownerTicker' => 'HSTL']);
$ins(31001880, $now + 3600, $now - 86400, ['name' => 'J152820 - Nobody']);
$ins(31001880, $now + 3600, $now - 86400, ['name' => 'J152820 - Gone', 'goneAt' => $now - 100]);
$ins(31001880, $now + 3600, $now - 86400, ['name' => 'J152820 - No timer', 'timerKind' => null]);
$db->exec('UPDATE fork_structures SET timerAt = NULL WHERE timerKind IS NULL');
check('every live timer is posted, ours too by default (gone and timerless ones are not)', discord_structure_timer_poll($db, [MASK => $settings()], $now), 3);
cleanup($db);
$ins(31001880, $now + 3600, $now - 86400, ['ownerID' => 98000001, 'ownerType' => 'corporation', 'ownerName' => 'Ours', 'ownerTicker' => 'OURS']);
$ins(31001880, $now + 3600, $now - 86400, ['name' => 'J152820 - Theirs', 'ownerID' => 98000002, 'ownerType' => 'corporation', 'ownerName' => 'Hostile Haulers', 'ownerTicker' => 'HSTL']);
$ins(31001880, $now + 3600, $now - 86400, ['name' => 'J152820 - Nobody']);
check('hostile only: ours are skipped, hostile and unowned stay', discord_structure_timer_poll($db, [MASK => $settings(['hostileOnly' => true])], $now), 2);
$owners = array_map(function ($m) { return $m['owner']; }, $queuedKinds());
sort($owners);
check('hostile only: who was posted', $owners, ['[HSTL] Hostile Haulers', 'unknown owner']);
cleanup($db);
$ins(31001880, $now + 3600, $now - 86400, ['maskID' => OTHER]);
$ins(31001880, $now + 3 * 86400, $now - 86400);
check('other masks and timers beyond 24 h are not posted for this mask', discord_structure_timer_poll($db, [MASK => $settings()], $now), 0);
// A full outbox: nothing is claimed (the dedupe rows are rolled back), the mask's loop stops, the next poll tries again
cleanup($db);
$ins(31001880, $now + 3600, $now - 86400);
$ins(31001880, $now + 3600, $now - 86400, ['name' => 'J152820 - Second']);
$fill = $db->prepare("INSERT INTO discord_outbox (maskID, webhookID, kind, priority, data, status, nextAttemptAt, createdAt) VALUES (?, 7, 'kspace', 10, '{}', 'queued', UTC_TIMESTAMP() + INTERVAL 1 HOUR, UTC_TIMESTAMP())");
for ($i = 0; $i < DISCORD_OUTBOX_MASK_CAP; $i++) $fill->execute([MASK]);
check('full outbox: nothing queued, nothing claimed', [discord_structure_timer_poll($db, [MASK => $settings()], $now), (int) $db->query("SELECT COUNT(*) FROM discord_sent WHERE maskID = '" . MASK . "' AND kind = 'stimer'")->fetchColumn()], [0, 0]);
$db->exec("DELETE FROM discord_outbox WHERE maskID = '" . MASK . "' AND kind = 'kspace'");
check('full outbox: after room is made both reminders go out', discord_structure_timer_poll($db, [MASK => $settings()], $now), 2);
check('already sent: no second message, no context built (the dedupe row is looked at first)', [discord_structure_timer_poll($db, [MASK => $settings()], $now + 1), discord_structure_timer_sent($db, MASK, $db->query("SELECT ref FROM discord_sent WHERE maskID = '" . MASK . "' AND kind = 'stimer' LIMIT 1")->fetchColumn())], [0, true]);
cleanup($db);
$ins(31001880, $now + 3600, $now - 86400);
check('without a webhook nothing is queued', discord_structure_timer_poll($db, [MASK => $settings(['webhookID' => 0])], $now), 0);
check('a fresh database without the table: no rows, no error', (function () {
    $sqlite = new PDO('sqlite::memory:');
    $sqlite->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    return discord_structure_timer_rows($sqlite, MASK, 1800000000, 3600);
})(), []);

cleanup($db);
fwrite(STDOUT, ($failures ? 'FAILED' : 'OK') . ": $count checks, $failures failures\n");
exit($failures ? 1 : 0);
