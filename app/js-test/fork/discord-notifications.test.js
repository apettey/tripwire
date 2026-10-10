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
		it('only corporation, alliance and custom masks', function() {
			assert.deepStrictEqual(['98000001.2', '99000001.3', '12345.0', '196379789.1', '0.0', '', null, undefined].map(dn.maskAllowed),
				[true, true, true, false, false, false, false, false]);
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

	describe('previewHtml', function() {
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
		it('escapes the mask name, warns about plain-text storage and shows broken webhooks', function() {
			const html = dn.pageHtml(state, settings);
			assert.ok(html.indexOf('Corp &lt;b&gt; mask') > 0);
			assert.ok(html.indexOf('DISCORD_SECRET_KEY is not set') > 0);
			assert.ok(html.indexOf("<button type='button' class='dn-test' disabled>") > 0);
			assert.ok(html.indexOf('Our Corp (98000001)') > 0);
			assert.ok(html.indexOf(dn.SAFE_RULE) > 0);
		});
	});
});
