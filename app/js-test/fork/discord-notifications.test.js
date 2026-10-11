const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/discord-notifications');

const dn = discordNotifications;
const TOKEN = 'Ab_-9'.repeat(14);
const SYSTEMS = {
	30000142: { name: 'Jita', security: 0.946, regionID: 10000002 },
	30002659: { name: 'Dodixie', security: 0.87, regionID: 10000032 },
	30002813: { name: 'Tama', security: 0.28, regionID: 10000069 },
	31000005: { name: 'Thera', security: -0.99, regionID: 11000031, class: 12 },
	31000880: { name: 'J160650', security: -0.99, regionID: 11000020, class: 3 }
};
const byName = name => Number(Object.keys(SYSTEMS).find(id => SYSTEMS[id].name.toUpperCase() === String(name).toUpperCase())) || null;

function formValues(overrides) {
	const types = {};
	dn.KINDS.forEach(k => {
		types[k] = { enabled: false, webhookID: '0', template: 'T ' + k, ping: '', pingSystems: [30000142], maxJumps: '10', cooldownHours: '6', minIsk: '0', includeNpc: false, excludePods: false };
	});
	return Object.assign({ types: types, corporations: '98000001', alliances: '' }, overrides || {});
}

describe('Discord notifications', function() {
	describe('escape', function() {
		it('escapes HTML, including quotes used in attributes', function() {
			assert.strictEqual(dn.escape("<b a='x'>&\""), '&lt;b a=&#39;x&#39;&gt;&amp;&quot;');
			assert.strictEqual(dn.escape(null), '');
		});
	});

	describe('isWebhookUrl', function() {
		it('accepts the URL Discord gives you, and its variants', function() {
			assert.ok(dn.isWebhookUrl('https://discord.com/api/webhooks/123456789012345678/' + TOKEN));
			assert.ok(dn.isWebhookUrl(' https://discordapp.com/api/webhooks/123456789012345678/' + TOKEN + ' '));
			assert.ok(dn.isWebhookUrl('https://canary.discord.com/api/v10/webhooks/123456789012345678/' + TOKEN + '/'));
			assert.ok(dn.isWebhookUrl('https://ptb.discord.com/api/webhooks/123456789012345678/' + TOKEN + '?thread_id=123456789012345679'));
		});
		it('refuses anything else', function() {
			['http://discord.com/api/webhooks/123456789012345678/' + TOKEN,
				'https://discord.com.evil.example/api/webhooks/123456789012345678/' + TOKEN,
				'https://discord.com/api/webhooks/123/' + TOKEN,
				'https://discord.com/api/webhooks/123456789012345678/' + TOKEN + '/github',
				'', undefined].forEach(url => assert.strictEqual(dn.isWebhookUrl(url), false, String(url)));
		});
	});

	describe('isValidPing', function() {
		it('takes only mentions', function() {
			assert.ok(dn.isValidPing(''));
			assert.ok(dn.isValidPing('<@&123456789012345678> @here <@123456789012345678> <@!123456789012345678> @everyone'));
			assert.strictEqual(dn.isValidPing('hello @here'), false);
			assert.strictEqual(dn.isValidPing('<@&12>'), false);
		});
	});

	describe('parseIdList', function() {
		it('splits, dedupes and reports junk', function() {
			assert.deepStrictEqual(dn.parseIdList('98000001, 99000001;98000001\n1000125'), { ids: [98000001, 99000001, 1000125], invalid: [] });
			assert.deepStrictEqual(dn.parseIdList('abc 12 98000001'), { ids: [98000001], invalid: ['abc', '12'] });
			assert.deepStrictEqual(dn.parseIdList(''), { ids: [], invalid: [] });
		});
	});

	describe('ping systems', function() {
		it('adds k-space systems by name or ID', function() {
			assert.deepStrictEqual(dn.addPingSystem([30000142], 'dodixie', SYSTEMS, byName), { list: [30000142, 30002659], error: null });
			assert.deepStrictEqual(dn.addPingSystem([], '30002813', SYSTEMS, byName), { list: [30002813], error: null });
		});
		it('refuses J-space, unknown names, duplicates and too many', function() {
			assert.strictEqual(dn.addPingSystem([], 'Thera', SYSTEMS, byName).error, 'Thera is not k-space');
			assert.strictEqual(dn.addPingSystem([], 'Nowhere', SYSTEMS, byName).error, 'Unknown system "Nowhere"');
			assert.strictEqual(dn.addPingSystem([30000142], 'Jita', SYSTEMS, byName).error, 'Jita is already in the list');
			assert.strictEqual(dn.addPingSystem([], '', SYSTEMS, byName).error, 'Type a system name');
			const full = Array.from({ length: 20 }, (_, i) => 30000001 + i);
			assert.strictEqual(dn.addPingSystem(full, 'Jita', SYSTEMS, byName).error, 'At most 20 ping systems');
		});
		it('removes', function() {
			assert.deepStrictEqual(dn.removePingSystem([30000142, 30002659], '30000142'), [30002659]);
		});
	});

	describe('home system', function() {
		it('takes any known system by name or ID, wormhole space too', function() {
			assert.deepStrictEqual(dn.pickHomeSystem('j160650', SYSTEMS, byName), { id: 31000880, error: null });
			assert.deepStrictEqual(dn.pickHomeSystem(' 30002813 ', SYSTEMS, byName), { id: 30002813, error: null });
			assert.deepStrictEqual(dn.pickHomeSystem('Thera', SYSTEMS, byName), { id: 31000005, error: null });
		});
		it('refuses unknown systems and empty input', function() {
			assert.deepStrictEqual(dn.pickHomeSystem('Nowhere', SYSTEMS, byName), { id: 0, error: 'Unknown system "Nowhere"' });
			assert.deepStrictEqual(dn.pickHomeSystem('31999999', SYSTEMS, byName), { id: 0, error: 'Unknown system "31999999"' });
			assert.strictEqual(dn.pickHomeSystem('  ', SYSTEMS, byName).error, 'Type a system name');
		});
		it('warns only when chain kills are on without a home', function() {
			const s = home => ({ homeSystemID: home, types: { chainKill: { enabled: true } } });
			assert.strictEqual(dn.homeWarning(s(0)), dn.NO_HOME);
			assert.strictEqual(dn.homeWarning(s(undefined)), dn.NO_HOME);
			assert.strictEqual(dn.homeWarning(s(31000880)), '');
			assert.strictEqual(dn.homeWarning({ homeSystemID: 0, types: { chainKill: { enabled: false } } }), '');
			assert.ok(/Set a home system so Tripwire knows which chain is yours/.test(dn.NO_HOME));
		});
		it('is sent with the settings (0 = not set)', function() {
			assert.strictEqual(dn.collectSettings(formValues({ homeSystemID: 31000880 })).settings.homeSystemID, 31000880);
			assert.strictEqual(dn.collectSettings(formValues({ homeSystemID: '31000880' })).settings.homeSystemID, 31000880);
			assert.strictEqual(dn.collectSettings(formValues()).settings.homeSystemID, 0);
			assert.strictEqual(dn.collectSettings(formValues({ homeSystemID: -5 })).settings.homeSystemID, 0);
		});
		it('saving chain kills without a home is allowed (the page warns instead)', function() {
			const v = formValues();
			v.types.chainKill.enabled = true;
			v.types.chainKill.webhookID = '1';
			assert.deepStrictEqual(dn.collectSettings(v).errors, []);
		});
	});

	describe('webhookStatus', function() {
		const now = Date.parse('2026-10-10T12:00:00Z');
		it('shows broken webhooks with the reason', function() {
			const s = dn.webhookStatus({ status: 'broken', statusMessage: 'HTTP 404: Unknown Webhook (10015)' }, now);
			assert.strictEqual(s.text, 'Broken');
			assert.ok(s.title.indexOf('Unknown Webhook') >= 0);
		});
		it('shows a new or replaced URL as not verified until Discord accepted a message', function() {
			assert.strictEqual(dn.webhookStatus({ status: 'pending' }, now).text, 'Not verified yet');
		});
		it('shows when it last worked', function() {
			assert.deepStrictEqual(dn.webhookStatus({ status: 'ok', lastSentAt: '2026-10-10T11:55:00Z' }, now), { text: 'OK', cls: 'dn-good', title: 'Last message 5 min ago' });
			assert.strictEqual(dn.webhookStatus({ status: 'ok', lastSentAt: null }, now).text, 'OK');
		});
	});

	describe('maskAllowed', function() {
		it('corporation mask and corporation-owned custom masks, for admins only', function() {
			const m = (mask, ownerType, admin) => ({ mask: mask, ownerType: ownerType, admin: admin });
			assert.deepStrictEqual([
				m('98000001.2', 'corporate', true), m('98000001.2', 'corporate', false),
				m('12345.0', 'corporation', true), m('12345.0', 'character', true), m('12345.0', 'alliance', true),
				m('99000001.3', 'alliance', true), m('196379789.1', 'personal', true), m('0.0', 'global', true), null
			].map(dn.maskAllowed), [true, false, true, false, false, false, false, false, false]);
		});
	});

	describe('pausedText', function() {
		it('explains open circuit breakers', function() {
			const now = Date.parse('2026-10-10T12:00:00Z');
			assert.deepStrictEqual(dn.pausedText([{ scope: 'mask', until: '2026-10-10T12:08:00Z' }, { scope: 'webhook', webhookID: 2, until: '2026-10-10T12:03:00Z' }],
				[{ id: 2, name: '#kills' }], now), [
				'All Discord messages of this mask are paused for about 8 min: Discord refused too many requests. Check the webhooks below.',
				'Messages to #kills are paused for about 3 min: Discord refused too many requests. Check the webhooks below.'
			]);
			assert.deepStrictEqual(dn.pausedText(undefined, [], now), []);
			assert.deepStrictEqual(dn.pausedText([{ scope: 'corp', until: '2026-10-10T12:10:00Z' }], [], now),
				['All Discord messages of your corporation\'s masks are paused for about 10 min: Discord refused too many requests. Check the webhooks below.']);
		});
	});

	describe('webhookOptionsHtml', function() {
		it('lists webhooks with the selected one and escapes names', function() {
			const html = dn.webhookOptionsHtml([{ id: 1, name: '#intel', status: 'ok' }, { id: 2, name: "<x'>", status: 'broken' }], 2);
			assert.ok(html.indexOf("<option value='0'>") === 0);
			assert.ok(html.indexOf("<option value='2' selected>&lt;x&#39;&gt; (broken)</option>") > 0);
			assert.ok(html.indexOf("<option value='1'>#intel</option>") > 0);
		});
	});

	describe('collectSettings', function() {
		it('turns the form into settings for the server', function() {
			const v = formValues();
			v.types.kspace = Object.assign(v.types.kspace, { enabled: true, webhookID: '3', ping: ' <@&123456789012345678>   @here ', maxJumps: '99', pingSystems: [30000142, 30002659] });
			v.types.corpLoss = Object.assign(v.types.corpLoss, { enabled: true, webhookID: '4', minIsk: '1,000,000', excludePods: true });
			const r = dn.collectSettings(v);
			assert.deepStrictEqual(r.errors, []);
			assert.deepStrictEqual(r.settings.types.kspace, { enabled: true, webhookID: 3, template: 'T kspace', ping: '<@&123456789012345678> @here', pingSystems: [30000142, 30002659], maxJumps: 50, cooldownHours: 6 });
			assert.deepStrictEqual(r.settings.types.corpLoss, { enabled: true, webhookID: 4, template: 'T corpLoss', ping: '', minIsk: 1000000, includeNpc: false, excludePods: true });
			assert.deepStrictEqual(r.settings.corporations, [98000001]);
			assert.strictEqual(r.settings.types.chainKill.includeHighsec, false);
			assert.strictEqual('includeHighsec' in r.settings.types.corpLoss, false);
		});
		it('includes high-sec chain kills only when ticked', function() {
			const v = formValues();
			v.types.chainKill.includeHighsec = true;
			assert.strictEqual(dn.collectSettings(v).settings.types.chainKill.includeHighsec, true);
		});
		it('reports what would stop the server from saving', function() {
			const v = formValues({ corporations: 'x', alliances: '' });
			v.types.kspace = Object.assign(v.types.kspace, { enabled: true, webhookID: '0', pingSystems: [] });
			v.types.corpKill = Object.assign(v.types.corpKill, { enabled: true, webhookID: '2', ping: 'hi @here' });
			const r = dn.collectSettings(v);
			assert.deepStrictEqual(r.errors, [
				'New k-space near a ping system: choose a webhook to turn it on',
				'New k-space near a ping system: add at least one ping system',
				'Kills by our corporation: the ping field takes only <@&roleID>, <@userID>, @here or @everyone',
				'Corporation/alliance IDs must be numbers: x',
				'Corporation kills/losses need at least one corporation or alliance ID'
			]);
		});
	});

	describe('collectSettings: fight here (rally point)', function() {
		it('keeps both texts and nothing of the other types', function() {
			const v = formValues();
			v.types.rally = Object.assign(v.types.rally, { enabled: true, webhookID: '2', ping: ' @here ', templateClear: '  Cleared by {who} ' });
			const r = dn.collectSettings(v);
			assert.deepStrictEqual(r.errors, []);
			assert.deepStrictEqual(r.settings.types.rally, { enabled: true, webhookID: 2, template: 'T rally', ping: '@here', templateClear: 'Cleared by {who}' });
		});
		it('needs a webhook and a valid ping like the other types', function() {
			const v = formValues();
			v.types.rally = Object.assign(v.types.rally, { enabled: true, webhookID: '0', ping: 'everyone' });
			assert.deepStrictEqual(dn.collectSettings(v).errors, [
				'Fight here: the ping field takes only <@&roleID>, <@userID>, @here or @everyone',
				'Fight here: choose a webhook to turn it on'
			]);
		});
	});

	describe('previewHtml', function() {
		it('shows a message without an embed (rally point) as text only, line breaks kept', function() {
			const html = dn.previewHtml({ content: 'Rally: **Jita**\n<https://tw.example/?system=Jita>', allowed_mentions: { parse: [] } });
			assert.ok(html.indexOf('dn-preview-embed') < 0);
			assert.ok(html.indexOf('<b>Jita</b><br/>&lt;https://tw.example/?system=Jita&gt;') > 0);
		});
		it('shows content, embed and who gets pinged, escaped', function() {
			const html = dn.previewHtml({
				content: '<@&1> @here <script>x</script>',
				embeds: [{ color: 0xe74c3c, title: 'Corp loss', description: 'J160650', fields: [{ name: 'Victim', value: 'A\nB', inline: true }], footer: { text: 'Tripwire · Corp' } }],
				allowed_mentions: { parse: ['everyone'], roles: ['123456789012345678'] }
			});
			assert.ok(html.indexOf('&lt;script&gt;') > 0 && html.indexOf('<script>') < 0);
			assert.ok(html.indexOf('border-left-color: #e74c3c') > 0);
			assert.ok(html.indexOf('A<br/>B') > 0);
			assert.ok(html.indexOf('Pings: @here/@everyone, role 123456789012345678') > 0);
			assert.ok(dn.previewHtml({ content: 'x', embeds: [], allowed_mentions: { parse: [] } }).indexOf('Pings: nobody') > 0);
		});
		it('renders bold and markdown escapes like Discord', function() {
			const html = dn.previewHtml({ content: '**Jita** hole ABC\\-123 by \\*Bob\\*', embeds: [], allowed_mentions: { parse: [] } });
			assert.ok(html.indexOf('<b>Jita</b> hole ABC-123 by *Bob*') > 0);
		});
		it('renders strike-through and Discord timestamps (in the browser\'s own time zone), escaped markers stay text', function() {
			const unix = 1760123280;
			const d = new Date(unix * 1000);
			const hhmm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
			assert.strictEqual(dn.timeText(unix), hhmm);
			const html = dn.previewHtml({ content: '~~Rally **AB · J1** (C5, E\\-R1)~~\nCleared by *A* at <t:' + unix + ':t> \\~\\~x\\~\\~', allowed_mentions: { parse: [] } });
			assert.ok(html.indexOf('<s>Rally <b>AB · J1</b> (C5, E-R1)</s><br/>Cleared by *A* at ' + hhmm + ' ~~x~~') > 0, html);
			assert.ok(html.indexOf('Pings: nobody') > 0);
			assert.ok(dn.previewHtml({ content: '<t:1<script>:t>', allowed_mentions: { parse: [] } }).indexOf('<script>') < 0);
		});
	});

	describe('previewsHtml', function() {
		it('shows the rally point\'s cleared and moved edits under the message, each titled', function() {
			const p = function(c) { return { content: c, allowed_mentions: { parse: [] } }; };
			const html = dn.previewsHtml({ preview: p('live'), previewClear: p('~~live~~ cleared'), previewMoved: p('~~live~~ moved') });
			assert.ok(html.indexOf('live') < html.indexOf('When it is cleared, the message becomes:'));
			assert.ok(html.indexOf('When it is cleared, the message becomes:') < html.indexOf('<s>live</s> cleared'));
			assert.ok(html.indexOf('When it moves after 30 seconds, a new message is posted and the old one becomes:') < html.indexOf('<s>live</s> moved'));
			assert.strictEqual(dn.previewsHtml({ preview: p('x') }), dn.previewHtml(p('x')));
		});
	});

	describe('pageHtml', function() {
		const state = {
			mask: { name: 'Corp <b>' }, encrypted: false,
			webhooks: [{ id: 1, name: '#intel', hint: '…/1111', status: 'ok', lastSentAt: null }, { id: 2, name: '#gone', hint: '…/0404', status: 'broken', statusMessage: 'HTTP 404' }],
			placeholders: { kspace: { system: 'system name' }, chainKill: {}, corpKill: {}, corpLoss: {} },
			names: { 98000001: 'Our Corp' }, outbox: { queued: 2, sent24h: 5, failed24h: 1, failures: [{ kind: 'corpLoss', webhook: '#gone', error: 'HTTP 404', createdAt: null }] }
		};
		const settings = { types: {}, corporations: [98000001], alliances: [] };
		dn.KINDS.forEach(k => { settings.types[k] = { enabled: k === 'kspace', webhookID: 1, template: '{system}', ping: '', pingSystems: [30000142], maxJumps: 10, cooldownHours: 6, minIsk: 0 }; });
		it('never contains a webhook URL, only the hint', function() {
			const html = dn.pageHtml(state, settings);
			assert.ok(html.indexOf('…/1111') > 0);
			assert.ok(html.indexOf('discord.com/api/webhooks/1') < 0);
		});
		it('shows the home system, and warns when chain kills are on without one', function() {
			const saved = global.appData;
			global.appData = { systems: { 31000880: { name: 'J160650 <x>' } } };
			try {
				const s = JSON.parse(JSON.stringify(settings));
				s.homeSystemID = 31000880;
				s.types.chainKill.enabled = true;
				let html = dn.pageHtml(state, s);
				assert.ok(html.indexOf("<span class='dn-chip dn-home' data-system='31000880'>J160650 &lt;x&gt; ") > 0);
				assert.ok(html.indexOf(dn.NO_HOME) < 0);
				assert.ok(html.indexOf(dn.HELP.chainKill) > 0 && /connected to your home system/.test(dn.HELP.chainKill));
				s.homeSystemID = 0;
				html = dn.pageHtml(state, s);
				assert.ok(html.indexOf("data-system='0'>Not set</span>") > 0);
				assert.ok(html.indexOf("<p class='dn-bad dn-home-warning'>" + dn.NO_HOME + '</p>') > 0);
				s.types.chainKill.enabled = false;
				assert.ok(dn.pageHtml(state, s).indexOf(dn.NO_HOME) < 0);
			} finally {
				global.appData = saved;
			}
		});
		it('escapes the mask name, warns about plain-text storage and shows broken webhooks', function() {
			const html = dn.pageHtml(state, settings);
			assert.ok(html.indexOf('Corp &lt;b&gt; mask') > 0);
			assert.ok(html.indexOf('DISCORD_SECRET_KEY is not set') > 0);
			assert.ok(html.indexOf("<button type='button' class='dn-test' disabled>") > 0);
			assert.ok(html.indexOf('Our Corp (98000001)') > 0);
			assert.ok(html.indexOf(dn.SAFE_RULE) > 0);
		});
		it('shows the Fight here (rally point) type with its second text, escaped', function() {
			const s = JSON.parse(JSON.stringify(settings));
			s.types.rally.templateClear = "Cleared by {who} <script>";
			const html = dn.pageHtml(state, s);
			assert.ok(html.indexOf("data-kind='rally'") > 0);
			assert.ok(html.indexOf('Set or moved:') > 0);
			assert.ok(html.indexOf("<textarea class='dn-templateClear' rows='1'>Cleared by {who} &lt;script&gt;</textarea>") > 0);
			assert.ok(html.indexOf('Replaces the fight message (an edit: no new message, nobody pinged') > 0);
			assert.ok(html.indexOf('<code>{rally}</code> is that message struck through; without <code>{rally}</code> it is put above your text') > 0);
			assert.ok(html.indexOf('Nothing is sent when there is no fight message to edit') > 0);
			assert.ok(html.indexOf('<code>{labelSystem}</code>, <code>{was}</code>') > 0);
			assert.ok(html.indexOf('DISCORD_WEB_HOOK') < 0);
		});
		it('lists the chain label placeholders the server names, with escaped descriptions', function() {
			const st = Object.assign({}, state, { placeholders: Object.assign({}, state.placeholders, {
				rally: { label: 'chain label, e.g. AABCA', labelSystem: 'e.g. "AABCA · J123456" <b>', was: 'cleared text' } }) });
			const html = dn.pageHtml(st, settings);
			assert.ok(html.indexOf("<code title='chain label, e.g. AABCA'>{label}</code>") > 0);
			assert.ok(html.indexOf("<code title='e.g. &quot;AABCA · J123456&quot; &lt;b&gt;'>{labelSystem}</code>") > 0);
			assert.ok(html.indexOf("<code title='cleared text'>{was}</code>") > 0);
		});
		it('says where rally changes go while the type is off and the server has a legacy webhook', function() {
			const s = JSON.parse(JSON.stringify(settings));
			s.types.rally.enabled = false;
			assert.ok(dn.pageHtml(Object.assign({}, state, { legacyRally: true }), s).indexOf(dn.escape(dn.LEGACY_RALLY)) > 0);
			s.types.rally.enabled = true;
			assert.ok(dn.pageHtml(Object.assign({}, state, { legacyRally: true }), s).indexOf(dn.escape(dn.LEGACY_RALLY)) < 0);
		});
		it('names a failed edit of an old rally message', function() {
			const st = Object.assign({}, state, { outbox: Object.assign({}, state.outbox, { failures: [{ kind: 'rallyEdit', webhook: '#ops', error: 'HTTP 500', createdAt: null }] }) });
			assert.ok(dn.pageHtml(st, settings).indexOf('<li>Fight here (old message) to #ops') > 0);
		});
	});
});
