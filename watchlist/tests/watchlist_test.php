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
    'bSys' => '31001882', 'bSig' => 'abc123'], $data);
check('link from row', $link, ['wormholeID' => 12, 'a' => 31002238, 'b' => 31001882, 'type' => 'H296', 'size' => 'XL', 'aSig' => 'kkk162', 'bSig' => 'abc123',
    'typedSide' => 'b']);
$unknown = watchlist_link_from_row(['wormholeID' => 13, 'type' => '????', 'parent' => 'initial', 'aSys' => '31002238', 'aSig' => '', 'bSys' => '5', 'bSig' => ''], $data);
check('link from row: unknown type and generic far side', [$unknown['type'], $unknown['size'], $unknown['b'], $unknown['typedSide']], [null, null, null, 'a']);

// --- the Discord type: which matches are new (remembered per filter, system and hole), and the message ---
$HOME = 31002238; $WR = 31001882; $C2 = 31000702;
$links = [
    ['wormholeID' => 1, 'a' => $HOME, 'b' => $WR, 'type' => 'H296', 'size' => 'XL', 'aSig' => 'abc123', 'bSig' => '', 'typedSide' => 'a'],
    ['wormholeID' => 3, 'a' => $C2, 'b' => $HOME, 'type' => 'N062', 'size' => 'L', 'aSig' => 'nnn062', 'bSig' => 'kkk162', 'typedSide' => 'a'],
    ['wormholeID' => 4, 'a' => $WR, 'b' => $C2, 'type' => null, 'size' => null, 'aSig' => 'www111', 'bSig' => '', 'typedSide' => 'a'],
];
$filters = [
    ['id' => 'fa', 'name' => 'C5 WR', 'enabled' => true, 'conditions' => ['classes' => ['C5'], 'effects' => ['Wolf-Rayet Star']], 'updatedAt' => 100],
    ['id' => 'fb', 'name' => 'Big C5 holes', 'enabled' => true, 'conditions' => ['whLeadsTo' => 'C5', 'minSize' => 'XL'], 'updatedAt' => 100],
    ['id' => 'fc', 'name' => 'Near me', 'enabled' => true, 'conditions' => ['classes' => ['C2'], 'maxJumpsMe' => 3], 'updatedAt' => 100],
    ['id' => 'fd', 'name' => 'Off', 'enabled' => false, 'conditions' => ['classes' => ['C2']], 'updatedAt' => 100],
    ['id' => 'fe', 'name' => 'C2', 'enabled' => true, 'conditions' => ['classes' => ['C2']], 'updatedAt' => 100],
];
check('discord matches: holes of each match (ascending), jump filters and disabled filters skipped',
    array_map(function ($m) { return [$m[0]['id'], $m[1], $m[2]]; }, discord_watchlist_matches($filters, $links, $data)),
    [['fa', $WR, [1, 4]], ['fb', $HOME, [1]], ['fb', $WR, [1]], ['fe', $C2, [3, 4]]]);
check('discord matches: no filters, no links', [discord_watchlist_matches([], $links, $data), discord_watchlist_matches($filters, [], $data)], [[], []]);

// SQLite stands in for MySQL: the worker's records (fork_watchlist_baseline / fork_watchlist_seen) and the outbox
$wl = new PDO('sqlite::memory:');
$wl->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$wl->sqliteCreateFunction('UTC_TIMESTAMP', function () { return gmdate('Y-m-d H:i:s'); }, 0);
$wl->exec('CREATE TABLE fork_watchlist_baseline (maskID TEXT, filterID TEXT, stamp TEXT, createdAt TEXT, PRIMARY KEY (maskID, filterID))');
$wl->exec('CREATE TABLE fork_watchlist_seen (maskID TEXT, filterID TEXT, systemID INTEGER, wormholeID INTEGER, createdAt TEXT, PRIMARY KEY (maskID, filterID, systemID, wormholeID))');
$wl->exec("CREATE TABLE discord_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, maskID TEXT, webhookID INTEGER, kind TEXT, priority INTEGER, data TEXT,
    status TEXT, attempts INTEGER DEFAULT 0, nextAttemptAt TEXT, createdAt TEXT, sentAt TEXT, lastError TEXT DEFAULT '')");
$wlMask = '98000001.2';
$wlFilters = [$filters[0], $filters[4]];   // C5 WR (J122515), C2 (J150627)
// One poll as the worker does it (sync, then queue and record each announced match); the systems announced
$wlData = $cases['data'];   // plus more C2s
$wlData['systems'][31000703] = ['name' => 'J100703', 'security' => -1, 'regionID' => 11000007, 'class' => 2];
$wlData['systems'][31000704] = ['name' => 'J100704', 'security' => -1, 'regionID' => 11000007, 'class' => 2];
foreach ([31000705, 31000706, 31000707, 31000708] as $id) $wlData['systems'][$id] = ['name' => 'J' . ($id - 30900000), 'security' => -1, 'regionID' => 11000007, 'class' => 2];   // the home chain checks
$wlData = watchlist_index($wlData);
// The chain: what $links connect to $home (the worker walks the mask's live holes, discord_chain_systems; same walk)
$chainOf = function (array $links, $home) {
    $pairs = [];
    foreach ($links as $l) if ($l['a'] && $l['b']) $pairs[] = [$l['a'], $l['b']];
    return discord_chain_walk($pairs, $home);
};
$poll = function (array $filters, array $links, $enabledAt = 1000, $home = 31002238, $mask = null) use ($wl, $wlMask, $wlData, $chainOf) {
    $wlMask = $mask ?? $wlMask;
    $out = [];
    foreach (discord_watchlist_sync($wl, $wlMask, $filters, $links, $wlData, $enabledAt, $home, $chainOf($links, $home)) as [$filter, $systemID, $link, $ids]) {
        $claim = function () use ($wl, $wlMask, $filter, $systemID, $ids) { return discord_watchlist_claim($wl, $wlMask, $filter['id'], $systemID, $ids); };
        if (discord_enqueue_once($wl, $wlMask, 1, 'watchlist', ['filter' => $filter['name'], 'hole' => $link['wormholeID']], $claim) === null) continue;
        $out[] = $filter['id'] . ':' . $systemID . ':' . $link['wormholeID'];
    }
    return $out;
};
$queuedCount = function () use ($wl) { return (int) $wl->query('SELECT COUNT(*) FROM discord_outbox')->fetchColumn(); };
$C2b = 31000703;   // another C2 for "a new hole"
$moreC2 = ['wormholeID' => 7, 'a' => $HOME, 'b' => $C2b, 'type' => null, 'size' => null, 'aSig' => 'ccc222', 'bSig' => '', 'typedSide' => 'a'];

check('discord new: turning the type on records what is on the chain, announces nothing', $poll($wlFilters, $links), []);
check('discord new: and nothing on the next polls either', [$poll($wlFilters, $links), $poll($wlFilters, $links), $queuedCount()], [[], [], 0]);
// "Edited": an edit rewrites the signatures' modifiedTime and may swap or rename them; the link (wormhole) stays
$edited = $links;
$edited[0]['aSig'] = 'zzz999';
$edited[0]['size'] = 'XL';
check('discord new: an edited old hole is not announced', $poll($wlFilters, $edited), []);
// The dedupe rows of the outbox (discord_sent) expire after DISCORD_DEDUPE_KEEP days; these records don't
$wl->exec("UPDATE fork_watchlist_seen SET createdAt = '2020-01-01 00:00:00'");
check('discord new: a link older than the dedupe retention is not announced again', $poll($wlFilters, $links), []);
check('discord new: a new hole after the baseline is announced once', [$poll($wlFilters, array_merge($links, [$moreC2])), $poll($wlFilters, array_merge($links, [$moreC2])), $queuedCount()],
    [['fe:' . $C2b . ':7'], [], 1]);
$second = ['wormholeID' => 8, 'a' => $HOME, 'b' => $WR, 'type' => null, 'size' => null, 'aSig' => 'ddd333', 'bSig' => '', 'typedSide' => 'a'];
check('discord new: a second way into a system already matched is not news', $poll($wlFilters, array_merge($links, [$moreC2, $second])), []);
// The hole into the second C2 collapses: forgotten; the system reached again through a new wormhole is new
check('discord new: a collapsed link is forgotten', [$poll($wlFilters, $links),
    (int) $wl->query("SELECT COUNT(*) FROM fork_watchlist_seen WHERE wormholeID IN (7, 8)")->fetchColumn()], [[], 0]);
$again = ['wormholeID' => 9] + $moreC2;
check('discord new: ... and a new hole there later is announced', $poll($wlFilters, array_merge($links, [$again])), ['fe:' . $C2b . ':9']);
check('discord new: one of two holes into a matched system collapsing, or another one appearing, is not news',
    [$poll($wlFilters, array_merge([$links[0], $links[2]], [$again])), $poll($wlFilters, array_merge($links, [$again]))], [[], []]);
$newC2 = ['wormholeID' => 10] + $moreC2;
$saved = $wlFilters;
$saved[1]['updatedAt'] = 200;   // the C2 filter saved again
check('discord new: saving a filter records the chain again without announcing', $poll($saved, array_merge($links, [$again, $newC2])), []);
check('discord new: ... then new holes are announced again', $poll($saved, array_merge($links, [$again, $newC2, ['wormholeID' => 11, 'b' => 31000704] + $moreC2])),
    ['fe:31000704:11']);
$paused = $saved;
$paused[1]['enabled'] = false;
check('discord new: a paused filter is forgotten', [$poll($paused, $links),
    (int) $wl->query("SELECT COUNT(*) FROM fork_watchlist_seen WHERE filterID = 'fe'")->fetchColumn(),
    (int) $wl->query("SELECT COUNT(*) FROM fork_watchlist_baseline WHERE filterID = 'fe'")->fetchColumn()], [[], 0, 0]);
$reenabled = $saved;   // turned on again (public/watchlist.php also moves updatedAt; even without it there is no baseline)
check('discord new: turned on again, what is on the chain is not announced', $poll($reenabled, array_merge($links, [$moreC2])), []);
check('discord new: turning the type off and on again re-baselines', [$poll($reenabled, array_merge($links, [$moreC2, $newC2]), 5000),
    $poll($reenabled, array_merge($links, [$moreC2, $newC2]), 5000)], [[], []]);
check('discord new: no filters forgets everything', [$poll([], []), (int) $wl->query('SELECT COUNT(*) FROM fork_watchlist_seen')->fetchColumn(),
    (int) $wl->query('SELECT COUNT(*) FROM fork_watchlist_baseline')->fetchColumn()], [[], 0, 0]);
check('discord new: claim records the holes once', [discord_watchlist_claim($wl, $wlMask, 'fx', $WR, [1, 4]), discord_watchlist_claim($wl, $wlMask, 'fx', $WR, [1, 4])], [true, false]);

// --- the Discord type only counts the chain connected to the mask's home system (as chain kills do) ---
check('discord matches: only systems in the chain', array_map(function ($m) { return [$m[0]['id'], $m[1]]; },
    discord_watchlist_matches($filters, $links, $data, [$HOME => true, $WR => true])), [['fa', $WR], ['fb', $HOME], ['fb', $WR]]);
check('discord matches: an empty chain (no home) matches nothing', discord_watchlist_matches($filters, $links, $data, []), []);
check('discord stamp: the home system is part of it', [discord_watchlist_stamp(['updatedAt' => 100], 1000, $HOME), discord_watchlist_stamp(['updatedAt' => 100], 1000)],
    ['1000:100:' . $HOME, '1000:100:0']);
// Home H (J115405) - C2a; an old fragment C2b - C2c that nothing connects to home (the hole to it collapsed and was deleted)
$hcMask = '98000002.2';
$C2a = 31000702; $C2c = 31000704; $C2d = 31000708;
$hc = function ($id, $a, $b) { return ['wormholeID' => $id, 'a' => $a, 'b' => $b, 'type' => null, 'size' => null, 'aSig' => 'h' . $id, 'bSig' => '', 'typedSide' => 'a']; };
$hcFilters = [$filters[4]];   // C2
$hcBase = [$hc(21, $HOME, $C2a), $hc(22, $C2b, $C2c)];
$hcPoll = function (array $links, $home = 31002238, $enabledAt = 1000) use ($poll, $hcFilters, $hcMask) { return $poll($hcFilters, $links, $enabledAt, $home, $hcMask); };
$hcSeen = function () use ($wl, $hcMask) { return array_map('intval', $wl->query("SELECT systemID FROM fork_watchlist_seen WHERE maskID = '$hcMask' ORDER BY systemID")->fetchAll(PDO::FETCH_COLUMN)); };
check('home chain: the baseline records only the chain\'s matches, not the fragment\'s', [$hcPoll($hcBase), $hcSeen()], [[], [$C2a]]);
check('home chain: a new hole in the detached fragment is not announced (nor recorded)', [$hcPoll(array_merge($hcBase, [$hc(23, $C2c, $C2d)])), $hcSeen()], [[], [$C2a]]);
$hcJoined = array_merge($hcBase, [$hc(23, $C2c, $C2d), $hc(24, $C2a, $C2b)]);
check('home chain: the fragment connected to home later, still matching: its systems are announced then',
    $hcPoll($hcJoined), ['fe:' . $C2b . ':22', 'fe:' . $C2c . ':22', 'fe:' . $C2d . ':23']);
check('home chain: ... once', $hcPoll($hcJoined), []);
check('home chain: cut off again and reconnected by a new hole while its holes stay: not news again',
    [$hcPoll(array_merge($hcBase, [$hc(23, $C2c, $C2d)])), $hcPoll(array_merge($hcBase, [$hc(23, $C2c, $C2d), $hc(25, $HOME, $C2b)]))], [[], []]);
check('home chain: no home set: nothing announced, even a new hole from the old home', [$hcPoll(array_merge($hcBase, [$hc(26, $HOME, 31000705)]), 0),
    $wl->query("SELECT stamp FROM fork_watchlist_baseline WHERE maskID = '$hcMask'")->fetchColumn()], [[], '1000:100:0']);
check('home chain: no home set: nothing recorded either', $hcSeen(), []);
check('home chain: setting a home records its chain without announcing', [$hcPoll(array_merge($hcBase, [$hc(26, $HOME, 31000705)])), $hcSeen()], [[], [$C2a, 31000705]]);
check('home chain: moving home (another chain) re-baselines without announcing, the old chain no longer counts',
    [$hcPoll(array_merge($hcBase, [$hc(26, $HOME, 31000705)]), $C2b), $hcSeen(), $hcPoll(array_merge($hcBase, [$hc(26, $HOME, 31000705), $hc(27, $HOME, 31000706)]), $C2b)],
    [[], [$C2b, $C2c], []]);
check('home chain: ... a new hole on the new chain is announced', $hcPoll(array_merge($hcBase, [$hc(28, $C2c, 31000706)]), $C2b), ['fe:31000706:28']);
// Records made before the home was part of the stamp ("enabledAt:updatedAt") re-baseline once, silently
$wl->exec("UPDATE fork_watchlist_baseline SET stamp = '1000:100' WHERE maskID = '$hcMask'");
check('home chain: stamps from before the upgrade re-baseline silently', [$hcPoll(array_merge($hcBase, [$hc(28, $C2c, 31000706), $hc(29, $C2b, 31000707)]), $C2b),
    $wl->query("SELECT stamp FROM fork_watchlist_baseline WHERE maskID = '$hcMask'")->fetchColumn()], [[], '1000:100:' . $C2b]);

// --- static data from public/js/combine.js (what the browser matches with) ---
$app = watchlist_data_from_combine(__DIR__ . '/../../public/js/combine.js');
check('combine.js: systems, wormhole types, regions', [count($app['systems']) > 8000, isset($app['wormholes']['H296']), $app['regions'][10000002] ?? null],
    [true, true, 'The Forge']);
check('combine.js: a system', $app['systems'][31001882], ['name' => 'J122515', 'security' => -0.99, 'regionID' => 11000024, 'constellationID' => 21000232,
    'class' => 5, 'effect' => 'Wolf-Rayet Star', 'statics' => ['H296']]);
check('combine.js: a wormhole type', $app['wormholes']['H296'], ['leadsTo' => 'Class-5', 'jump' => 2000000000.0]);
check('combine.js: missing file', watchlist_data_from_combine(__DIR__ . '/missing.js'), []);
$full = watchlist_index($app);
check('combine.js: matches like the shared data', [watchlist_class_keys($full['systems'][30000142]), watchlist_leads_to_keys('Class-5', $full), $full['byName']['JITA']['regionID']],
    [['HS'], ['C5'], 10000002]);

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
