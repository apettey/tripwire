<?php
// Fork-owned: tests for the "New hole in the chain" and "Home static <1h / EOL" Discord types (discord/chain_alerts.php):
// settings, the pure rules (near end, plan, static stage), the messages (template, escaping, mentions) and the poll against
// the dev database with a mask no real user has (rows removed afterwards). No network: nothing is sent.
//   docker compose -f docker-compose.dev.yml exec -T app php discord/tests/chain_alerts_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

chdir(__DIR__ . '/../../public');
require_once(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/../../db.inc.php');
require_once(__DIR__ . '/../discord.inc.php');

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
$data = watchlist_data();
$HOME = 0;
foreach ($data['systems'] as $id => $s) { if (!empty($s['class']) && count($s['statics'] ?? []) === 1) { $HOME = $id; break; } }
$STATIC = $data['systems'][$HOME]['statics'][0];
const C5 = 31001880;    // J152820
const C3 = 31002012;    // J163701 (a C5 too)
const LS = 30002537;    // Amamake

// --- settings ---
$d = discord_settings_defaults(98000001)['types'];
check('defaults: both off, new holes in home only, both stages', [$d['chainHole']['enabled'], $d['chainHole']['homeOnly'], $d['homeStatic']['enabled'], $d['homeStatic']['stages']],
    [false, true, false, ['lt1h', 'expired']]);
check('kinds are registered, last', array_slice(DISCORD_KINDS, -2), ['chainHole', 'homeStatic']);
[$s, $err] = discord_settings_normalise(['types' => ['chainHole' => ['enabled' => true, 'webhookID' => 5, 'homeOnly' => 'false'],
    'homeStatic' => ['enabled' => true, 'webhookID' => 5, 'stages' => ['expired', 'bogus', 'lt1h']]]], discord_settings_defaults(), [5]);
check('settings: homeOnly off, stages in their order', [$s['types']['chainHole']['homeOnly'], $s['types']['homeStatic']['stages'], $err], [false, ['lt1h', 'expired'], []]);
check('settings: no stage cannot be enabled', discord_settings_normalise(['types' => ['homeStatic' => ['enabled' => true, 'webhookID' => 5, 'stages' => []]]], discord_settings_defaults(), [5])[1],
    ['homeStatic: tick <1h or EOL']);
check('settings: stamped like the other types', discord_settings_stamp($s, discord_settings_defaults(), 4000)['types']['chainHole']['enabledAt'], 4000);
check('type: only on with a webhook', [discord_chain_alerts_type($s, 'chainHole') !== null, discord_chain_alerts_type(discord_settings_defaults(), 'chainHole')], [true, null]);
check('placeholders', array_keys(discord_placeholders()['chainHole']), ['pings', 'mask', 'where', 'system', 'class', 'label', 'labelSystem', 'sig', 'hole', 'to', 'mapper', 'map']);

// --- pure rules ---
$h = function ($id, $a, $b, array $o = []) {
    return $o + ['wormholeID' => $id, 'a' => $a, 'b' => $b, 'type' => 'H296', 'parent' => 'initial', 'life' => 'stable', 'live' => true,
        'aSig' => 'abc123', 'bSig' => 'xyz789', 'aBy' => 'Scout', 'bBy' => 'Scout', 'aLeft' => null, 'bLeft' => null, 'aTime' => null, 'bTime' => null, 'aLength' => 57600, 'bLength' => 57600];
};
$chain = [$HOME => true, C5 => true, C3 => true];
check('near: home first, also as the secondary side', [discord_chain_hole_near($h(1, $HOME, C5), $HOME, $chain, true), discord_chain_hole_near($h(1, C5, $HOME), $HOME, $chain, true)], ['a', 'b']);
check('near: elsewhere on the chain only without homeOnly', [discord_chain_hole_near($h(1, C3, C5), $HOME, $chain, true), discord_chain_hole_near($h(1, LS, C5), $HOME, $chain, false)], [null, 'b']);
check('near: no home, nothing', discord_chain_hole_near($h(1, $HOME, C5), 0, $chain, false), null);
$plan = discord_chain_hole_plan([$h(1, $HOME, C5), $h(2, C3, C5)], [9 => true], false, $HOME, $chain, false);
check('plan: before the baseline everything is recorded, nothing announced; gone holes forgotten', $plan, ['forget' => [9], 'record' => [1, 2], 'announce' => []]);
$plan = discord_chain_hole_plan([$h(3, C3, C5), $h(1, $HOME, C5), $h(2, LS, 30000142), $h(4, $HOME, C3, ['live' => false])], [1 => true], true, $HOME, $chain, false);
check('plan: new holes on the chain are announced (oldest first), others recorded silently', [array_map(function ($x) { return [$x[0]['wormholeID'], $x[1]]; }, $plan['announce']), $plan['record']],
    [[[3, 'a']], [2, 4]]);
check('plan: homeOnly announces only holes in home', array_map(function ($x) { return $x[0]['wormholeID']; },
    discord_chain_hole_plan([$h(3, C3, C5), $h(5, C5, $HOME)], [], true, $HOME, $chain, true)['announce']), [5]);
check('hole type seen from each side', [discord_chain_alerts_hole_type($h(1, $HOME, C5), 'a'), discord_chain_alerts_hole_type($h(1, $HOME, C5), 'b'),
    discord_chain_alerts_hole_type($h(1, $HOME, C5, ['parent' => 'secondary', 'type' => '????']), 'b')], ['H296', 'K162', '']);

$now = 1800000000;
$t = function ($s) { return date('Y-m-d H:i:s', $s); };
$st = function ($left, array $o = []) use ($h, $HOME, $STATIC, $now, $t) {
    return $h(7, $HOME, C5, $o + ['type' => $STATIC, 'life' => 'critical', 'aLeft' => $t($now + $left), 'bLeft' => $t($now + $left + 600), 'aTime' => $t($now - 3600), 'bTime' => $t($now - 3600)]);
};
check('static: home side when scanned in home and a static', [discord_home_static_side($st(100), $HOME, [$STATIC]), discord_home_static_side($st(100, ['parent' => 'secondary']), $HOME, [$STATIC]),
    discord_home_static_side($st(100, ['type' => 'K162']), $HOME, [$STATIC])], ['a', null, null]);
$both = ['lt1h', 'expired'];
check('static: <4h, <1h, EOL, stable', [discord_home_static_due($st(7200), $now, $both), discord_home_static_due($st(2400), $now, $both), discord_home_static_due($st(-60), $now, $both),
    discord_home_static_due($st(2400, ['life' => 'stable']), $now, $both)], [null, 'lt1h', 'expired', null]);
check('static: the shorter timer counts', discord_home_static_due($st(4000, ['bLeft' => $t($now + 100)]), $now, $both), 'lt1h');
check('static: only ticked stages', [discord_home_static_due($st(2400), $now, ['expired']), discord_home_static_due($st(-60), $now, ['lt1h'])], [null, null]);
check('static: a stage reached before the type was turned on is skipped', [discord_home_static_due($st(2400), $now, $both, $now - 600), discord_home_static_due($st(2400), $now, $both, $now - 1300)],
    [null, 'lt1h']);
check('static: a never-expiring sig without a timer has no time left (<4h)', discord_home_static_due($st(0, ['aLength' => 0, 'bLength' => 0, 'aLeft' => $t($now - 3600), 'bLeft' => $t($now - 3600)]), $now, $both), null);
check('static: when text', [discord_home_static_when('lt1h', 2400), discord_home_static_when('lt1h', 30), discord_home_static_when('expired', -5)],
    ['about 40 minutes left', 'about 1 minute left', 'past its lifetime, it can collapse any time']);

// --- messages ---
$ctx = discord_chain_hole_context($h(1, C3, C5, ['parent' => 'secondary']), 'a', $HOME, ['template' => $tpl['chainHole'], 'ping' => '<@&111111111111111111>'], 'Corp', 'AB');
$p = discord_payload($ctx);
check('new hole: default text', $p['content'], '<@&111111111111111111> New hole in the chain: **ABC\\-123** K162 in **AB · J163701** to J152820 (C5), mapped by *Scout*' . "\n<" . discord_map_url(C3) . '>');
check('new hole: pings only what the admin wrote', $p['allowed_mentions'], discord_allowed_mentions($tpl['chainHole'], '<@&111111111111111111>'));
$home = discord_payload(discord_chain_hole_context($h(1, $HOME, 5, ['type' => '????']), 'a', $HOME, ['template' => '{where}|{hole}|{to}', 'ping' => ''], 'Corp', ''));
check('new hole: in home, unknown type and far side', $home['content'], 'home|unknown type|an unknown system');
$evil = discord_payload(discord_chain_hole_context($h(1, C3, C5, ['aBy' => '@everyone <@&222222222222222222>']), 'a', $HOME, ['template' => '{pings} {mapper}', 'ping' => ''], 'Corp', '**x**'));
check('new hole: game text cannot ping', [strpos($evil['content'], "@\u{200B}everyone") !== false, strpos($evil['content'], '<@&222') === false, $evil['allowed_mentions']['parse']], [true, true, []]);
$sp = discord_payload(discord_home_static_context($st(2400), 'a', 'lt1h', 2400, ['template' => $tpl['homeStatic'], 'ping' => '@here'], 'Corp'));
check('home static: default text', $sp['content'], '@here Home static **' . $STATIC . '** (ABC\\-123) in **' . $data['systems'][$HOME]['name'] . '** is **<1h**: about 40 minutes left' . "\n<" . discord_map_url($HOME) . '>');
check('home static: EOL', strpos(discord_payload(discord_home_static_context($st(-60), 'a', 'expired', -60, ['template' => $tpl['homeStatic'], 'ping' => ''], 'Corp'))['content'], 'is **EOL**: past its lifetime') !== false, true);

// --- the poll, against the dev database ---
$db = $mysql;
const MASK = '999999981.2';
function cleanup($db) {
    $db->exec("DELETE FROM wormholes WHERE maskID = '" . MASK . "'");
    $db->exec("DELETE FROM signatures WHERE maskID = '" . MASK . "'");
    $db->exec("DELETE FROM discord_outbox WHERE maskID = '" . MASK . "'");
    $db->exec("DELETE FROM discord_sent WHERE maskID = '" . MASK . "'");
}
discord_ensure_schema($db);
cleanup($db);
$real = time();
$sigIns = $db->prepare("INSERT INTO signatures (signatureID, systemID, type, name, lifeTime, lifeLeft, lifeLength, createdByID, createdByName, modifiedByID, modifiedByName, modifiedTime, maskID)
    VALUES (?, ?, 'wormhole', NULL, ?, ?, 57600, 1, 'Scout', 1, 'Scout', NOW(), ?)");
$whIns = $db->prepare("INSERT INTO wormholes (initialID, secondaryID, type, parent, life, mass, maskID) VALUES (?, ?, ?, 'initial', ?, 'stable', ?)");
$hole = function ($a, $b, $type = 'H296', $life = 'stable', $left = 50000) use ($db, $sigIns, $whIns, $real) {
    $sigIns->execute(['aaa' . rand(100, 999), $a, date('Y-m-d H:i:s', $real - 3600), date('Y-m-d H:i:s', $real + $left), MASK]);
    $x = (int) $db->lastInsertId();
    $sigIns->execute(['bbb' . rand(100, 999), $b, date('Y-m-d H:i:s', $real - 3600), date('Y-m-d H:i:s', $real + $left), MASK]);
    $y = (int) $db->lastInsertId();
    $whIns->execute([$x, $y, $type, $life, MASK]);
    return (int) $db->lastInsertId();
};
$settings = function (array $hole = [], array $static = []) use ($HOME) {
    $s = discord_settings_defaults(98000001);
    $s['homeSystemID'] = $HOME;
    $s['types']['chainHole'] = $hole + ['enabled' => true, 'webhookID' => 7, 'enabledAt' => 1, 'homeOnly' => false] + $s['types']['chainHole'];
    $s['types']['homeStatic'] = $static + ['enabled' => true, 'webhookID' => 7, 'enabledAt' => 1] + $s['types']['homeStatic'];
    return $s;
};
$queued = function ($kind) use ($db) {
    return array_map(function ($r) { return json_decode($r, true); }, $db->query("SELECT data FROM discord_outbox WHERE maskID = '" . MASK . "' AND kind = '$kind' ORDER BY id")->fetchAll(PDO::FETCH_COLUMN));
};

$first = $hole($HOME, C5);
check('poll: nothing without a mask', discord_chain_alerts_poll($db, [], $real), 0);
check('poll: no home, nothing', discord_chain_alerts_poll($db, [MASK => ['homeSystemID' => 0] + $settings()], $real), 0);
check('poll: the first poll records what is there (baseline)', [discord_chain_alerts_poll($db, [MASK => $settings()], $real), count($queued('chainHole'))], [0, 0]);
$second = $hole(C5, C3);
check('poll: a new hole on the chain is posted once', [discord_chain_alerts_poll($db, [MASK => $settings()], $real), discord_chain_alerts_poll($db, [MASK => $settings()], $real + 15)], [1, 0]);
$q = $queued('chainHole');
check('poll: the message', [$q[0]['where'], $q[0]['system'], $q[0]['hole'], $q[0]['to'], $q[0]['wormholeID']], ['the chain', 'J152820', 'H296', 'J163701 (C5)', $second]);
$hole(C3, LS);
check('poll: homeOnly skips a hole elsewhere (recorded, never posted later)', [discord_chain_alerts_poll($db, [MASK => $settings(['homeOnly' => true])], $real), discord_chain_alerts_poll($db, [MASK => $settings()], $real)], [0, 0]);
$hole($HOME, 0 + 5);
$n = discord_chain_alerts_poll($db, [MASK => $settings(['homeOnly' => true])], $real);
$q = $queued('chainHole');
check('poll: a hole in home with an unknown far side', [$n, $q[count($q) - 1]['where'], $q[count($q) - 1]['to']], [1, 'home', 'an unknown system']);
check('poll: another home is another baseline', [discord_chain_alerts_poll($db, [MASK => ['homeSystemID' => C5] + $settings()], $real), (int) $db->query("SELECT COUNT(*) FROM discord_sent WHERE maskID = '" . MASK . "' AND kind = 'choleBase'")->fetchColumn()], [0, 1]);
$db->prepare('DELETE FROM wormholes WHERE id = ?')->execute([$first]);
discord_chain_alerts_poll($db, [MASK => ['homeSystemID' => C5] + $settings()], $real);
check('poll: a hole gone from the map is forgotten', (int) $db->query("SELECT COUNT(*) FROM discord_sent WHERE maskID = '" . MASK . "' AND kind = 'chole' AND ref = 'wh:$first'")->fetchColumn(), 0);
discord_outbox_prune($db);
check('prune keeps the seen holes and the baseline', (int) $db->query("SELECT COUNT(*) FROM discord_sent WHERE maskID = '" . MASK . "' AND kind IN ('chole', 'choleBase')")->fetchColumn() > 0, true);

// Home static
cleanup($db);
$static = $hole($HOME, C5, $STATIC, 'critical', 2400);
$hole($HOME, C3, 'K162', 'critical', 600);            // not a static
check('poll: the home static <1h, once', [discord_chain_alerts_poll($db, [MASK => $settings(['enabled' => false])], $real), discord_chain_alerts_poll($db, [MASK => $settings(['enabled' => false])], $real + 15)], [1, 0]);
$q = $queued('homeStatic');
check('poll: the static message', [$q[0]['state'], $q[0]['hole'], $q[0]['wormholeID']], ['<1h', $STATIC, $static]);
check('poll: ... then EOL', discord_chain_alerts_poll($db, [MASK => $settings(['enabled' => false])], $real + 2500), 1);
check('poll: dedupe refs', $db->query("SELECT ref FROM discord_sent WHERE maskID = '" . MASK . "' AND kind = 'hstatic' ORDER BY ref")->fetchAll(PDO::FETCH_COLUMN),
    ["wh:$static:expired", "wh:$static:lt1h"]);
cleanup($db);
$hole($HOME, C5, $STATIC, 'critical', 2400);
check('poll: <1h reached before the type was turned on is not posted', discord_chain_alerts_poll($db, [MASK => $settings(['enabled' => false], ['enabledAt' => $real])], $real), 0);

cleanup($db);
fwrite(STDOUT, ($failures ? 'FAILED' : 'OK') . ": $count checks, $failures failures\n");
exit($failures ? 1 : 0);
