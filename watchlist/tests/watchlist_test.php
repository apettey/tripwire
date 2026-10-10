<?php
// Fork-owned: tests for the server-side watchlist (no database, no network).
//   docker compose -f docker-compose.dev.yml exec -T app php watchlist/tests/watchlist_test.php
// The matcher runs the shared cases in watchlist/tests/cases.json, which the browser's matcher must pass too
// (app/js-test/fork/watchlist.test.js).
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

require_once(__DIR__ . '/../../discord/discord.inc.php');

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
/** JSON form, so {} and [] and key order compare like the browser's */
function json($value) { return json_encode($value); }
discord_log_sink(function ($m) {});

$cases = json_decode(file_get_contents(__DIR__ . '/cases.json'), true);
$data = watchlist_index($cases['data']);

// --- the shared cases ---
foreach ($cases['normaliseFilter'] as $i => $c) {
    $out = watchlist_normalise_filter($c['in']);
    check("normaliseFilter $i", json($out), json($c['out']));
}
foreach ($cases['normaliseFilters'] as $i => $c) {
    check("normaliseFilters $i", array_map(function ($f) { return $f['id']; }, watchlist_normalise_filters($c['in'])), $c['out']);
}
foreach ($cases['classKeys'] as $i => $c) {
    $system = array_key_exists('systemID', $c) ? $data['systems'][$c['systemID']] : $c['system'];
    check("classKeys $i", watchlist_class_keys($system), $c['keys']);
}
foreach ($cases['leadsTo'] as $c) check('leadsTo ' . $c['leadsTo'], watchlist_leads_to_keys($c['leadsTo'], $data), $c['keys']);
foreach ($cases['sizeOf'] as $c) check('sizeOf ' . $c['jump'], watchlist_size_of($c['jump']), $c['size']);
foreach ($cases['entries'] as $i => $c) {
    $entries = watchlist_entries_from_links($c['chain']['systems'], $c['chain']['links']);
    check("entries $i", array_map(function ($e) { return ['systemID' => $e['systemID'], 'connections' => array_map(function ($x) { return $x['wormholeID']; }, $e['connections'])]; }, $entries), $c['out']);
    $types = [];
    foreach ($entries as $e) foreach ($e['connections'] as $x) $types[$x['wormholeID']] = $x['type'];
    $expectedTypes = $c['types'];
    ksort($types);
    ksort($expectedTypes);
    check("entries $i types", $types, $expectedTypes);
}
foreach ($cases['match'] as $c) {
    $filters = watchlist_normalise_filters($c['filters']);
    $matches = watchlist_match($filters, watchlist_entries_from_links($c['chain']['systems'], $c['chain']['links']), $data);
    check('match: ' . $c['name'], array_map(function ($m) { return ['key' => $m['key'], 'filterID' => $m['filterID'], 'systemID' => $m['systemID'], 'wormholeIDs' => $m['wormholeIDs']]; }, $matches), $c['expected']);
}

// --- validation of an admin's filter (public/watchlist.php) ---
[$f, $errors] = watchlist_validate_filter(['name' => ' C5 WR ', 'conditions' => ['classes' => ['C5'], 'effects' => ['Wolf-Rayet Star'], 'whType' => 'h296']], [], $data, 'Admin', 1000);
check('validate: ok', [$errors, $f['name'], $f['conditions'], $f['updatedAt'], $f['updatedBy'], $f['enabled'], (bool) preg_match('/^f[0-9a-f]{10}$/', $f['id'])],
    [[], 'C5 WR', ['classes' => ['C5'], 'effects' => ['Wolf-Rayet Star'], 'whType' => 'H296'], 1000, 'Admin', true, true]);
[$f, $errors] = watchlist_validate_filter(['id' => 'abc', 'name' => 'x', 'enabled' => false, 'conditions' => ['classes' => ['C1']], 'updatedAt' => 5], [['id' => 'abc']], $data, 'A', 2000);
check('validate: keeps the ID of an existing filter, never the request\'s time', [$f['id'], $f['enabled'], $f['updatedAt']], ['abc', false, 2000]);
[$f] = watchlist_validate_filter(['id' => 'zzz', 'name' => 'x', 'conditions' => ['classes' => ['C1']]], [['id' => 'abc']], $data, 'A');
check('validate: an unknown ID gets a new one', $f['id'] !== 'zzz', true);
[$f, $errors] = watchlist_validate_filter(['name' => '', 'conditions' => ['systemID' => 31009999, 'regionID' => 10000999, 'whType' => 'K162', 'staticType' => 'X999']], [], $data, 'A');
check('validate: errors', [$f, $errors], [null, ['Give the filter a name', 'Unknown system', 'Unknown region', 'Unknown wormhole type X999', 'Unknown wormhole type K162']]);
[$f, $errors] = watchlist_validate_filter(['name' => 'x', 'conditions' => ['bogus' => 1]], [], $data, 'A');
check('validate: no conditions', $errors, ['Add at least one condition']);
[$f, $errors] = watchlist_validate_filter(['name' => str_repeat('n', 61), 'conditions' => ['classes' => ['C1']]], [], $data, 'A');
check('validate: long name', $errors, ['Name is too long (max 60 characters)']);
[$f, $errors] = watchlist_validate_filter(['name' => 'x', 'conditions' => ['constellationID' => 21000280, 'constellationRef' => 30000142]], [], $data, 'A');
check('validate: a constellation reference outside the constellation is dropped', [$errors, $f['conditions']], [[], ['constellationID' => 21000280]]);
check('public filters: no who/when', json(watchlist_public_filters([['id' => 'a', 'name' => 'n', 'enabled' => true, 'conditions' => [], 'updatedAt' => 1, 'updatedBy' => 'x']])),
    '[{"id":"a","name":"n","enabled":true,"conditions":{}}]');
check('uses location', [watchlist_uses_location(['maxJumpsMe' => 0]), watchlist_uses_location(['maxJumpsHome' => 3]), watchlist_uses_location(['classes' => ['C1']])], [true, true, false]);

// --- links from the database rows ---
$link = watchlist_link_from_row(['wormholeID' => '12', 'type' => 'h296', 'parent' => 'secondary', 'aSys' => '31002238', 'aSig' => 'kkk162',
    'bSys' => '31001882', 'bSig' => 'abc123', 'changed' => '2026-10-10 12:00:00'], $data);
check('link from row', $link, ['wormholeID' => 12, 'a' => 31002238, 'b' => 31001882, 'type' => 'H296', 'size' => 'XL', 'aSig' => 'kkk162', 'bSig' => 'abc123',
    'typedSide' => 'b', 'changed' => '2026-10-10 12:00:00']);
$unknown = watchlist_link_from_row(['wormholeID' => 13, 'type' => '????', 'parent' => 'initial', 'aSys' => '31002238', 'aSig' => '', 'bSys' => '5', 'bSig' => '', 'changed' => 'x'], $data);
check('link from row: unknown type and generic far side', [$unknown['type'], $unknown['size'], $unknown['b'], $unknown['typedSide']], [null, null, null, 'a']);

// --- the Discord type: which matches are new, and the message ---
$HOME = 31002238; $WR = 31001882; $C2 = 31000702;
$links = [
    ['wormholeID' => 1, 'a' => $HOME, 'b' => $WR, 'type' => 'H296', 'size' => 'XL', 'aSig' => 'abc123', 'bSig' => '', 'typedSide' => 'a', 'changed' => '2026-10-10 12:00:00'],
    ['wormholeID' => 3, 'a' => $C2, 'b' => $HOME, 'type' => 'N062', 'size' => 'L', 'aSig' => 'nnn062', 'bSig' => 'kkk162', 'typedSide' => 'a', 'changed' => '2026-10-10 10:00:00'],
    ['wormholeID' => 4, 'a' => $WR, 'b' => $C2, 'type' => null, 'size' => null, 'aSig' => 'www111', 'bSig' => '', 'typedSide' => 'a', 'changed' => '2026-10-10 13:00:00'],
];
$t = function ($text) { return strtotime($text . ' UTC'); };
$filters = [
    ['id' => 'fa', 'name' => 'C5 WR', 'enabled' => true, 'conditions' => ['classes' => ['C5'], 'effects' => ['Wolf-Rayet Star']], 'updatedAt' => 0],
    ['id' => 'fb', 'name' => 'Big C5 holes', 'enabled' => true, 'conditions' => ['whLeadsTo' => 'C5', 'minSize' => 'XL'], 'updatedAt' => 0],
    ['id' => 'fc', 'name' => 'Near me', 'enabled' => true, 'conditions' => ['classes' => ['C2'], 'maxJumpsMe' => 3], 'updatedAt' => 0],
    ['id' => 'fd', 'name' => 'Off', 'enabled' => false, 'conditions' => ['classes' => ['C2']], 'updatedAt' => 0],
    ['id' => 'fe', 'name' => 'C2', 'enabled' => true, 'conditions' => ['classes' => ['C2']], 'updatedAt' => $t('2026-10-10 11:00:00')],
];
$refs = function ($candidates) { return array_map(function ($c) { return $c[3]; }, $candidates); };
check('discord: oldest hole of the match, jump filters and disabled filters skipped', $refs(discord_watchlist_candidates($filters, $links, $data, $t('2026-10-10 09:00:00'), 'UTC')),
    ['wl:fa:31001882:1', 'wl:fb:31002238:1', 'wl:fb:31001882:1']);
check('discord: holes from before the type was turned on are not news', $refs(discord_watchlist_candidates($filters, $links, $data, $t('2026-10-10 12:30:00'), 'UTC')), []);
check('discord: nor from before the filter was saved (C2 reached at 10:00, filter saved at 11:00)',
    $refs(discord_watchlist_candidates([$filters[4]], $links, $data, 0, 'UTC')), []);
$filters[4]['updatedAt'] = $t('2026-10-10 09:00:00');
check('discord: the C2 filter with its oldest hole', $refs(discord_watchlist_candidates([$filters[4]], $links, $data, 0, 'UTC')), ['wl:fe:31000702:3']);
check('discord: no filters, no links', [discord_watchlist_candidates([], $links, $data, 0), discord_watchlist_candidates($filters, [], $data, 0)], [[], []]);

discord_graph(null);   // the real gate graph for names and regions
$type = ['enabled' => true, 'webhookID' => 1, 'template' => discord_default_templates()['watchlist'], 'ping' => '<@&111111111111111111>', 'enabledAt' => 1];
$ctx = discord_watchlist_context(['name' => 'C5 WR'], $WR, $links[0], $type, 'Corp', $data);
check('discord context: the sig in the system it is off, typed on that side', [$ctx['system'], $ctx['class'], $ctx['effect'], $ctx['security'], $ctx['sig'], $ctx['hole'], $ctx['from']],
    ['J122515', 'C5', 'Wolf-Rayet', null, 'ABC-123', 'H296', 'J115405']);
$back = discord_watchlist_context(['name' => 'x'], $HOME, $links[0], $type, 'Corp', $data);
check('discord context: seen from the other side it is the K162', [$back['sig'], $back['hole'], $back['from']], ['???', 'K162', 'J122515']);
$payload = discord_payload($ctx);
check('discord payload: text', $payload['content'], "<@&111111111111111111> Watchlist **C5 WR**: **J122515** (C5, Wolf\\-Rayet, E\\-R00024), through ABC\\-123 H296 in J115405\n<" . discord_app_url() . "?system=J122515>");
check('discord payload: only the configured ping', $payload['allowed_mentions'], ['parse' => [], 'roles' => ['111111111111111111']]);
check('discord payload: embed', [$payload['embeds'][0]['title'], $payload['embeds'][0]['color'], $payload['embeds'][0]['fields'][0]['value']],
    ['Watchlist: C5 WR', 0x4fc3f7, 'ABC\\-123 H296 in J115405']);
$evil = discord_payload(discord_watchlist_context(['name' => '@everyone <@&999999999999999999> **x**'], $WR, $links[0], array_merge($type, ['ping' => '']), 'Corp', $data));
check('discord payload: a filter name never pings or formats', [strpos($evil['content'], '@everyone') === false, strpos($evil['content'], '<@&999') === false,
    strpos($evil['content'], '**x**') === false, $evil['allowed_mentions'], strpos($evil['embeds'][0]['title'], '@everyone') === false],
    [true, true, true, ['parse' => []], true]);
$type['ping'] = '';
$noEffect = discord_payload(discord_watchlist_context(['name' => 'C2'], $C2, $links[1], $type, 'Corp', $data));
check('discord payload: no effect, no empty separator', strpos($noEffect['content'], '**J150627** (C2, ' . discord_escape(discord_region_name(discord_system($C2)[2])) . ')') !== false, true);

// --- settings: the type is a normal Discord type ---
$defaults = discord_settings_defaults(98000001);
check('settings: default off', [$defaults['types']['watchlist']['enabled'], $defaults['types']['watchlist']['template']], [false, discord_default_templates()['watchlist']]);
[$s, $errors] = discord_settings_normalise(['types' => ['watchlist' => ['enabled' => true, 'webhookID' => 7, 'ping' => '@here', 'template' => 'x {filter}']]], $defaults, [7]);
check('settings: on with a webhook', [$errors, $s['types']['watchlist']['enabled'], $s['types']['watchlist']['ping'], $s['types']['watchlist']['template'], isset($s['types']['watchlist']['minIsk'])],
    [[], true, '@here', 'x {filter}', false]);
[$s, $errors] = discord_settings_normalise(['types' => ['watchlist' => ['enabled' => true]]], $defaults, [7]);
check('settings: needs a webhook', [$errors, $s['types']['watchlist']['enabled']], [['watchlist: pick a webhook to enable it'], false]);
check('placeholders', array_keys(discord_placeholders()['watchlist']), ['pings', 'mask', 'system', 'security', 'class', 'region', 'map', 'dotlan', 'filter', 'effect', 'details', 'sig', 'hole', 'from']);

echo "$count checks, $failures failed\n";
exit($failures ? 1 : 0);
