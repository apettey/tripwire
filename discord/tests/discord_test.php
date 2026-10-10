<?php
// Fork-owned: tests for the pure parts of the Discord notifications (no database, no network; Discord is faked).
//   docker compose -f docker-compose.dev.yml exec -T app php discord/tests/discord_test.php
if (php_sapi_name() !== 'cli') { http_response_code(404); exit(); }

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
$logged = [];
discord_log_sink(function ($m) use (&$logged) { $logged[] = $m; });

$token = str_repeat('Ab_-9', 14);   // 70 characters
$id = '123456789012345678';

// --- webhook URLs ---
$p = discord_webhook_parse("https://discord.com/api/webhooks/$id/$token");
check('webhook: discord.com', [$p['id'], $p['token'], $p['threadID']], [$id, $token, null]);
check('webhook: discordapp.com normalised', discord_webhook_parse("https://discordapp.com/api/webhooks/$id/$token")['url'], "https://discord.com/api/webhooks/$id/$token");
check('webhook: canary + v10', discord_webhook_parse("https://canary.discord.com/api/v10/webhooks/$id/$token/")['id'], $id);
check('webhook: ptb', discord_webhook_parse("https://ptb.discord.com/api/webhooks/$id/$token") !== null, true);
check('webhook: thread', discord_webhook_parse("https://discord.com/api/webhooks/$id/$token?thread_id=223456789012345678")['url'], "https://discord.com/api/webhooks/$id/$token?thread_id=223456789012345678");
check('webhook: surrounding spaces', discord_webhook_parse("  https://discord.com/api/webhooks/$id/$token \n") !== null, true);
foreach ([
    'http' => "http://discord.com/api/webhooks/$id/$token",
    'other host' => "https://discord.com.evil.example/api/webhooks/$id/$token",
    'lookalike' => "https://evildiscord.com/api/webhooks/$id/$token",
    'extra path' => "https://discord.com/api/webhooks/$id/$token/slack",
    'other query' => "https://discord.com/api/webhooks/$id/$token?wait=true",
    'short id' => "https://discord.com/api/webhooks/123/$token",
    'user info' => "https://x@discord.com/api/webhooks/$id/$token",
    'not a string' => null,
] as $label => $bad) check("webhook rejected: $label", discord_webhook_parse($bad), null);
check('webhook hint', discord_webhook_hint("https://discord.com/api/webhooks/$id/$token"), '…/5678');
check('send url', discord_webhook_send_url("https://discord.com/api/webhooks/$id/$token", 'https://discord.com/api'), "https://discord.com/api/webhooks/$id/$token?wait=true");
check('send url with thread', discord_webhook_send_url("https://discord.com/api/webhooks/$id/$token?thread_id=223456789012345678", 'https://discord.com/api'),
    "https://discord.com/api/webhooks/$id/$token?wait=true&thread_id=223456789012345678");

// --- dev API base override: local hosts only ---
check('api base: default', discord_api_base(''), 'https://discord.com/api');
check('api base: compose service', discord_api_base('http://discord-mock:8080/api'), 'http://discord-mock:8080/api');
check('api base: localhost', discord_api_base('http://127.0.0.1:9095/api/'), 'http://127.0.0.1:9095/api');
check('api base: public host ignored', discord_api_base('https://collector.example.com/api'), 'https://discord.com/api');
check('api base: other scheme ignored', discord_api_base('file:///etc/passwd'), 'https://discord.com/api');

// --- secrets at rest ---
$url = "https://discord.com/api/webhooks/$id/$token";
$key = discord_secret_key('correct horse battery staple');
$sealed = discord_seal($url, $key);
check('crypto: sealed is not the URL', strpos($sealed, $token) === false && strpos($sealed, 'v1:') === 0, true);
check('crypto: round trip', discord_unseal($sealed, $key), $url);
check('crypto: two seals differ (random nonce)', discord_seal($url, $key) !== $sealed, true);
check('crypto: wrong key', discord_unseal($sealed, discord_secret_key('another key')), null);
check('crypto: no key', discord_unseal($sealed, null), null);
check('crypto: plain without key', discord_unseal(discord_seal($url, null), null), $url);
check('crypto: damaged', discord_unseal('v1:AAAA', $key), null);

// --- templates, escaping, mentions ---
check('escape: markdown', discord_escape('*bold* _x_ ~~s~~ `c` |sp| > q # [l](u)'),
    '\\*bold\\* \\_x\\_ \\~\\~s\\~\\~ \\`c\\` \\|sp\\| \\> q \\# \\[l\\]\\(u\\)');
check('escape: @everyone cannot ping', discord_escape('@everyone'), "@\u{200B}everyone");
check('escape: role mention cannot ping', strpos(discord_escape('<@&123456789012345678>'), '<@&') === false, true);
check('escape: line breaks', discord_escape("a\nb"), 'a b');
check('render: values escaped, raw kept, unknown kept', discord_render('{pings} {victim} {zkill} {nope}',
    ['pings' => '<@&111111111111111111>', 'victim' => '@here *Bob*', 'zkill' => '<https://zkillboard.com/kill/1/>'], ['pings', 'zkill']),
    "<@&111111111111111111> @\u{200B}here \\*Bob\\* <https://zkillboard.com/kill/1/> {nope}");
check('render: empty placeholder collapses spaces', discord_render('{pings} Kill', ['pings' => ''], ['pings']), 'Kill');
check('render: truncated to 2000', mb_strlen(discord_render(str_repeat('x', 2500), [])), 2000);
check('mentions: only what the admin wrote', discord_allowed_mentions('{pings} hi <@&222222222222222222> <@333333333333333333>', '<@&111111111111111111> @here'),
    ['parse' => ['everyone'], 'roles' => ['222222222222222222', '111111111111111111'], 'users' => ['333333333333333333']]);
check('mentions: none', discord_allowed_mentions('Kill {victim}', ''), ['parse' => []]);
check('ping: valid', discord_ping_normalise(' <@&111111111111111111>   @here '), '<@&111111111111111111> @here');
check('ping: text refused', discord_ping_normalise('hello @here'), null);
check('ping: empty', discord_ping_normalise(''), '');
check('isk', [discord_isk(1234567890), discord_isk(254300000), discord_isk(12500), discord_isk(999), discord_isk(1.5e12)], ['1.23b', '254m', '12.5k', '999', '1.5t']);
check('security text', [discord_security_text(0.946), discord_security_text(0.45), discord_security_text(0.04), discord_security_text(-0.43), discord_security_text(0)],
    ['0.9', '0.5', '0.1', '-0.4', '0.0']);

// A kill whose game data tries to ping and format: nothing leaks into allowed_mentions
$payload = discord_payload(['kind' => 'corpLoss', 'template' => '{pings} Loss: {victim} lost a {ship}', 'ping' => '<@&111111111111111111>',
    'mask' => 'Corp', 'system' => 'Jita', 'security' => 0.946, 'class' => 'HS', 'region' => 'The Forge', 'killID' => 5,
    'victim' => '@everyone <@&999999999999999999>', 'victimID' => 90000001, 'ship' => 'Ibis', 'shipTypeID' => 601, 'corp' => 'C', 'value' => 10000,
    'attackers' => 3, 'zkill' => 'https://zkillboard.com/kill/5/', 'time' => 1791633600]);
check('payload: allowed_mentions from the template only', $payload['allowed_mentions'], ['parse' => [], 'roles' => ['111111111111111111']]);
check('payload: victim neutralised', strpos($payload['content'], '@everyone') === false && strpos($payload['content'], '<@&999') === false, true);
check('payload: embed thumbnail', $payload['embeds'][0]['thumbnail']['url'], 'https://images.evetech.net/types/601/render?size=128');
check('payload: embed link', $payload['embeds'][0]['url'], 'https://zkillboard.com/kill/5/');
check('payload: loss colour', $payload['embeds'][0]['color'], 0xe74c3c);
$kp = discord_payload(['kind' => 'kspace', 'template' => discord_default_templates()['kspace'], 'ping' => '', 'mask' => 'Corp',
    'system' => 'Dodixie', 'security' => 0.87, 'class' => 'HS', 'region' => 'Sinq Laison', 'map' => 'https://tw.example/?system=Dodixie',
    'dotlan' => 'https://evemaps.dotlan.net/map/Sinq_Laison/Dodixie', 'hubs' => [['Jita', 6], ['Amarr', 9]], 'sig' => 'ABC-123',
    'hole' => 'K162', 'from' => 'J123456', 'mapper' => 'Some_Pilot', 'time' => 1791633600]);
check('payload: k-space content', $kp['content'], 'New k-space connection: **Dodixie** (HS 0.9, Sinq Laison), 6 jumps from Jita. Hole ABC\\-123 in J123456, mapped by Some\\_Pilot.');
check('payload: k-space jumps table', strpos($kp['embeds'][0]['fields'][2]['value'], "Jita                   6\nAmarr                  9") !== false, true);

// --- routes: the safe-route rule on a small graph ---
// H(hs) - B(hs) - L(ls) - X(hs);  H - Zarzakh - Y(hs);  H - P(Pochven, 0.7) - W(hs);  L - N(ns)
$real = discord_graph();
discord_graph(['systems' => [
    30000001 => ['H', 0.9, 1, 3, 0, [30000002, 30100000, 30000006]],
    30000002 => ['B', 0.5, 1, 3, 0, [30000001, 30000003]],
    30000003 => ['L', 0.3, 1, 1, 0, [30000002, 30000004, 30000008]],
    30000004 => ['X', 0.8, 1, 3, 0, [30000003]],
    30100000 => ['Zarzakh', -1, 2, 1, 0, [30000001, 30000005]],
    30000005 => ['Y', 0.7, 1, 3, 0, [30100000]],
    30000006 => ['P', 0.7, 3, 5, 0, [30000001, 30000007]],
    30000007 => ['W', 0.9, 1, 3, 0, [30000006]],
    30000008 => ['N', -0.2, 1, 1, 0, [30000003]],
], 'regions' => [1 => 'R']]);
$d = discord_safe_distances(30000001);
check('route: high-sec neighbour', $d[30000002] ?? null, 1);
check('route: low-sec destination is fine', $d[30000003] ?? null, 2);
check('route: never through low-sec', isset($d[30000004]) || isset($d[30000008]), false);
check('route: Zarzakh as destination only', [$d[30100000] ?? null, isset($d[30000005])], [1, false]);
check('route: not through Pochven', [$d[30000006] ?? null, isset($d[30000007])], [1, false]);
$fromLow = discord_safe_distances(30000003);
check('route: start may be low-sec', [$fromLow[30000002] ?? null, $fromLow[30000001] ?? null, $fromLow[30000004] ?? null, $fromLow[30000008] ?? null], [1, 2, 1, 1]);
check('hubs: in range, closest first', discord_hubs_in_range(30000002, [30000003, 30000001], 10), [['H', 1, 30000001], ['L', 1, 30000003]]);
check('hubs: threshold is "fewer than"', [discord_hubs_in_range(30000003, [30000001], 2), discord_hubs_in_range(30000003, [30000001], 3)], [[], [['H', 2, 30000001]]]);
check('hubs: unreachable', discord_hubs_in_range(30000004, [30000001], 50), []);
discord_graph($real);

// Real data
check('real: Jita is high-sec k-space', [discord_is_kspace(30000142), discord_system_class(30000142), discord_passable(30000142)], [true, 'HS', true]);
check('real: Zarzakh never passable', discord_passable(30100000), false);
check('real: J-space is not k-space', [discord_is_kspace(31000005), discord_system_class(31000005)], [false, 'Thera']);
check('real: Jita - Perimeter', discord_safe_distances(30000142)[30000144] ?? null, 1);
check('real: Amarr reachable from Jita on high-sec', (discord_safe_distances(30000142)[30002187] ?? 0) > 5, true);
check('real: dotlan link', discord_dotlan_url(30000142), 'https://evemaps.dotlan.net/map/The_Forge/Jita');

// --- k-space candidates ---
$row = ['wormholeID' => 7, 'type' => 'N110', 'parent' => 'initial',
    'aID' => 1, 'aSys' => 31000123, 'aSig' => 'abc123', 'aBy' => 'Scout', 'aName' => ' AB ', 'bID' => 2, 'bSys' => 30000142, 'bSig' => 'xyz789', 'bBy' => 'Jumper', 'bName' => ''];
check('candidates: k-space side, hole in the J-space system', discord_kspace_candidates($row),
    [['systemID' => 30000142, 'sigRowID' => 2, 'via' => 31000123, 'viaSig' => 'ABC-123', 'hole' => 'N110', 'mapper' => 'Jumper', 'label' => 'AB']]);
check('candidates: no label when the k-space side is named (a hole out) or the far side is a return bookmark',
    [discord_kspace_candidates(['bName' => 'C'] + $row)[0]['label'], discord_kspace_candidates(['aName' => '!A'] + $row)[0]['label'], discord_kspace_candidates(['bName' => '!A'] + $row)[0]['label'],
     discord_kspace_candidates(['bName' => '<A'] + $row)[0]['label']], ['', '', 'AB', 'AB']);
check('candidates: no label without a name on the far side', discord_kspace_candidates(['aName' => null] + $row)[0]['label'], '');
check('candidates: K162 side', discord_kspace_candidates(['parent' => 'secondary'] + $row)[0]['hole'], 'K162');
check('candidates: unknown far side', discord_kspace_candidates(['bSys' => 3] + $row), []);
check('candidates: J-space only', discord_kspace_candidates(['bSys' => 31000200] + $row), []);
check('sig text', [discord_sig_text('abc123'), discord_sig_text(''), discord_sig_text('ab')], ['ABC-123', '???', 'AB']);

// --- settings ---
$defaults = discord_settings_defaults(98000001);
check('settings: defaults off, our corp', [$defaults['types']['kspace']['enabled'], $defaults['corporations'], $defaults['types']['kspace']['pingSystems']], [false, [98000001], [30000142, 30002187]]);
[$s, $errors] = discord_settings_normalise(['types' => [
    'kspace' => ['enabled' => true, 'webhookID' => 5, 'pingSystems' => ['30002659', 31000005, 30000142, 'x'], 'maxJumps' => 99, 'ping' => '@here'],
    'chainKill' => ['enabled' => true, 'webhookID' => 0],
    'corpLoss' => ['enabled' => true, 'webhookID' => 9, 'ping' => 'everyone!', 'minIsk' => '1000000'],
]], $defaults, [5, 6]);
check('settings: ping systems k-space only', $s['types']['kspace']['pingSystems'], [30002659, 30000142]);
check('settings: max jumps clamped', $s['types']['kspace']['maxJumps'], 50);
check('settings: k-space enabled', [$s['types']['kspace']['enabled'], $s['types']['kspace']['ping']], [true, '@here']);
check('settings: enabling needs a webhook', $s['types']['chainKill']['enabled'], false);
check('settings: unknown webhook refused', [$s['types']['corpLoss']['webhookID'], $s['types']['corpLoss']['enabled']], [0, false]);
check('settings: bad ping refused', $s['types']['corpLoss']['ping'], '');
check('settings: errors reported (unknown webhook, two without a webhook, bad ping)', count($errors), 4);
check('mask entities: the mask\'s corporation', discord_mask_entities(98000001), [98000001, 0]);

// --- kills ---
$now = time();
$kill = ['killmail_id' => 555, 'hash' => 'h', 'zkb' => ['totalValue' => 50000000, 'npc' => false], 'esi' => [
    'killmail_time' => gmdate('Y-m-d\TH:i:s\Z', $now - 60), 'solar_system_id' => 31000123,
    'victim' => ['character_id' => 90000001, 'corporation_id' => 98000009, 'ship_type_id' => 601],
    'attackers' => [['character_id' => 90000002, 'corporation_id' => 98000001, 'ship_type_id' => 100, 'final_blow' => true],
        ['corporation_id' => 1000125, 'ship_type_id' => 3885]],
]];
$facts = discord_kill_facts($kill);
check('kill facts', [$facts['killID'], $facts['systemID'], $facts['pilots'], $facts['finalBlow']['character'], $facts['victim']['ship']], [555, 31000123, 1, 90000002, 601]);
check('kill: live', discord_kill_is_live($facts, $now), true);
check('kill: old kills are not news', discord_kill_is_live(['time' => $now - 3600] + $facts, $now), false);
check('kill facts: junk', discord_kill_facts(['killmail_id' => 1]), null);
$ks = discord_settings_defaults(98000001);
foreach (['chainKill' => 1, 'corpKill' => 2, 'corpLoss' => 3] as $kind => $hook) { $ks['types'][$kind]['enabled'] = true; $ks['types'][$kind]['webhookID'] = $hook; }
$chain = [31000123 => true];
check('classify: our kill in the chain', discord_classify_kill($facts, $ks, $chain), ['corpKill' => 2, 'chainKill' => 1]);
check('classify: not in the chain', discord_classify_kill($facts, $ks, []), ['corpKill' => 2]);
$loss = $facts; $loss['victim']['corporation'] = 98000001;
check('classify: our loss (not also a kill)', discord_classify_kill($loss, $ks, []), ['corpLoss' => 3]);
$ally = $facts; $ally['victim']['alliance'] = 99000001;
check('classify: alliance counts as ours (a loss, even with our attacker)', discord_classify_kill($ally, ['alliances' => [99000001]] + $ks, []), ['corpLoss' => 3]);
$same = $ks; $same['types']['chainKill']['webhookID'] = 2;
check('classify: one message per webhook, most specific wins', discord_classify_kill($facts, $same, $chain), ['corpKill' => 2]);
$npc = ['npc' => true] + $facts;
check('classify: NPC kills skipped by default', discord_classify_kill($npc, $ks, $chain), []);
$withNpc = $ks; $withNpc['types']['chainKill']['includeNpc'] = true;
check('classify: NPC kills when asked', discord_classify_kill($npc, $withNpc, $chain), ['chainKill' => 1]);
$pod = $facts; $pod['victim']['ship'] = 670;
$noPods = $ks; $noPods['types']['chainKill']['excludePods'] = true;
check('classify: pods excluded', discord_classify_kill($pod, $noPods, $chain), ['corpKill' => 2]);
$rich = $ks; $rich['types']['corpKill']['minIsk'] = 1e9;
check('classify: minimum value', discord_classify_kill($facts, $rich, $chain), ['chainKill' => 1]);
$off = $ks; $off['types']['corpKill']['enabled'] = false;
check('classify: disabled type', discord_classify_kill($facts, $off, []), []);
$data = discord_kill_data('corpKill', $facts, $ks['types']['corpKill'], 'Corp');
check('kill data: name IDs', discord_kill_name_ids($data), [90000001, 98000009, 601, 90000002, 98000001]);
$ctx = discord_kill_context($data, [90000001 => 'Victim', 601 => 'Ibis']);
check('kill context: names and fallbacks', [$ctx['victim'], $ctx['ship'], $ctx['corp'], $ctx['finalblow'], $ctx['zkill']],
    ['Victim', 'Ibis', 'Unknown corporation', 'Unknown pilot', 'https://zkillboard.com/kill/555/']);

// --- dispatch: responses from a fake Discord ---
discord_limits_reset();
$t = 1000.0;
$r = discord_handle_response('webhook:1', 204, [], '', 0, $t);
check('response: sent', $r['result'], 'sent');
$r = discord_handle_response('webhook:1', 200, ['x-ratelimit-remaining' => '0', 'x-ratelimit-reset-after' => '1.5'], '{}', 0, $t);
check('response: exhausted bucket pauses the webhook', [$r['result'], round(discord_wait('webhook:1', $t), 1), discord_wait('webhook:2', $t)], ['sent', 1.5, 0.0]);
discord_limits_reset();
$r = discord_handle_response('webhook:1', 429, ['retry-after' => '9'], '{"message":"You are being rate limited.","retry_after":2.5,"global":false}', 0, $t);
check('response: 429 per webhook', [$r['result'], $r['delay'], discord_wait('webhook:1', $t), discord_wait('webhook:2', $t)], ['ratelimited', 2.5, 2.5, 0.0]);
discord_limits_reset();
$r = discord_handle_response('webhook:1', 429, ['x-ratelimit-global' => 'true'], '{"retry_after":4,"global":true}', 0, $t);
check('response: global 429 pauses everything', [$r['result'], discord_wait('webhook:2', $t)], ['ratelimited', 4.0]);
discord_limits_reset();
$r = discord_handle_response('webhook:1', 429, ['retry-after' => '30'], '<html>Cloudflare</html>', 0, $t);
check('response: HTML 429 (Cloudflare) is global', [$r['delay'], discord_wait('webhook:9', $t)], [30.0, 30.0]);
discord_limits_reset();
check('response: 404 breaks the webhook', discord_handle_response('webhook:1', 404, [], '{"message":"Unknown Webhook","code":10015}', 0, $t),
    ['result' => 'broken', 'delay' => 0, 'error' => 'HTTP 404: Unknown Webhook (10015)']);
check('response: 401 breaks the webhook', discord_handle_response('webhook:1', 401, [], '{"message":"Invalid Webhook Token","code":50027}', 0, $t)['result'], 'broken');
check('response: 500 retries with backoff', [discord_handle_response('webhook:1', 500, [], '', 0, $t)['delay'], discord_handle_response('webhook:1', 503, [], '', 3, $t)['delay']], [5, 40]);
check('response: network error retries', discord_handle_response('webhook:1', 0, [], 'Could not resolve host', 1, $t)['result'], 'retry');
check('response: gives up after the last attempt', discord_handle_response('webhook:1', 502, [], '', DISCORD_MAX_ATTEMPTS - 1, $t)['result'], 'failed');
check('response: 400 fails the message only', discord_handle_response('webhook:1', 400, [], '{"message":"Cannot send an empty message","code":50006}', 0, $t)['result'], 'failed');
check('retry delay capped', discord_retry_delay(20), 900);

// The transport sees the exact JSON that would go to Discord
$sent = [];
discord_http_transport(function ($url, $body) use (&$sent) { $sent[] = [$url, json_decode($body, true)]; return [204, '', []]; });
[$status] = discord_http_post(discord_webhook_send_url($url, 'https://discord.com/api'), $payload);
check('transport: status', $status, 204);
check('transport: url', $sent[0][0], "https://discord.com/api/webhooks/$id/$token?wait=true");
check('transport: allowed_mentions sent', $sent[0][1]['allowed_mentions'], ['parse' => [], 'roles' => ['111111111111111111']]);
discord_http_transport(null, true);

// --- review round 1 ---
// Dev API base: only localhost, 127.0.0.0/8, ::1 and the dev fake's service name
check('api base: integer IP refused', discord_api_base('http://2130706433/api'), 'https://discord.com/api');
check('api base: short 127 form refused', discord_api_base('http://127.1/api'), 'https://discord.com/api');
check('api base: other single-label name refused', discord_api_base('http://collector:8080/api'), 'https://discord.com/api');
check('api base: bad octet refused', discord_api_base('http://127.0.0.300/api'), 'https://discord.com/api');
check('api base: ::1', discord_api_base('http://[::1]:9095/api'), 'http://[::1]:9095/api');
check('api base: localhost', discord_api_base('http://localhost:9095/api'), 'http://localhost:9095/api');

// @here / @everyone only as words of their own
check('mentions: address is not @here', discord_allowed_mentions('mail ops@here.com or x@everyone'), ['parse' => []]);
check('mentions: @here at the end of a sentence', discord_allowed_mentions('Heads up @here.'), ['parse' => ['everyone']]);
check('mentions: @everyone, in a line', discord_allowed_mentions("Kill!\n@everyone, form up"), ['parse' => ['everyone']]);

// J-space: no security value, the class instead
$jp = discord_payload(['kind' => 'chainKill', 'template' => '{system} {class} [{security}]', 'ping' => '', 'mask' => 'Corp', 'system' => 'J160650',
    'security' => null, 'class' => 'C3', 'region' => 'R', 'killID' => 1, 'value' => 1, 'time' => 1791633600]);
check('J-space: embed shows the class only', $jp['embeds'][0]['description'], 'J160650 (C3), R');
check('J-space: {security} is empty', $jp['content'], 'J160650 C3 []');
check('J-space: kill context has no security', discord_kill_context(discord_kill_data('chainKill', $facts, $ks['types']['chainKill'], 'Corp'), [])['security'], null);
check('k-space: kill context keeps security', discord_kill_context(['systemID' => 30000142] + discord_kill_data('chainKill', $facts, $ks['types']['chainKill'], 'Corp'), [])['security'], 0.946);

// Chain kills: high-sec only when asked
$hsKill = ['systemID' => 30000142] + $facts;
$hsChain = [30000142 => true];
check('chain kill in high-sec: skipped by default', discord_classify_kill($hsKill, $ks, $hsChain), ['corpKill' => 2]);
$withHs = $ks; $withHs['types']['chainKill']['includeHighsec'] = true;
check('chain kill in high-sec: when asked', discord_classify_kill($hsKill, $withHs, $hsChain), ['corpKill' => 2, 'chainKill' => 1]);
check('chain kill in low-sec: always', discord_classify_kill(['systemID' => 30002813] + $facts, $ks, [30002813 => true]), ['corpKill' => 2, 'chainKill' => 1]);
check('settings: includeHighsec only on chain kills', [array_key_exists('includeHighsec', discord_settings_defaults()['types']['chainKill']),
    array_key_exists('includeHighsec', discord_settings_normalise(['types' => ['corpKill' => ['includeHighsec' => true]]], discord_settings_defaults())[0]['types']['corpKill'])], [true, false]);

// enabledAt: nothing from before a type was turned on
$late = $ks; $late['types']['corpKill']['enabledAt'] = $facts['time'] + 10;
check('kill from before the type was turned on', discord_classify_kill($facts, $late, $chain), ['chainKill' => 1]);
$off = discord_settings_defaults(98000001);
$on = $off; $on['types']['kspace']['enabled'] = true; $on['types']['kspace']['webhookID'] = 1;
$stamped = discord_settings_stamp($on, $off, 5000);
check('stamp: turned on now', [$stamped['types']['kspace']['enabledAt'], $stamped['types']['chainKill']['enabledAt']], [5000, 0]);
check('stamp: staying on keeps the time', discord_settings_stamp($on, $stamped, 9000)['types']['kspace']['enabledAt'], 5000);
check('stamp: browser cannot set it', discord_settings_stamp(discord_settings_normalise(['types' => ['kspace' => ['enabled' => true, 'webhookID' => 1, 'enabledAt' => 1]]], $off)[0], $off, 7000)['types']['kspace']['enabledAt'], 7000);
check('stamp: off is 0', discord_settings_stamp($off, $stamped, 9000)['types']['kspace']['enabledAt'], 0);
check('app time: UTC', discord_app_time(1791633600, 'UTC'), '2026-10-10 12:00:00');
check('app time: other zone', discord_app_time(1791633600, 'Europe/Berlin'), '2026-10-10 14:00:00');
check('k-space change after enable', [discord_kspace_after_enable('2026-10-10 12:00:01', 1791633600, 'UTC'),
    discord_kspace_after_enable('2026-10-10 11:59:59', 1791633600, 'UTC'), discord_kspace_after_enable('2000-01-01 00:00:00', 0, 'UTC')], [true, false, true]);

// Only corporation masks and corporation-owned custom masks (review round 2)
check('mask kind', array_map('discord_mask_kind', ['98000001.2', '12345.0', '99000001.3', '196379789.1', '0.0', '', 'x.2', '98000001.2 ']),
    ['corp', 'custom', null, null, null, null, null, null]);
check('mask corporation: corp mask', discord_mask_corporation('98000001.2'), 98000001);
check('mask corporation: custom mask owned by a corporation', discord_mask_corporation('12345.0', [98000001, 2]), 98000001);
check('mask corporation: personal custom mask refused', discord_mask_corporation('12345.0', [90000001, 1373]), null);
check('mask corporation: alliance-owned custom mask refused', discord_mask_corporation('12345.0', [99000001, 3]), null);
check('mask corporation: unknown custom mask refused', discord_mask_corporation('12345.0', null), null);
check('mask corporation: alliance, private, public refused', [discord_mask_corporation('99000001.3'), discord_mask_corporation('196379789.1'), discord_mask_corporation('0.0')], [null, null, null]);

// Circuit breakers: per webhook (50), per mask (150), everything (2000) over 10 minutes
discord_limits_reset();
$logged = [];
$t0 = 50000.0;
$hookA = ['mask:98000001.2', 'webhook:1'];
for ($i = 0; $i < 49; $i++) discord_breaker_record($i % 2 ? 404 : 429, $t0 + $i * 0.1, $hookA);
check('breaker: below the webhook limit', [discord_scope_wait('webhook:1', $t0 + 60), count($logged)], [0.0, 0]);
check('breaker: 5xx and successes do not count', [discord_breaker_record(503, $t0 + 60, $hookA), discord_breaker_record(204, $t0 + 60, $hookA)], [[], []]);
check('breaker: webhook trips at 50', discord_breaker_record(400, $t0 + 60, $hookA), ['webhook:1']);
check('breaker: that webhook paused until its oldest refusal is 10 min old', round(discord_scope_wait('webhook:1', $t0 + 60), 1), 540.0);
check('breaker: other webhooks, the mask and everyone else go on', [discord_scope_wait('webhook:2', $t0 + 60), discord_scope_wait('mask:98000001.2', $t0 + 60), discord_wait('webhook:any', $t0 + 60)], [0.0, 0.0, 0.0]);
check('breaker: logged loudly', count($logged) === 1 && strpos($logged[0], 'CIRCUIT BREAKER (webhook:1)') === 0, true);
for ($w = 2; $w <= 4; $w++) for ($i = 0; $i < 33; $i++) discord_breaker_record(404, $t0 + 61 + $i * 0.01, ['mask:98000001.2', "webhook:$w"]);
check('breaker: the mask trips at 150 over its webhooks', discord_breaker_record(404, $t0 + 62, ['mask:98000001.2', 'webhook:5']), ['mask:98000001.2']);
check('breaker: mask paused, another mask not', [discord_scope_wait('mask:98000001.2', $t0 + 62) > 500, discord_scope_wait('mask:98000002.2', $t0 + 62), discord_wait('webhook:x', $t0 + 62)], [true, 0.0, 0.0]);
check('breaker: refusals leave the window', discord_breaker_record(404, $t0 + 700, $hookA), []);
discord_limits_reset();
for ($i = 0; $i < 1999; $i++) discord_breaker_record(429, $t0 + $i * 0.01, ['mask:m' . ($i % 40) . '.2', 'webhook:' . $i]);
check('breaker: global last resort at 2000', [discord_wait('webhook:x', $t0 + 30), discord_breaker_record(429, $t0 + 30, ['mask:new.2', 'webhook:new'])], [0.0, ['global']]);
check('breaker: global pauses everything', discord_wait('webhook:x', $t0 + 30) > 500, true);
discord_limits_reset();

// Rate limit: record first, count, take back when over (SQLite stands in for MySQL)
$rl = new PDO('sqlite::memory:');
$rl->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$rl->sqliteCreateFunction('UTC_TIMESTAMP', function () { return gmdate('Y-m-d H:i:s'); }, 0);
$rl->exec('CREATE TABLE discord_sent (maskID TEXT, kind TEXT, ref TEXT, createdAt TEXT, PRIMARY KEY (maskID, kind, ref))');
$taken = [];
for ($i = 0; $i < 7; $i++) $taken[] = discord_rate_take($rl, '98000001.2', 'rl:test', 5, 60);
check('rate limit: 5 per window', $taken, [true, true, true, true, true, false, false]);
check('rate limit: refused attempts leave no record', (int) $rl->query("SELECT COUNT(*) FROM discord_sent")->fetchColumn(), 5);
check('rate limit: per mask', discord_rate_take($rl, '98000002.2', 'rl:test', 5, 60), true);
$rl->exec("UPDATE discord_sent SET createdAt = '2000-01-01 00:00:00'");
check('rate limit: window passes', discord_rate_take($rl, '98000001.2', 'rl:test', 5, 60), true);

// --- review round 3 ---
// Settings page status: counts, last failures (with webhook name) and open breakers, each from its own query
$st = new PDO('sqlite::memory:');
$st->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$st->exec("CREATE TABLE discord_outbox (id INTEGER PRIMARY KEY, maskID TEXT, webhookID INTEGER, kind TEXT, status TEXT, lastError TEXT, createdAt TEXT, sentAt TEXT)");
$st->exec("CREATE TABLE discord_webhooks (id INTEGER PRIMARY KEY, name TEXT)");
$st->exec("CREATE TABLE discord_sent (maskID TEXT, kind TEXT, ref TEXT, createdAt TEXT)");
$nowTs = 1791633600;   // 2026-10-10 12:00:00 UTC
$st->exec("INSERT INTO discord_webhooks VALUES (3, '#gone')");
$st->exec("INSERT INTO discord_outbox VALUES
    (1, 'M.2', 1, 'kspace', 'queued', '', '2026-10-10 11:59:00', NULL),
    (2, 'M.2', 1, 'chainKill', 'sent', '', '2026-10-10 11:00:00', '2026-10-10 11:00:05'),
    (3, 'M.2', 1, 'chainKill', 'sent', '', '2026-10-08 11:00:00', '2026-10-08 11:00:05'),
    (4, 'M.2', 3, 'corpLoss', 'failed', 'HTTP 404: Unknown Webhook (10015)', '2026-10-10 11:30:00', NULL),
    (5, 'X.2', 3, 'corpLoss', 'failed', 'other mask', '2026-10-10 11:30:00', NULL)");
$st->exec("INSERT INTO discord_sent VALUES ('M.2', 'breaker', 'webhook:3', '2026-10-10 12:05:00'), ('M.2', 'breaker', 'mask:M.2', '2026-10-10 11:55:00'),
    ('M.2', 'kill:chainKill', '123', '2026-10-10 11:00:00')");
check('status: shape and values', discord_outbox_status($st, 'M.2', $nowTs), [
    'queued' => 1, 'sent24h' => 1, 'failed24h' => 1,
    'failures' => [['id' => 4, 'kind' => 'corpLoss', 'error' => 'HTTP 404: Unknown Webhook (10015)', 'createdAt' => '2026-10-10T11:30:00Z', 'webhook' => '#gone']],
    'paused' => [['scope' => 'webhook', 'webhookID' => 3, 'until' => '2026-10-10T12:05:00Z']],
]);
check('status: empty mask', discord_outbox_status($st, 'none.2', $nowTs), ['queued' => 0, 'sent24h' => 0, 'failed24h' => 0, 'failures' => [], 'paused' => []]);

// Which masks may still send (worker settings and dispatcher backlog use the same rule)
$st->exec("CREATE TABLE masks (maskID TEXT PRIMARY KEY, ownerID INTEGER, ownerType INTEGER)");
$st->exec("CREATE TABLE characters (characterID INTEGER, corporationID INTEGER, admin INTEGER)");
$st->exec("INSERT INTO masks VALUES ('5.0', 98000001, 2), ('6.0', 90000001, 1373), ('7.0', 98000002, 2)");
$st->exec("INSERT INTO characters VALUES (1, 98000001, 1), (2, 98000002, 0)");
check('sending corporation', array_map(function ($m) use ($st) { return discord_mask_sending_corporation($st, $m); },
    ['98000001.2', '5.0', '6.0', '98000002.2', '7.0', '8.0', '196379789.1']), [98000001, 98000001, 0, 0, 0, 0, 0]);

// Corporation breaker: many masks of one corporation together, each below its own limits
discord_limits_reset();
$logged = [];
$tc = 90000.0;
for ($i = 0; $i < 399; $i++) discord_breaker_record(404, $tc + $i * 0.01, ['mask:' . ($i % 4) . '.0', 'webhook:' . $i, 'corp:98000001']);
check('breaker: corporation below 400', discord_scope_wait('corp:98000001', $tc + 10), 0.0);
check('breaker: corporation trips at 400', discord_breaker_record(404, $tc + 10, ['mask:9.0', 'webhook:x', 'corp:98000001']), ['corp:98000001']);
check('breaker: other corporations and everyone else go on', [discord_scope_wait('corp:98000002', $tc + 10), discord_wait('webhook:any', $tc + 10)], [0.0, 0.0]);
discord_limits_reset();

// --- review round 4: a corporation breaker shows on every Discord-enabled mask of the corporation ---
$st->exec("CREATE TABLE discord_settings (maskID TEXT PRIMARY KEY, settings TEXT)");
$st->exec("INSERT INTO discord_settings VALUES ('98000001.2', '{}'), ('5.0', '{}'), ('6.0', '{}'), ('7.0', '{}')");
$st->exec("DELETE FROM discord_sent WHERE kind = 'breaker'");
check('corp breaker notes: every mask of the corporation', discord_breaker_notes($st, '5.0', 'corp:98000001', 300, $nowTs), ['5.0', '98000001.2']);
check('corp breaker notes: written with the end of the pause', $st->query("SELECT maskID || '|' || ref || '|' || createdAt FROM discord_sent WHERE kind = 'breaker' ORDER BY maskID")->fetchAll(PDO::FETCH_COLUMN),
    ['5.0|corp:98000001|2026-10-10 12:05:00', '98000001.2|corp:98000001|2026-10-10 12:05:00']);
check('corp breaker notes: shown on the corp mask page', discord_outbox_status($st, '98000001.2', $nowTs)['paused'], [['scope' => 'corp', 'webhookID' => null, 'until' => '2026-10-10T12:05:00Z']]);
check('corp breaker notes: not on other corporations or personal masks', [discord_outbox_status($st, '6.0', $nowTs)['paused'], discord_outbox_status($st, '7.0', $nowTs)['paused']], [[], []]);
discord_breaker_notes($st, '5.0', 'corp:98000001', 600, $nowTs);
check('corp breaker notes: a new trip replaces the note', (int) $st->query("SELECT COUNT(*) FROM discord_sent WHERE kind = 'breaker' AND maskID = '5.0'")->fetchColumn(), 1);
check('corp breaker notes: expire with time', discord_outbox_status($st, '98000001.2', $nowTs + 601)['paused'], []);
check('webhook breaker note: only its own mask', discord_breaker_notes($st, '98000001.2', 'webhook:4', 300, $nowTs), ['98000001.2']);

// --- rally point type (discord/rally.php) ---
$rd = discord_settings_defaults(98000001)['types']['rally'];
check('rally: off by default, default texts', [$rd['enabled'], $rd['webhookID'], $rd['template'], $rd['templateClear'], $rd['ping']],
    [false, 0, discord_default_templates()['rally'], discord_default_templates()['rallyClear'], '']);
[$rs, $rerr] = discord_settings_normalise(['types' => ['rally' => ['enabled' => true, 'webhookID' => 5, 'ping' => '<@&111111111111111111>',
    'template' => "  {who} -> {system}\r\n{map} ", 'templateClear' => '', 'minIsk' => 5, 'pingSystems' => [30000142]]]], discord_settings_defaults(), [5]);
check('rally: settings kept', [$rs['types']['rally']['enabled'], $rs['types']['rally']['webhookID'], $rs['types']['rally']['ping'], $rs['types']['rally']['template'], $rerr],
    [true, 5, '<@&111111111111111111>', "{who} -> {system}\n{map}", []]);
check('rally: empty clear text falls back to the default', $rs['types']['rally']['templateClear'], discord_default_templates()['rallyClear']);
check('rally: no fields of other types', array_keys($rs['types']['rally']), ['enabled', 'webhookID', 'template', 'templateClear', 'ping', 'enabledAt']);
check('rally: a too long "cleared" text is named', discord_settings_normalise(['types' => ['rally' => ['templateClear' => str_repeat('x', 2000)]]], discord_settings_defaults())[1],
    ['rally: "cleared" text longer than ' . DISCORD_TEMPLATE_MAX . ' characters']);
check('rally: enabling needs a webhook', discord_settings_normalise(['types' => ['rally' => ['enabled' => true]]], discord_settings_defaults())[0]['types']['rally']['enabled'], false);
check('rally: long clear text cut', mb_strlen(discord_settings_normalise(['types' => ['rally' => ['templateClear' => str_repeat('x', 2000)]]], discord_settings_defaults())[0]['types']['rally']['templateClear']), DISCORD_TEMPLATE_MAX);
check('rally: type only when on with a webhook', [discord_rally_type($rs) !== null, discord_rally_type(discord_settings_defaults())], [true, null]);
check('rally: stamped like the other types', discord_settings_stamp($rs, discord_settings_defaults(), 4000)['types']['rally']['enabledAt'], 4000);
check('rally: placeholders', array_keys(discord_placeholders()['rally']), ['pings', 'mask', 'system', 'security', 'class', 'region', 'map', 'dotlan', 'label', 'labelSystem', 'who', 'time', 'rally', 'was']);
check('k-space: label placeholders', [isset(discord_placeholders()['kspace']['label']), isset(discord_placeholders()['kspace']['labelSystem']), isset(discord_placeholders()['chainKill']['label'])], [true, true, true]);   // kills too since the kill chain label

// Data queued by public/rally.php: the type's texts, who, and nothing from before the type was turned on
$rtype = ['enabledAt' => 1000] + $rs['types']['rally'];
$rdata = discord_rally_data($rtype, 'Corp', 'set', 'Chribba', 2000);
check('rally data', $rdata, ['kind' => 'rally', 'action' => 'set', 'who' => 'Chribba', 'template' => "{who} -> {system}\n{map}",
    'templateClear' => discord_default_templates()['rallyClear'], 'ping' => '<@&111111111111111111>', 'mask' => 'Corp', 'time' => 2000, 'enabledAt' => 1000]);
check('rally data: before the type was turned on', discord_rally_data($rtype, 'Corp', 'set', 'x', 999), null);
check('rally data: unknown action is a set', discord_rally_data($rtype, 'Corp', 'bogus', 'x', 2000)['action'], 'set');

// Messages: the rally as stored when sent; default texts like the first version's
$tpl = discord_default_templates();
$rbase = ['template' => $tpl['rally'], 'templateClear' => $tpl['rallyClear'], 'ping' => '', 'mask' => 'Corp', 'time' => 2000];
$wh = discord_payload(discord_rally_context(['action' => 'set', 'who' => 'Late'] + $rbase, ['systemID' => 31001880, 'setBy' => 'Chribba']));
check('rally message: wormhole', $wh['content'], "Tripwire rally point from *Chribba*: **J152820** (C5, E\\-R00024)\n<" . discord_app_url() . "?system=J152820>");
check('rally message: no embed, nobody pinged', [isset($wh['embeds']), $wh['allowed_mentions'], $wh['username']], [false, ['parse' => []], 'Tripwire']);
check('rally message: k-space', discord_payload(discord_rally_context(['action' => 'set'] + $rbase, ['systemID' => 30000142, 'setBy' => 'A']))['content'],
    "Tripwire rally point from *A*: **Jita** (HS, The Forge)\n<" . discord_app_url() . "?system=Jita>");
check('rally message: {time} is a Discord timestamp, not escaped', discord_payload(discord_rally_context(['action' => 'set', 'template' => '{who} at {time}'] + $rbase, ['systemID' => 30000142, 'setBy' => 'A']))['content'],
    'A at <t:2000:t>');
check('rally message: moved again before it was sent shows the stored rally', discord_rally_context(['action' => 'clear', 'who' => 'Clearer'] + $rbase, ['systemID' => 30000142, 'setBy' => 'Mover'])['who'], 'Mover');
check('rally message: unreadable rally, a clear is still a clear', discord_rally_context(['action' => 'clear', 'who' => 'C'] + $rbase, false)['cleared'], true);
check('rally message: unreadable rally, a set can not be shown', discord_rally_context(['action' => 'set'] + $rbase, false), null);
$hostile = discord_payload(discord_rally_context(['action' => 'set'] + $rbase, ['systemID' => 30000142, 'setBy' => "@everyone <@&999999999999999999> *x*\n[l](https://e.example)"]));
check('rally message: names cannot ping or format', [strpos($hostile['content'], '@everyone'), strpos($hostile['content'], '<@&'), strpos($hostile['content'], "\n["), $hostile['allowed_mentions']],
    [false, false, false, ['parse' => []]]);
$pingedCtx = discord_rally_context(['action' => 'set', 'ping' => '<@&111111111111111111> @here'] + $rbase, ['systemID' => 31001880, 'setBy' => 'Kytus Bos'], function () { return 'AABCA'; });
$pinged = discord_payload($pingedCtx);
check('rally message: pings from the ping field only', [$pinged['allowed_mentions'], strpos($pinged['content'], '<@&111111111111111111> @here Tripwire') === 0],
    [['parse' => ['everyone'], 'roles' => ['111111111111111111']], true]);

// The edit that ends a rally message: struck through, no pings left, nobody pinged
check('strike: pings and the link line go, each line struck', discord_rally_strike($pinged['content']),
    '~~Tripwire rally point from *Kytus Bos*: **AABCA · J152820** (C5, E\\-R00024)~~');
check('strike: several lines, mentions anywhere', discord_rally_strike("a <@333333333333333333> b\n\n@everyone c\n<https://x.example/?s=1>\nd"), "~~a b~~\n~~c~~\n~~d~~");
check('strike: escaped game data is kept as it is', discord_rally_strike("x @\u{200B}here \\<@&1\\>"), "~~x @\u{200B}here \\<@&1\\>~~");
check('strip mentions: only what an admin can write', discord_strip_mentions('<@&111111111111111111> hi <@!222222222222222222> ops@here.com @here'), 'hi ops@here.com');
check('timestamp', [discord_timestamp(1760123280), discord_timestamp('5', 'R'), discord_timestamp(5, 'x')], ['<t:1760123280:t>', '<t:5:R>', '<t:5:t>']);
$cleared = discord_payload(['previous' => $pinged['content']] + discord_rally_context(['action' => 'clear', 'who' => 'Aashai Modor', 'time' => 1760123280, 'ping' => '<@&111111111111111111> @here'] + $rbase, null));
check('rally cleared: the message struck through, who and when', $cleared,
    ['content' => "~~Tripwire rally point from *Kytus Bos*: **AABCA · J152820** (C5, E\\-R00024)~~\nCleared by *Aashai Modor* at <t:1760123280:t>", 'allowed_mentions' => ['parse' => []]]);
$moved = discord_payload(['moved' => true, 'previous' => $pinged['content']]
    + discord_rally_context(['action' => 'set', 'time' => 1760123280] + $pingedCtx, ['systemID' => 31000003, 'setBy' => 'Aashai Modor'], function () { return 'AB'; }));
check('rally moved: the old message struck through, where to, who and when', $moved,
    ['content' => "~~Tripwire rally point from *Kytus Bos*: **AABCA · J152820** (C5, E\\-R00024)~~\nMoved to **AB · " . discord_system(31000003)[0] . "** by *Aashai Modor* at <t:1760123280:t>", 'allowed_mentions' => ['parse' => []]]);
$custom = discord_payload(['previous' => $pinged['content']] + discord_rally_context(['action' => 'clear', 'who' => 'C', 'templateClear' => '{pings} @here Gone <@333333333333333333>, said {who}'] + $rbase, null));
check('rally cleared: a text without {rally} still strikes the message; its own pings are dropped', $custom,
    ['content' => "~~Tripwire rally point from *Kytus Bos*: **AABCA · J152820** (C5, E\\-R00024)~~\nGone , said C", 'allowed_mentions' => ['parse' => []]]);
check('rally cleared: {rally} where the admin puts it', discord_payload(['previous' => "@here Rally *A*\n<https://x.example/>"]
    + discord_rally_context(['action' => 'clear', 'who' => 'C', 'templateClear' => 'Over. {rally} ({who})'] + $rbase, null))['content'], 'Over. ~~Rally *A*~~ (C)');
check('rally cleared: empty text falls back to the default', discord_payload(['previous' => 'Rally'] + discord_rally_context(['action' => 'clear', 'who' => 'C', 'templateClear' => '{pings}'] + $rbase, null))['content'],
    "~~Rally~~\nCleared by *C* at <t:2000:t>");
check('rally cleared: a hostile name in the cleared line cannot ping', discord_payload(['previous' => 'Rally'] + discord_rally_context(['action' => 'clear', 'who' => '@here <@&111111111111111111>'] + $rbase, null)),
    ['content' => "~~Rally~~\nCleared by *@\u{200B}here \\<@\u{200B}&111111111111111111\\>* at <t:2000:t>", 'allowed_mentions' => ['parse' => []]]);

// What the sender does with a rally row (pure): edit in the window, post + strike after it, clear = edit or nothing
$setCtx = discord_rally_context(['action' => 'set', 'ping' => '@here', 'time' => 1100] + $rbase, ['systemID' => 31001880, 'setBy' => 'A']);
$setText = discord_payload($setCtx)['content'];
$live = ['webhookID' => 5, 'messageID' => '123', 'content' => '@here old rally', 'postedAt' => 1000];
check('plan: no message, a set posts with its pings', [discord_rally_plan($setCtx, null, 1100)['op'], discord_rally_plan($setCtx, null, 1100)['payload']['allowed_mentions'], discord_rally_plan($setCtx, null, 1100)['strike']],
    ['post', ['parse' => ['everyone']], null]);
$plan = discord_rally_plan($setCtx, $live, 1029);
check('plan: moved within 30 s edits the message, nobody pinged', [$plan['op'], $plan['live'], $plan['payload']['allowed_mentions'], isset($plan['payload']['username']), $plan['payload']['content']],
    ['edit', true, ['parse' => []], false, $setText]);
$plan = discord_rally_plan($setCtx, $live, 1030);
check('plan: moved after 30 s posts with the pings and ends the old message', [$plan['op'], $plan['payload']['allowed_mentions'], $plan['strike']['messageID'], $plan['strike']['payload']],
    ['post', ['parse' => ['everyone']], '123', ['content' => "~~old rally~~\nMoved to **J152820** by *A* at <t:1100:t>", 'allowed_mentions' => ['parse' => []]]]);
check('plan: clock skew posts', discord_rally_plan($setCtx, ['postedAt' => 1200] + $live, 1100)['op'], 'post');
check('plan: the message already shows it', discord_rally_plan($setCtx, ['content' => $setText] + $live, 1010), ['op' => 'skip', 'why' => 'the message already shows this rally']);
check('plan: the same rally set again after the window is posted again', discord_rally_plan($setCtx, ['content' => $setText] + $live, 1100)['op'], 'post');
// A rally text too long for Discord with the cleared line: the struck text is cut, the who / when line always stays
$long = discord_payload(['previous' => str_repeat('x', 1990) . "\nsecond line"] + discord_rally_context(['action' => 'clear', 'who' => 'C', 'time' => 7] + $rbase, null));
check('rally cleared: a long text is cut, the cleared line stays', [mb_strlen($long['content']) <= DISCORD_CONTENT_MAX, substr($long['content'], -26), substr($long['content'], 0, 3)],
    [true, "\nCleared by *C* at <t:7:t>", '~~x']);
$long = discord_payload(['previous' => str_repeat('x', 1990)] + discord_rally_context(['action' => 'clear', 'who' => 'C', 'time' => 7, 'templateClear' => 'Gone ({who})'] + $rbase, null));
check('rally cleared: ... also with a custom text', [mb_strlen($long['content']) <= DISCORD_CONTENT_MAX, str_ends_with($long['content'], "…~~\nGone (C)")], [true, true]);
check('rally cleared: a text of only {rally} is the default', discord_payload(['previous' => 'R'] + discord_rally_context(['action' => 'clear', 'who' => 'C', 'time' => 7, 'templateClear' => '{rally}'] + $rbase, null))['content'],
    "~~R~~\nCleared by *C* at <t:7:t>");
$clearCtx = discord_rally_context(['action' => 'clear', 'who' => 'B', 'time' => 5000] + $rbase, null);
check('plan: a clear without a message sends nothing', discord_rally_plan($clearCtx, null, 5000), ['op' => 'skip', 'why' => 'no rally message to edit']);
check('plan: a clear at any time edits the message', discord_rally_plan($clearCtx, $live, 99999),
    ['op' => 'edit', 'payload' => ['content' => "~~old rally~~\nCleared by *B* at <t:5000:t>", 'allowed_mentions' => ['parse' => []]], 'live' => false]);
// The live message: same webhook, an id and its text, posted since the type was turned on
check('live message', [discord_rally_live(null, 5), discord_rally_live($live, 5) === $live, discord_rally_live($live, 6), discord_rally_live(['messageID' => ''] + $live, 5),
    discord_rally_live(['content' => ''] + $live, 5), discord_rally_live($live, 5, 1001), discord_rally_live($live, 5, 1000) === $live], [null, true, null, null, null, null, true]);

check('edit url', discord_webhook_edit_url($url, '1234567890', 'https://discord.com/api'), "https://discord.com/api/webhooks/$id/$token/messages/1234567890");
check('edit url with thread', discord_webhook_edit_url("$url?thread_id=223456789012345678", '42', 'https://discord.com/api'), "https://discord.com/api/webhooks/$id/$token/messages/42?thread_id=223456789012345678");
check('edit url: bad message id', discord_webhook_edit_url($url, '../x', 'https://discord.com/api'), null);
check('legacy hook', [discord_rally_legacy_hook('98000001.2', ['98000001.2' => 'https://x/hook']), discord_rally_legacy_hook('98000002.2', ['98000001.2' => 'https://x/hook']),
    discord_rally_legacy_hook('98000001.2', ['98000001.2' => '']), discord_rally_legacy_hook('98000001.2', [])], ['https://x/hook', null, null, null]);

// The sender's side, against SQLite: remember / edit / repost / skipped / superseded
$rx = new PDO('sqlite::memory:');
$rx->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$rx->exec('CREATE TABLE discord_rally_message (maskID TEXT PRIMARY KEY, webhookID INTEGER, messageID TEXT, content TEXT, postedAt TEXT)');
$rx->exec("CREATE TABLE discord_outbox (id INTEGER PRIMARY KEY, maskID TEXT, kind TEXT, status TEXT)");
$rrow = ['id' => 7, 'maskID' => '98000001.2', 'webhookID' => 5, 'kind' => 'rally'];
$sendUrl = discord_webhook_send_url($url);
$req = discord_rally_request($rx, $rrow, $url, $setCtx, 1000);
check('rally send: first change posts', [$req['method'], $req['url'], $req['payload']['username']], ['POST', $sendUrl, 'Tripwire']);
$ok = ['result' => 'sent', 'delay' => 0, 'error' => ''];
check('rally send: posted message remembered with its text', [discord_rally_after_send($rx, $rrow, $req, 200, '{"id":"1111111111"}', $ok, 1000), discord_rally_last($rx, '98000001.2')],
    [$ok, ['webhookID' => 5, 'messageID' => '1111111111', 'content' => $setText, 'postedAt' => 1000]]);
$moveCtx = discord_rally_context(['action' => 'set', 'ping' => '@here', 'time' => 1020] + $rbase, ['systemID' => 30000142, 'setBy' => 'B']);
$req = discord_rally_request($rx, $rrow, $url, $moveCtx, 1020);
check('rally send: a change in the window edits it', [$req['method'], $req['url'], isset($req['payload']['username']), $req['payload']['allowed_mentions']],
    ['PATCH', discord_webhook_edit_url($url, '1111111111'), false, ['parse' => []]]);
discord_rally_after_send($rx, $rrow, $req, 200, '{"id":"1111111111"}', $ok, 1020);
check('rally send: an edit keeps the window of the post and the new text', [discord_rally_last($rx, '98000001.2')['postedAt'], discord_rally_last($rx, '98000001.2')['content']],
    [1000, discord_payload($moveCtx)['content']]);
check('rally send: after the window it posts again', discord_rally_request($rx, $rrow, $url, $setCtx, 1030)['method'], 'POST');
check('rally send: another channel posts', discord_rally_request($rx, ['webhookID' => 6] + $rrow, $url, $setCtx, 1010)['method'], 'POST');
check('rally send: a clear for another channel sends nothing', discord_rally_request($rx, ['webhookID' => 6] + $rrow, $url, $clearCtx, 1010), ['skip' => 'no rally message to edit']);
check('rally send: a clear after the type was turned on again sends nothing', discord_rally_request($rx, $rrow, $url, ['enabledAt' => 1001] + $clearCtx, 1010), ['skip' => 'no rally message to edit']);
$req = discord_rally_request($rx, $rrow, $url, $setCtx, 1020);
$broken = discord_handle_response('webhook:x', 404, [], '{"message":"Unknown Message","code":10008}', 0, 1.0);
check('rally send: edit of a deleted message reposts, the webhook is not broken',
    [discord_rally_after_send($rx, $rrow, $req, 404, '{"message":"Unknown Message","code":10008}', $broken, 1021)['result'], discord_rally_last($rx, '98000001.2')], ['repost', null]);
$gone = discord_handle_response('webhook:x', 404, [], '{"message":"Unknown Webhook","code":10015}', 0, 1.0);
check('rally send: a deleted webhook is still broken', discord_rally_after_send($rx, $rrow, $req, 404, '{"message":"Unknown Webhook","code":10015}', $gone, 1021)['result'], 'broken');
discord_rally_remember($rx, '98000001.2', 5, '2222', '@here x', 1040);
$req = discord_rally_request($rx, $rrow, $url, $clearCtx, 9000);
check('rally send: a clear of a deleted message is skipped, nothing posted',
    [$req['method'], discord_rally_after_send($rx, $rrow, $req, 404, '{"message":"Unknown Message","code":10008}', $broken, 9000)['result'], discord_rally_last($rx, '98000001.2')], ['PATCH', 'skipped', null]);
discord_rally_remember($rx, '98000001.2', 5, '2222', '@here x', 1040);
$req = discord_rally_request($rx, $rrow, $url, $clearCtx, 9000);
check('rally send: a clear forgets the message it ended', [discord_rally_after_send($rx, $rrow, $req, 200, '{"id":"2222"}', $ok, 9000), discord_rally_last($rx, '98000001.2')], [$ok, null]);
$req = discord_rally_request($rx, $rrow, $url, $setCtx, 9100);
discord_rally_after_send($rx, $rrow, $req, 200, '{}', $ok, 9100);
check('rally send: a post without an id is not edited later', discord_rally_last($rx, '98000001.2'), null);
check('rally send: a failed post changes nothing', discord_rally_after_send($rx, $rrow, $req, 500, '', ['result' => 'retry', 'delay' => 5, 'error' => 'HTTP 500'], 1050)['result'], 'retry');
$editRow = ['kind' => 'rallyEdit'] + $rrow;
$req = discord_rally_request($rx, $editRow, $url, ['messageID' => '1111111111', 'payload' => ['content' => '~~x~~', 'allowed_mentions' => ['parse' => []]]]);
check('rally send: the edit that ends a moved message', [$req['method'], $req['url'], $req['payload']['content']], ['PATCH', discord_webhook_edit_url($url, '1111111111'), '~~x~~']);
check('rally send: ... of a message deleted meanwhile is skipped', discord_rally_after_send($rx, $editRow, $req, 404, '{"message":"Unknown Message","code":10008}', $broken)['result'], 'skipped');
check('rally send: ... unreadable', discord_rally_request($rx, $editRow, $url, ['messageID' => 'x']), ['skip' => 'unreadable edit']);
discord_rally_remember($rx, '98000001.2', 5, '3333', 'a', 1060);
discord_rally_remember($rx, '98000002.2', 6, '4444', 'b', 1060);
discord_rally_forget_webhook($rx, 5);
check('rally send: a replaced webhook URL is not edited through', [discord_rally_last($rx, '98000001.2'), discord_rally_last($rx, '98000002.2')['messageID']], [null, '4444']);
$rx->exec("INSERT INTO discord_outbox VALUES (7,'98000001.2', 'rally', 'queued'), (8, '98000002.2', 'rally', 'queued'), (9, '98000001.2', 'kspace', 'queued')");
check('rally superseded: nothing newer', discord_rally_superseded($rx, $rrow), false);
$rx->exec("INSERT INTO discord_outbox VALUES (10, '98000001.2', 'rally', 'sent')");
check('rally superseded: a newer one already sent does not count', discord_rally_superseded($rx, $rrow), false);
$rx->exec("INSERT INTO discord_outbox VALUES (11, '98000001.2', 'rally', 'queued')");
check('rally superseded: a newer queued one of the mask', [discord_rally_superseded($rx, $rrow), discord_rally_superseded($rx, ['id' => 11] + $rrow)], [true, false]);
// fork_rally as stored now (missing table = unknown)
check('rally current: no table', discord_rally_current($rx, '98000001.2'), false);
$rx->exec('CREATE TABLE fork_rally (maskID TEXT PRIMARY KEY, systemID INTEGER, setBy TEXT)');
check('rally current: none', discord_rally_current($rx, '98000001.2'), null);
$rx->exec("INSERT INTO fork_rally VALUES ('98000001.2', 30000142, 'Chribba')");
check('rally current: stored', discord_rally_current($rx, '98000001.2'), ['systemID' => 30000142, 'setBy' => 'Chribba']);

// Which masks have the type (the same corporation rule as every other type)
$rx->exec('CREATE TABLE discord_settings (maskID TEXT PRIMARY KEY, settings TEXT)');
$rx->exec('CREATE TABLE masks (maskID TEXT PRIMARY KEY, ownerID INTEGER, ownerType INTEGER)');
$rx->exec('CREATE TABLE characters (characterID INTEGER, corporationID INTEGER, admin INTEGER)');
$rx->exec("INSERT INTO characters VALUES (1, 98000001, 1)");
$rx->exec("INSERT INTO masks VALUES ('6.0', 90000001, 1373)");
$on = json_encode($rs);
$offJson = json_encode(discord_settings_defaults());
$rx->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['98000001.2', $on]);
$rx->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['98000003.2', $on]);
$rx->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['6.0', $on]);
$rx->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['98000001.3', $on]);
check('rally target: corp mask with the type on', discord_rally_target($rx, '98000001.2')['webhookID'] ?? null, 5);
check('rally target: no settings, no admin left, personal or alliance mask', [discord_rally_target($rx, '98000009.2'), discord_rally_target($rx, '98000003.2'),
    discord_rally_target($rx, '6.0'), discord_rally_target($rx, '98000001.3')], [null, null, null, null]);
$rx->prepare('UPDATE discord_settings SET settings = ? WHERE maskID = ?')->execute([$offJson, '98000001.2']);
check('rally target: type off', discord_rally_target($rx, '98000001.2'), null);

// --- chain label (discord_chain_label): the name of the wormhole signature leading into a system ---
$cl = new PDO('sqlite::memory:');
$cl->exec("CREATE TABLE signatures (id INTEGER PRIMARY KEY, signatureID TEXT, systemID INTEGER, type TEXT, name TEXT, maskID TEXT)");
$cl->exec("CREATE TABLE wormholes (id INTEGER PRIMARY KEY, initialID INTEGER, secondaryID INTEGER, maskID TEXT)");
$sigID = 0;
// A wormhole of $mask from $from (signature named $fromName) to $to (signature named $toName); $swap stores it the other way round
$hole = function ($id, $from, $fromName, $to, $toName, $mask = '98000001.2', $swap = false) use ($cl, &$sigID) {
    $a = ++$sigID; $b = ++$sigID;
    $cl->prepare("INSERT INTO signatures VALUES (?, 'abc123', ?, 'wormhole', ?, ?)")->execute([$a, $from, $fromName, $mask]);
    $cl->prepare("INSERT INTO signatures VALUES (?, 'xyz789', ?, 'wormhole', ?, ?)")->execute([$b, $to, $toName, $mask]);
    $cl->prepare('INSERT INTO wormholes VALUES (?, ?, ?, ?)')->execute($swap ? [$id, $b, $a, $mask] : [$id, $a, $b, $mask]);
};
// Home 31000001 -A-> 31000002 -AB-> 31000003 -ABC-> 30000142 (Jita); a loop: 31000001 -B-> 31000005 -BAA-> 31000003
$hole(1, 31000001, 'A', 31000002, '');
$hole(2, 31000002, 'AB', 31000003, '', '98000001.2', true);         // stored with the far side as secondary
$hole(3, 31000003, ' ABC  ', 30000142, '!AB');                       // return bookmark on the near side
$hole(4, 31000001, 'B', 31000005, null);
$hole(5, 31000005, 'BAA', 31000003, '');
$hole(6, 31000003, 'X', 31000009, '', '98000002.2');                 // another mask's chain
$hole(7, 31000002, '', 30002187, '');                                // Amarr: k-space without a named hole
$cl->exec("INSERT INTO signatures VALUES (99, 'def456', 31000002, 'combat', 'Named site', '98000001.2')");
$label = function ($system, $mask = '98000001.2') use ($cl) { return discord_chain_label($cl, $mask, $system); };
check('chain label: the far side of the hole leading in', [$label(31000002), $label(31000005)], ['A', 'B']);
check('chain label: reached twice, the shorter name (closer to home) wins', $label(31000003), 'AB');
check('chain label: trimmed, a return bookmark on the near side still counts', $label(30000142), 'ABC');
check('chain label: home has none (its own holes are named on its side)', $label(31000001), '');
check('chain label: k-space without a named hole, unknown system', [$label(30002187), $label(31009999), $label(0)], ['', '', '']);
check('chain label: only the mask\'s own chain', [$label(31000009), $label(31000009, '98000002.2'), $label(31000002, '98000002.2')], ['', 'X', '']);
check('chain label: no tables is no label', discord_chain_label(new PDO('sqlite::memory:'), '98000001.2', 31000002), '');
check('chain label pick: same token length, lowest wormhole id', discord_chain_label_pick([
    ['wormholeID' => 9, 'nearName' => '', 'farName' => 'BA', 'farSystem' => 1], ['wormholeID' => 4, 'nearName' => null, 'farName' => 'AB', 'farSystem' => 2]], 3), 'AB');
check('chain label pick: a hole out (named near side) and a hole to itself are not in', discord_chain_label_pick([
    ['wormholeID' => 1, 'nearName' => 'C', 'farName' => 'Z', 'farSystem' => 1], ['wormholeID' => 2, 'nearName' => '', 'farName' => 'Y', 'farSystem' => 3]], 3), '');
check('chain label pick: a far name without a name token (return bookmark "<H", "?") is not a label', discord_chain_label_pick([
    ['wormholeID' => 1, 'nearName' => '', 'farName' => '<H', 'farSystem' => 1], ['wormholeID' => 2, 'nearName' => '', 'farName' => '?', 'farSystem' => 2],
    ['wormholeID' => 3, 'nearName' => '', 'farName' => 'AB - drifter', 'farSystem' => 4]], 3), 'AB - drifter');
check('chain label pick: a near side named as a return bookmark, "!" or the older "<", still leads in', [discord_chain_label_pick([
    ['wormholeID' => 1, 'nearName' => '!AB', 'farName' => 'AB', 'farSystem' => 1]], 3), discord_chain_label_pick([
    ['wormholeID' => 1, 'nearName' => ' <AB', 'farName' => 'AB', 'farSystem' => 1]], 3)], ['AB', 'AB']);
check('chain label pick: a far return bookmark "!H" is not a label', discord_chain_label_pick([['wormholeID' => 1, 'nearName' => '', 'farName' => '!H', 'farSystem' => 1]], 3), '');
check('return bookmark names', array_map('discord_is_return_bookmark', ['!AB', '<AB', ' !C ', 'AB', '', '?', null]), [true, true, true, false, false, false, false]);
check('chain label: one line, at most 100 characters', [discord_chain_label_clean("A\nB"), mb_strlen(discord_chain_label_clean(str_repeat('x', 300)))], ['A B', 100]);

// --- rally messages with the chain label ---
$tpl = discord_default_templates();
$rbase = ['template' => $tpl['rally'], 'templateClear' => $tpl['rallyClear'], 'ping' => '', 'mask' => 'Corp', 'time' => 2000];
$labelled = function ($id) { return 'AABCA'; };
$none = function ($id) { return ''; };
check('rally label: default text with a label', discord_payload(discord_rally_context(['action' => 'set'] + $rbase, ['systemID' => 31001880, 'setBy' => 'Chribba'], $labelled))['content'],
    "Tripwire rally point from *Chribba*: **AABCA · J152820** (C5, E\\-R00024)\n<" . discord_app_url() . "?system=J152820>");
check('rally label: without a label no separator or empty bold', discord_payload(discord_rally_context(['action' => 'set'] + $rbase, ['systemID' => 31001880, 'setBy' => 'C'], $none))['content'],
    "Tripwire rally point from *C*: **J152820** (C5, E\\-R00024)\n<" . discord_app_url() . "?system=J152820>");
check('rally label: looked up for the rally system', discord_rally_context(['action' => 'set'] + $rbase, ['systemID' => 31000003, 'setBy' => 'C'], $label)['label'], 'AB');
check('rally label: {label} on its own', discord_payload(discord_rally_context(['action' => 'set', 'template' => '{label}|{labelSystem}|{system}'] + $rbase, ['systemID' => 31001880, 'setBy' => 'C'], $labelled))['content'],
    'AABCA|AABCA · J152820|J152820');
$evil = function ($id) { return "@everyone <@&999999999999999999> **x** [l](https://e.example) `c`"; };
$hp = discord_payload(discord_rally_context(['action' => 'set'] + $rbase, ['systemID' => 31001880, 'setBy' => 'C'], $evil));
check('rally label: escaped, cannot ping, format or link', [strpos($hp['content'], '@everyone'), strpos($hp['content'], '<@&'), strpos($hp['content'], '**x'),
    strpos($hp['content'], '](https:'), strpos($hp['content'], '\\[l\\]\\(https\\:') !== false, $hp['allowed_mentions']], [false, false, false, false, true, ['parse' => []]]);
$hp = discord_payload(discord_rally_context(['action' => 'clear', 'who' => 'C', 'systemID' => 31001880] + $rbase, null, $evil));
check('rally label: escaped in the cleared text too', [strpos($hp['content'], '@everyone'), strpos($hp['content'], '<@&'), strpos($hp['content'], '**x'), $hp['allowed_mentions']], [false, false, false, ['parse' => []]]);
// Cleared: {was} names the system it was on when the clear kept it (a text with {was}; no earlier message here)
$rbase31 = ['templateClear' => 'Cleared by *{who}*{was}'] + $rbase;
check('rally cleared: with the system and label it was on', discord_payload(discord_rally_context(['action' => 'clear', 'who' => 'Chribba', 'systemID' => 31001880] + $rbase31, null, $labelled))['content'],
    'Cleared by *Chribba* (was on AABCA · J152820)');
check('rally cleared: with the system, no label', discord_payload(discord_rally_context(['action' => 'clear', 'who' => 'Chribba', 'systemID' => 31001880] + $rbase31, null, $none))['content'],
    'Cleared by *Chribba* (was on J152820)');
check('rally cleared: system unknown (queued before this version)', discord_payload(discord_rally_context(['action' => 'clear', 'who' => 'Chribba'] + $rbase31, null, $labelled))['content'],
    'Cleared by *Chribba*');
check('rally cleared: by someone else, no system', discord_payload(discord_rally_context(['action' => 'set', 'who' => 'S', 'systemID' => 31001880] + $rbase31, null, $labelled))['content'],
    'Cleared by *someone*');
check('rally cleared: the label kept at clear time wins over a lookup now', discord_payload(discord_rally_context(['action' => 'clear', 'who' => 'C', 'systemID' => 31001880, 'label' => 'AAB'] + $rbase31, null, $labelled))['content'],
    'Cleared by *C* (was on AAB · J152820)');
check('rally cleared: an empty kept label stays empty', discord_rally_context(['action' => 'clear', 'who' => 'C', 'systemID' => 31001880, 'label' => ''] + $rbase31, null, $labelled)['label'], '');
check('rally cleared: unreadable rally, the clear still names it', discord_rally_context(['action' => 'clear', 'who' => 'C', 'systemID' => 31001880] + $rbase31, false, $labelled)['label'], 'AABCA');
check('rally set message: {was} is empty', discord_payload(discord_rally_context(['action' => 'set', 'template' => 'x{was}y'] + $rbase, ['systemID' => 31001880, 'setBy' => 'C'], $labelled))['content'], 'xy');
check('rally data: a clear keeps the system it was on, a set does not', [discord_rally_data($rtype, 'Corp', 'clear', 'C', 2000, 31001880)['systemID'] ?? null,
    discord_rally_data($rtype, 'Corp', 'set', 'C', 2000, 31001880)['systemID'] ?? null, discord_rally_data($rtype, 'Corp', 'clear', 'C', 2000)['systemID'] ?? null], [31001880, null, null]);
// k-space: {label} / {labelSystem}
$kctx = ['kind' => 'kspace', 'template' => '{labelSystem} via {label}', 'ping' => '', 'mask' => 'Corp', 'system' => 'Jita', 'class' => 'HS', 'label' => 'A_B'];
check('k-space label', discord_payload($kctx)['content'], 'A\\_B · Jita via A\\_B');
check('k-space label: none', discord_payload(['label' => ''] + $kctx)['content'], 'Jita via');
check('k-space context carries the candidate label', discord_kspace_context(['systemID' => 30000142, 'via' => 31000123, 'viaSig' => 'ABC-123', 'hole' => 'K162', 'mapper' => 'M', 'label' => 'AB'],
    [['Jita', 0]], ['template' => '', 'ping' => ''], 'Corp')['label'], 'AB');

// --- default texts of earlier versions become today's (not customised); custom texts stay ---
$oldRally = "{pings} Tripwire rally point from *{who}*: **{system}** ({class}, {region})\n{map}";
$oldClear = '{pings} Tripwire rally point cleared by *{who}*';
[$mig] = discord_settings_normalise(['types' => ['rally' => ['template' => $oldRally, 'templateClear' => $oldClear]]], discord_settings_defaults());
check('migration: old default texts become the new ones', [$mig['types']['rally']['template'], $mig['types']['rally']['templateClear']], [$tpl['rally'], $tpl['rallyClear']]);
[$mig] = discord_settings_normalise(['types' => ['rally' => ['template' => str_replace("\n", "\r\n", $oldRally) . ' ', 'templateClear' => 'Gone, said {who}']]], discord_settings_defaults());
check('migration: line endings and spaces do not matter; custom texts stay', [$mig['types']['rally']['template'], $mig['types']['rally']['templateClear']], [$tpl['rally'], 'Gone, said {who}']);
[$mig] = discord_settings_normalise(['types' => ['rally' => ['template' => $oldRally . ' @here']]], discord_settings_defaults());
check('migration: an edited old default is custom', $mig['types']['rally']['template'], $oldRally . ' @here');
check('migration: other types are not touched', discord_template_upgrade('kspace', 'template', $oldRally), $oldRally);
// 1.17's (#31) cleared default, a new "cleared" message, is now the struck-through edit too
$clear31 = '{pings} Tripwire rally point cleared by *{who}*{was}';
[$mig] = discord_settings_normalise(['types' => ['rally' => ['template' => $tpl['rally'], 'templateClear' => $clear31]]], discord_settings_defaults());
check('migration: the 1.17 cleared default becomes the new one', $mig['types']['rally']['templateClear'], $tpl['rallyClear']);
[$mig] = discord_settings_normalise(['types' => ['rally' => ['templateClear' => $clear31 . '!']]], discord_settings_defaults());
check('migration: an edited 1.17 default is custom', $mig['types']['rally']['templateClear'], $clear31 . '!');
check('migration: the new default is the target rendering', $tpl['rallyClear'], "{rally}\nCleared by *{who}* at {time}");
foreach (['1.15' => $oldClear, '1.17' => $clear31] as $version => $old) {
    check("migration: queued $version rows render the new cleared edit", discord_payload(['previous' => "@here Tripwire rally point from *K*: **AABCA · J152820** (C5, E\\-R00024)\n<https://tw.example/?system=J152820>"]
        + discord_rally_context(['action' => 'clear', 'who' => 'C', 'systemID' => 31001880, 'template' => $oldRally, 'templateClear' => $old] + $rbase, null, $labelled))['content'],
        "~~Tripwire rally point from *K*: **AABCA · J152820** (C5, E\\-R00024)~~\nCleared by *C* at <t:2000:t>");
}
$cl2 = new PDO('sqlite::memory:');
$cl2->exec('CREATE TABLE discord_settings (maskID TEXT PRIMARY KEY, settings TEXT)');
$cl2->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['98000001.2', json_encode(['types' => ['rally' => ['template' => $oldRally, 'templateClear' => $oldClear]]])]);
$cl2->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['98000002.2', json_encode(['types' => ['rally' => ['templateClear' => $clear31]]])]);
$cl2->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['98000003.2', json_encode(['types' => ['rally' => ['templateClear' => 'Gone, said {who}']]])]);
check('migration: when loaded', [discord_settings_load($cl2, '98000001.2', discord_settings_defaults())['types']['rally']['templateClear'],
    discord_settings_load($cl2, '98000002.2', discord_settings_defaults())['types']['rally']['templateClear'],
    discord_settings_load($cl2, '98000003.2', discord_settings_defaults())['types']['rally']['templateClear']], [$tpl['rallyClear'], $tpl['rallyClear'], 'Gone, said {who}']);

// --- rally sequences against SQLite and a fake Discord: the sender's steps for each queued row (as discord_dispatch) ---
$sq = new PDO('sqlite::memory:');
$sq->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$sq->sqliteCreateFunction('UTC_TIMESTAMP', function () { return gmdate('Y-m-d H:i:s'); }, 0);
$sq->exec('CREATE TABLE discord_rally_message (maskID TEXT PRIMARY KEY, webhookID INTEGER, messageID TEXT, content TEXT, postedAt TEXT)');
$sq->exec("CREATE TABLE discord_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, maskID TEXT, webhookID INTEGER, kind TEXT, priority INTEGER, data TEXT,
    status TEXT, attempts INTEGER DEFAULT 0, nextAttemptAt TEXT, createdAt TEXT, sentAt TEXT, lastError TEXT DEFAULT '')");
$sq->exec('CREATE TABLE fork_rally (maskID TEXT PRIMARY KEY, systemID INTEGER, setBy TEXT)');
$seqType = ['enabled' => true, 'webhookID' => 5, 'ping' => '@here', 'enabledAt' => 1] + $tpl + ['template' => $tpl['rally'], 'templateClear' => $tpl['rallyClear']];
$channel = [];   // the fake channel: id => ['content', 'pinged' (post), 'edits' => [allowed_mentions...]]
$requests = [];
discord_http_transport(function ($u, $json, $method) use (&$channel, &$requests) {
    $body = json_decode($json, true);
    $requests[] = $method;
    if ($method === 'POST') {
        $id = (string) (1000 + count($channel));
        $channel[$id] = ['content' => $body['content'], 'pinged' => $body['allowed_mentions'], 'edits' => []];
        return [200, json_encode(['id' => $id]), []];
    }
    preg_match('~/messages/(\d+)~', $u, $m);
    if (!isset($channel[$m[1]]) || !empty($channel[$m[1]]['deleted'])) return [404, '{"message":"Unknown Message","code":10008}', []];
    $channel[$m[1]]['content'] = $body['content'];
    $channel[$m[1]]['edits'][] = $body['allowed_mentions'] ?? 'missing';
    return [200, json_encode(['id' => $m[1]]), []];
});
$seqClock = 100000;
$seqChange = function ($mode, $who, $systemID = 0) use ($sq, &$seqType, &$seqClock) {
    $previous = discord_rally_current($sq, '98000001.2');
    if ($mode === 'set') $sq->prepare('REPLACE INTO fork_rally VALUES (?, ?, ?)')->execute(['98000001.2', $systemID, $who]);
    else $sq->exec("DELETE FROM fork_rally WHERE maskID = '98000001.2'");
    discord_enqueue($sq, '98000001.2', 5, 'rally', discord_rally_data($seqType, 'Corp', $mode, $who, $seqClock, $mode === 'clear' && $previous ? $previous['systemID'] : 0), DISCORD_PRIORITY_RALLY);
};
$seqSend = function () use ($sq, $url, &$seqClock) {
    for ($pass = 0; $pass < 10; $pass++) {
        $rows = $sq->query("SELECT id, maskID, webhookID, kind, data, attempts, 0 AS age FROM discord_outbox WHERE status = 'queued' ORDER BY priority DESC, id ASC")->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) return;
        foreach ($rows as $row) {
            if ($row['kind'] === 'rally' && discord_rally_superseded($sq, $row)) { $sq->prepare('DELETE FROM discord_outbox WHERE id = ?')->execute([$row['id']]); continue; }
            $request = discord_rally_request($sq, $row, $url, discord_row_context($sq, $row), $seqClock);
            if (isset($request['skip'])) { $sq->prepare('DELETE FROM discord_outbox WHERE id = ?')->execute([$row['id']]); continue; }
            [$status, $body, $headers] = discord_http_post($request['url'], $request['payload'], $request['method']);
            $decision = discord_rally_after_send($sq, $row, $request, $status, $body, discord_handle_response('b', $status, $headers, $body, 0), $seqClock);
            if ($decision['result'] === 'repost') continue;
            if ($decision['result'] === 'skipped') $sq->prepare('DELETE FROM discord_outbox WHERE id = ?')->execute([$row['id']]);
            else $sq->prepare('UPDATE discord_outbox SET status = ? WHERE id = ?')->execute([$decision['result'], $row['id']]);
        }
    }
};
// The channel as readers see it: [content (times as <t:…>), pinged when posted]; every edit had empty allowed_mentions
$seqView = function () use (&$channel) {
    $editsQuiet = true;
    $out = array_values(array_map(function ($m) use (&$editsQuiet) {
        foreach ($m['edits'] as $e) if ($e !== ['parse' => []]) $editsQuiet = false;
        return [preg_replace('/<t:\d+:t>/', '<t:…>', $m['content']), $m['pinged'] !== ['parse' => []], count($m['edits']) > 0];
    }, array_filter($channel, function ($m) { return empty($m['deleted']); })));
    return [$out, $editsQuiet];
};
$seqReset = function () use ($sq, &$channel, &$requests, &$seqClock) {
    $sq->exec('DELETE FROM discord_rally_message'); $sq->exec('DELETE FROM discord_outbox'); $sq->exec('DELETE FROM fork_rally');
    $channel = []; $requests = []; $seqClock = 100000;
};
$A = "Tripwire rally point from *Kytus Bos*: **J163701** (C5, E\\-R00025)";
$liveA = "@here $A\n<" . discord_app_url() . '?system=J163701>';
$B = "Tripwire rally point from *Aashai Modor*: **J152820** (C5, E\\-R00024)";
$liveB = "@here $B\n<" . discord_app_url() . '?system=J152820>';
$jA = 31002012; $jB = 31001880;
check('sequence: the systems', [discord_system($jA)[0], discord_system($jB)[0]], ['J163701', 'J152820']);

$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $seqClock += 10; $seqChange('clear', 'Aashai Modor'); $seqSend();
check('sequence: set, clear within 30 s: the message struck, nothing new', $seqView(), [[["~~$A~~\nCleared by *Aashai Modor* at <t:…>", true, true]], true]);
$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $seqClock += 3300; $seqChange('clear', 'Aashai Modor'); $seqSend();
check('sequence: set, clear after 30 s: the same', $seqView(), [[["~~$A~~\nCleared by *Aashai Modor* at <t:…>", true, true]], true]);
$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $seqClock += 10; $seqChange('set', 'Aashai Modor', $jB); $seqSend();
check('sequence: set, move within 30 s: the message edited', $seqView(), [[[$liveB, true, true]], true]);
$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $seqClock += 60; $seqChange('set', 'Aashai Modor', $jB); $seqSend();
check('sequence: set, move after 30 s: a new message (pinged), the old one struck with where it moved',
    $seqView(), [[["~~$A~~\nMoved to **J152820** by *Aashai Modor* at <t:…>", true, true], [$liveB, true, false]], true]);
$seqClock += 10; $seqChange('clear', 'Kytus Bos'); $seqSend();
check('sequence: ... then cleared: the new one struck', $seqView()[0][1], ["~~$B~~\nCleared by *Kytus Bos* at <t:…>", true, true]);
$seqClock += 10; $seqChange('set', 'Kytus Bos', $jA); $seqSend();
check('sequence: ... a new rally after a clear posts again (pinged)', [count($seqView()[0]), $seqView()[0][2]], [3, [$liveA, true, false]]);
$seqReset(); $seqChange('clear', 'Aashai Modor'); $seqSend();
check('sequence: a clear with no message posts nothing', [$seqView(), $requests], [[[], true], []]);
$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqChange('clear', 'Aashai Modor'); $seqSend();
check('sequence: set and clear queued together: the set is dropped, the clear has nothing to edit', [$seqView(), $requests], [[[], true], []]);
$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $channel['1000']['deleted'] = true; $seqClock += 60; $seqChange('clear', 'Aashai Modor'); $seqSend();
check('sequence: a clear after the message was deleted in Discord: one edit tried, nothing posted', [$requests, $seqView()], [['POST', 'PATCH'], [[], true]]);
$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $channel['1000']['deleted'] = true; $seqClock += 10; $seqChange('set', 'Aashai Modor', $jB); $seqSend();
check('sequence: a move after the message was deleted: posted again (pinged)', [$requests, $seqView()], [['POST', 'PATCH', 'POST'], [[[$liveB, true, false]], true]]);
$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $seqClock += 60; $seqChange('set', 'Aashai Modor', $jB); $seqClock += 1; $seqChange('clear', 'Aashai Modor'); $seqSend();
check('sequence: moved and cleared before the sender ran: the old message struck as cleared', $seqView(), [[["~~$A~~\nCleared by *Aashai Modor* at <t:…>", true, true]], true]);
// The production sequence of 1.17: Tyrael set + clear within 30 s, Kytus set, Aashai clear 55 min later
$seqReset(); $seqChange('set', 'Commander Tyrael', $jA); $seqSend(); $seqClock += 20; $seqChange('clear', 'Commander Tyrael'); $seqSend();
$seqClock += 600; $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $seqClock += 3300; $seqChange('clear', 'Aashai Modor'); $seqSend();
check('sequence: production', $seqView(), [[[str_replace('Kytus Bos', 'Commander Tyrael', "~~$A~~") . "\nCleared by *Commander Tyrael* at <t:…>", true, true],
    ["~~$A~~\nCleared by *Aashai Modor* at <t:…>", true, true]], true]);
// The type turned off and on again: the message from before is not edited
$seqReset(); $seqChange('set', 'Kytus Bos', $jA); $seqSend(); $seqType['enabledAt'] = $seqClock + 5; $seqClock += 10; $seqChange('clear', 'Aashai Modor'); $seqSend();
check('sequence: type turned off and on: a clear sends nothing', [$requests, $seqView()[0][0][2]], [['POST'], false]);
discord_http_transport(null, true);

// --- the chain of a mask (discord/chain.php): systems connected to home through live wormholes ---
check('chain walk: no links is just home', discord_chain_walk([], 31000001), [31000001 => true]);
check('chain walk: no home is nothing', discord_chain_walk([[31000001, 31000002]], 0), []);
check('chain walk: both directions, breadth-first, loops once', discord_chain_walk([[31000002, 31000001], [31000002, 31000003], [31000003, 31000001], [31000008, 31000009]], 31000001),
    [31000001 => true, 31000002 => true, 31000003 => true]);

$ch = new PDO('sqlite::memory:');
$ch->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$ch->exec("CREATE TABLE signatures (id INTEGER PRIMARY KEY, signatureID TEXT, systemID INTEGER, type TEXT, name TEXT, maskID TEXT, lifeLeft TEXT, lifeLength INTEGER)");
$ch->exec("CREATE TABLE wormholes (id INTEGER PRIMARY KEY, initialID INTEGER, secondaryID INTEGER, maskID TEXT)");
$chNow = time();
$at = function ($seconds) use ($chNow) { return date('Y-m-d H:i:s', $chNow + $seconds); };
$chSig = 0; $chHole = 0;
// A hole of $mask between $from and $to; $life*: seconds of life left on each side (lifeLength 86400), null = lifeLength 0
$link = function ($from, $to, $lifeFrom = 3600, $lifeTo = 3600, $mask = '98000001.2') use ($ch, &$chSig, &$chHole, $at) {
    $ids = [];
    foreach ([[$from, $lifeFrom], [$to, $lifeTo]] as [$system, $life]) {
        $ids[] = $id = ++$chSig;
        $ch->prepare("INSERT INTO signatures VALUES (?, 'abc123', ?, 'wormhole', '', ?, ?, ?)")
            ->execute([$id, $system, $mask, $at($life ?? -999999), $life === null ? 0 : 86400]);
    }
    $ch->prepare('INSERT INTO wormholes VALUES (?, ?, ?, ?)')->execute([++$chHole, $ids[0], $ids[1], $mask]);
    return $ids;
};
// Home H 31000001 - A 31000002 - Tama 30002813 (low-sec exit) - B 31000003: connected, through k-space too
$link(31000001, 31000002);
$link(31000002, 30002813);
$link(30002813, 31000003);
$link(31000001, 31000006, 7200, 7200);                  // EOL (critical) but not expired yet: still live
$link(31000001, 31000007, null, null);                  // no life known (lifeLength 0): live
// An old fragment C - D: holes still in the mask but nothing connects them to home any more
$link(31000010, 31000011);
// Expired: A - E with E's side past its life (nobody deleted it yet), and E - F live: E and F are cut off
$link(31000002, 31000004, 3600, -60);
$link(31000004, 31000005);
// A hole whose far signature was deleted: A - G
[, $gSig] = $link(31000002, 31000012);
$ch->exec("DELETE FROM signatures WHERE id = $gSig");
// Two holes with unknown far sides (generic placeholder 3) must not join A and the old fragment
$link(31000002, 3);
$link(31000011, 3);
// Another mask's hole from home
$link(31000001, 31000020, 3600, 3600, '98000002.2');
$link(31000020, 31000021, 3600, 3600, '98000002.2');
// A site (not a wormhole) in a system nobody connects
$ch->prepare("INSERT INTO signatures VALUES (999, 'def456', 31000030, 'combat', '', '98000001.2', ?, 0)")->execute([$at(3600)]);

$chains = discord_chain_systems($ch, ['98000001.2' => 31000001, '98000002.2' => 31000001, '98000003.2' => 0, '98000004.2' => 31000099], $chNow);
$sorted = function ($set) { $ids = array_keys($set); sort($ids); return $ids; };
check('chain: connected systems only (home, holes, k-space exit and beyond, EOL and no-life holes)', $sorted($chains['98000001.2']),
    [30002813, 31000001, 31000002, 31000003, 31000006, 31000007]);
check('chain: the old disconnected fragment is not in it', [isset($chains['98000001.2'][31000010]), isset($chains['98000001.2'][31000011])], [false, false]);
check('chain: an expired hole breaks the chain (and what is behind it)', [isset($chains['98000001.2'][31000004]), isset($chains['98000001.2'][31000005])], [false, false]);
check('chain: a hole with a deleted signature does not count', isset($chains['98000001.2'][31000012]), false);
check('chain: unknown far sides never join chains', [isset($chains['98000001.2'][3]), isset($chains['98000001.2'][31000010])], [false, false]);
check('chain: only the mask\'s own holes', $sorted($chains['98000002.2']), [31000001, 31000020, 31000021]);
check('chain: no home is no chain (never everything)', $chains['98000003.2'], []);
check('chain: home without holes is just home', $chains['98000004.2'], [31000099 => true]);
check('chain: a site is not a hole', isset($chains['98000001.2'][31000030]), false);
check('chain: an hour later the A-Tama hole has expired too', $sorted(discord_chain_systems($ch, ['98000001.2' => 31000001], $chNow + 3601)['98000001.2']),
    [31000001, 31000006, 31000007]);
check('chain: another home, another chain', $sorted(discord_chain_systems($ch, ['98000001.2' => 31000010], $chNow)['98000001.2']), [31000010, 31000011]);
check('chain: no masks, no query', discord_chain_systems($ch, []), []);
// Cached per mask and home for DISCORD_CHAIN_CACHE seconds
$first = discord_chain_systems_cached($ch, '98000001.2', 31000010, $chNow);
$link(31000011, 31000040);
check('chain cache: reused within the minute', discord_chain_systems_cached($ch, '98000001.2', 31000010, $chNow + 30), $first);
check('chain cache: reloaded after it', isset(discord_chain_systems_cached($ch, '98000001.2', 31000010, $chNow + DISCORD_CHAIN_CACHE)[31000040]), true);
check('chain cache: another home for the mask is loaded at once', isset(discord_chain_systems_cached($ch, '98000001.2', 31000001, $chNow + DISCORD_CHAIN_CACHE + 1)[31000002]), true);

// --- home system setting ---
$hd = discord_settings_defaults();
check('home: off by default', $hd['homeSystemID'], 0);
check('home: a wormhole system, a k-space system, as text', [discord_settings_normalise(['homeSystemID' => 31000005], $hd)[0]['homeSystemID'],
    discord_settings_normalise(['homeSystemID' => 30000142], $hd)[0]['homeSystemID'], discord_settings_normalise(['homeSystemID' => '31000005'], $hd)[0]['homeSystemID']],
    [31000005, 30000142, 31000005]);
foreach (['unknown' => 31999999, 'junk' => 'Jita', 'negative' => -1, 'float' => 31000005.5, 'list' => [31000005], 'null' => null] as $label => $bad) {
    check("home: $label refused", discord_settings_normalise(['homeSystemID' => $bad], $hd), [$hd, ['home system: unknown system']]);
}
check('home: 0 clears it', discord_settings_normalise(['homeSystemID' => 0], ['homeSystemID' => 31000005] + $hd)[0]['homeSystemID'], 0);
check('home: kept when not sent', discord_settings_normalise(['types' => []], ['homeSystemID' => 31000005] + $hd)[0]['homeSystemID'], 31000005);
check('home: stored settings from before have none', discord_settings_normalise(json_decode('{"types":{"chainKill":{"enabled":true,"webhookID":1}}}', true), $hd)[0]['homeSystemID'], 0);
[$noHome, $noHomeErrors] = discord_settings_normalise(['types' => ['chainKill' => ['enabled' => true, 'webhookID' => 1]]], $hd, [1]);
check('home: chain kills without a home can be saved (the page warns)', [$noHome['types']['chainKill']['enabled'], $noHomeErrors], [true, []]);

// --- chain kills use it (discord_kill_state against SQLite) ---
$ch->exec('CREATE TABLE discord_settings (maskID TEXT PRIMARY KEY, settings TEXT)');
$ch->exec("CREATE TABLE discord_webhooks (id INTEGER PRIMARY KEY, maskID TEXT, status TEXT)");
$ch->exec('CREATE TABLE masks (maskID TEXT PRIMARY KEY, ownerID INTEGER, ownerType INTEGER)');
$ch->exec('CREATE TABLE characters (characterID INTEGER, corporationID INTEGER, admin INTEGER)');
$ch->exec("INSERT INTO characters VALUES (1, 98000001, 1), (2, 98000002, 1)");
$ch->exec("INSERT INTO discord_webhooks VALUES (1, '98000001.2', 'ok'), (2, '98000001.2', 'ok'), (3, '98000002.2', 'ok')");
$kset = function ($home, $chainHook, $corpHook = 0) {
    $s = discord_settings_defaults(98000001);
    $s['homeSystemID'] = $home;
    $s['types']['chainKill'] = ['enabled' => true, 'webhookID' => $chainHook] + $s['types']['chainKill'];
    if ($corpHook) $s['types']['corpKill'] = ['enabled' => true, 'webhookID' => $corpHook] + $s['types']['corpKill'];
    return json_encode($s);
};
$ch->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['98000001.2', $kset(31000001, 1, 2)]);
$ch->prepare('INSERT INTO discord_settings VALUES (?, ?)')->execute(['98000002.2', $kset(0, 3)]);
$ks2 = discord_kill_state($ch, true);
$kf = ['systemID' => 31000003, 'time' => time()] + $facts;   // $facts: our kill (corpKill) from above
check('kill state: chain kills only in systems connected to home now', $sorted($ks2['chains']['98000001.2']), $sorted(discord_chain_systems($ch, ['98000001.2' => 31000001])['98000001.2']));
check('kill state: connected system posts a chain kill', discord_classify_kill($kf, $ks2['masks']['98000001.2'], $ks2['chains']['98000001.2']), ['corpKill' => 2, 'chainKill' => 1]);
check('kill state: old fragment posts no chain kill (corp kill unaffected)',
    discord_classify_kill(['systemID' => 31000010] + $kf, $ks2['masks']['98000001.2'], $ks2['chains']['98000001.2']), ['corpKill' => 2]);
check('kill state: no home set: no chain kills at all', [$ks2['chains']['98000002.2'],
    discord_classify_kill(['systemID' => 31000001] + $kf, $ks2['masks']['98000002.2'], $ks2['chains']['98000002.2'])], [[], []]);

// --- kill messages with the chain label (discord_chain_labels, loaded with the kill state) ---
// Every system's batch label equals the one-system lookup (same rule), per mask; only labelled systems are listed
$batch = discord_chain_labels($cl, ['98000001.2', '98000002.2', '98000003.2']);
$single = [];
foreach (['98000001.2', '98000002.2', '98000003.2'] as $m) {
    foreach ([31000001, 31000002, 31000003, 31000005, 31000009, 30000142, 30002187] as $s) { $l = discord_chain_label($cl, $m, $s); if ($l !== '') $single[$m][$s] = $l; }
}
ksort($batch['98000001.2']);
ksort($single['98000001.2']);
check('chain labels: batch equals the one-system lookup', $batch, $single);
check('chain labels: values', $batch['98000001.2'], [30000142 => 'ABC', 31000002 => 'A', 31000003 => 'AB', 31000005 => 'B']);
check('chain labels: no masks, no tables', [discord_chain_labels($cl, []), discord_chain_labels(new PDO('sqlite::memory:'), ['98000001.2'])], [[], []]);
// The kill state loads them for every mask with a kill type (one query per refresh, none per kill)
check('kill state: no named holes, no labels', $ks2['labels'], []);
$ch->exec("UPDATE signatures SET name = 'A' WHERE id = 1");   // home's side of home - 31000002
$ks3 = discord_kill_state($ch, true);
check('kill state: labels of the mask\'s chain', $ks3['labels'], ['98000001.2' => [31000002 => 'A']]);
$kd = discord_kill_data('chainKill', ['systemID' => 31000002] + $facts, $ks3['masks']['98000001.2']['types']['chainKill'], 'Corp', $ks3['labels']['98000001.2'][31000002] ?? '');
check('kill data: carries the label', [$kd['label'], discord_kill_context($kd, [])['label']], ['A', 'A']);
check('kill data: no label by default; rows queued before have none', [discord_kill_data('corpKill', $facts, $ks['types']['corpKill'], 'Corp')['label'],
    discord_kill_context(array_diff_key($kd, ['label' => 1]), [])['label']], ['', '']);

$kctx = ['kind' => 'chainKill', 'template' => discord_default_templates()['chainKill'], 'ping' => '', 'mask' => 'Corp', 'system' => 'J105246',
    'security' => null, 'class' => 'C5', 'region' => 'E-R00028', 'killID' => 1, 'victim' => 'Voidlord Pandora', 'corp' => 'All You Can Eat Holes',
    'ship' => 'Coercer Navy Issue', 'value' => 44070000, 'zkill' => 'https://zkillboard.com/kill/1/', 'time' => 1791633600];
$kp = discord_payload(['label' => 'AABCA'] + $kctx);
check('kill label: default text', $kp['content'], 'Kill in the chain: Voidlord Pandora (All You Can Eat Holes) lost a Coercer Navy Issue in AABCA · J105246, 44.07m ISK. <https://zkillboard.com/kill/1/>');
check('kill label: embed title and system line', [$kp['embeds'][0]['title'], $kp['embeds'][0]['description']],
    ['Kill in the chain: Coercer Navy Issue in AABCA · J105246', 'AABCA · J105246 (C5), E\\-R00028']);
$kp = discord_payload(['label' => ''] + $kctx);
check('kill label: none, as before', [$kp['content'], $kp['embeds'][0]['title'], $kp['embeds'][0]['description']],
    ['Kill in the chain: Voidlord Pandora (All You Can Eat Holes) lost a Coercer Navy Issue in J105246, 44.07m ISK. <https://zkillboard.com/kill/1/>',
     'Kill in the chain: Coercer Navy Issue in J105246', 'J105246 (C5), E\\-R00028']);
check('kill label: old context without one, as before', discord_payload($kctx)['content'], $kp['content']);
$tpl = discord_default_templates();
check('kill label: corp kill and loss defaults', [
    discord_payload(['kind' => 'corpKill', 'template' => $tpl['corpKill'], 'label' => 'AB', 'attackers' => 3] + $kctx)['content'],
    discord_payload(['kind' => 'corpLoss', 'template' => $tpl['corpLoss'], 'label' => 'AB'] + $kctx)['content']], [
    'Corp kill: Voidlord Pandora (All You Can Eat Holes) lost a Coercer Navy Issue in AB · J105246, 44.07m ISK, 3 pilots. <https://zkillboard.com/kill/1/>',
    'Corp loss: Voidlord Pandora lost a Coercer Navy Issue in AB · J105246, 44.07m ISK. <https://zkillboard.com/kill/1/>']);
check('kill label: {label} and {system} on their own', discord_payload(['template' => '{label}|{labelSystem}|{system}', 'label' => 'AB'] + $kctx)['content'], 'AB|AB · J105246|J105246');
$kp = discord_payload(['label' => "@everyone **x** <@&999999999999999999> [l](https://e.example)"] + $kctx);
check('kill label: escaped, cannot ping, format or link', [strpos($kp['content'], '@everyone'), strpos($kp['content'], '<@&'), strpos($kp['content'], '**x'),
    strpos($kp['content'], '](https:'), strpos($kp['embeds'][0]['description'], '@everyone'), strpos($kp['embeds'][0]['description'], '**x'), $kp['allowed_mentions']],
    [false, false, false, false, false, false, ['parse' => []]]);
$kp = discord_payload(['label' => '||**[x](https://evil.example)** <t:0:R> <:e:123456789012345678> <@&999999999999999999> `c` ~~s~~ _i_'] + $kctx);
check('kill label: escaped in the embed title too (titles render markdown)', $kp['embeds'][0]['title'],
    'Kill in the chain: Coercer Navy Issue in \\|\\|\\*\\*\\[x\\]\\(https\\://evil.example\\)\\*\\* \\<t\\:0\\:R\\> \\<\\:e\\:123456789012345678\\> \\<@' . DISCORD_ZWSP . '&999999999999999999\\> \\`c\\` \\~\\~s\\~\\~ \\_i\\_ · J105246');
// Stored default texts from before the label become today's; customised texts stay
foreach (['chainKill', 'corpKill', 'corpLoss'] as $kind) {
    $old = discord_retired_templates()[$kind]['template'][0];
    check("kill label: $kind's earlier default upgraded", [discord_template_upgrade($kind, 'template', $old . "\r\n"), discord_template_upgrade($kind, 'template', $old . '!'),
        discord_settings_normalise(['types' => [$kind => ['template' => $old]]], discord_settings_defaults())[0]['types'][$kind]['template'],
        discord_kill_context(['kind' => $kind, 'template' => $old] + $kd, [])['template']], [$tpl[$kind], $old . '!', $tpl[$kind], $tpl[$kind]]);
}
check('kill label: placeholders listed', [isset(discord_placeholders()['chainKill']['labelSystem']), isset(discord_placeholders()['corpLoss']['label'])], [true, true]);

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
