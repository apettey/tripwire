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
    'aID' => 1, 'aSys' => 31000123, 'aSig' => 'abc123', 'aBy' => 'Scout', 'bID' => 2, 'bSys' => 30000142, 'bSig' => 'xyz789', 'bBy' => 'Jumper'];
check('candidates: k-space side, hole in the J-space system', discord_kspace_candidates($row),
    [['systemID' => 30000142, 'sigRowID' => 2, 'via' => 31000123, 'viaSig' => 'ABC-123', 'hole' => 'N110', 'mapper' => 'Jumper']]);
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
check('mask entities', [discord_mask_entities('98000001.2', 5), discord_mask_entities('99000001.3', 5), discord_mask_entities('9000.1', 98000002), discord_mask_entities('1234.0', 98000002)],
    [[98000001, 0], [0, 99000001], [98000002, 0], [98000002, 0]]);

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

echo ($failures ? "$failures of $count checks FAILED" : "$count checks passed") . "\n";
exit($failures ? 1 : 0);
