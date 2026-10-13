const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/api-tokens');
include('app/js/fork/api-tokens-tab');

describe('apiTokens', () => {
	const NOW = Date.parse('2026-10-12T12:00:00Z');
	const token = (extra) => Object.assign({
		id: 7, name: 'Discord bot', mask: '990101.0', maskLabel: 'Tok mask A', scope: 'read', hint: 'twp_7_…',
		createdAt: '2026-10-10T08:30:12Z', expiresAt: null, lastUsedAt: null, expired: false
	}, extra);

	describe('formatting', () => {
		it('shows times in UTC to the minute', () => {
			assert.strictEqual(apiTokens.when('2026-10-12T14:03:22Z'), '2026-10-12 14:03');
			assert.strictEqual(apiTokens.when(null), '');
		});

		it('says when a token was last used', () => {
			assert.strictEqual(apiTokens.lastUsedText(token()), 'never');
			assert.strictEqual(apiTokens.lastUsedText(token({ lastUsedAt: '2026-10-12T09:01:00Z' })), '2026-10-12 09:01');
			assert.strictEqual(apiTokens.lastUsedText(token({ lastUsedAt: '2026-10-12T09:01:00Z', lastUsedIP: '203.0.113.7' })), '2026-10-12 09:01 from 203.0.113.7');
		});

		it('says when a token expires', () => {
			assert.strictEqual(apiTokens.expiryText(token(), NOW), 'no expiry');
			assert.strictEqual(apiTokens.expiryText(token({ expiresAt: '2026-10-12T11:59:59Z' }), NOW), 'expired');
			assert.strictEqual(apiTokens.expiryText(token({ expiresAt: '2026-10-12T20:00:00Z' }), NOW), 'today');
			assert.strictEqual(apiTokens.expiryText(token({ expiresAt: '2026-10-13T12:00:00Z' }), NOW), 'in 1 day');
			assert.strictEqual(apiTokens.expiryText(token({ expiresAt: '2026-11-11T12:00:00Z' }), NOW), 'in 30 days');
			assert.strictEqual(apiTokens.expiryText(token({ expiresAt: 'garbage' }), NOW), '');
		});

		it('turns the expiry choice into days for the server', () => {
			assert.strictEqual(apiTokens.expiresDays('90'), 90);
			assert.strictEqual(apiTokens.expiresDays(''), null);
			assert.strictEqual(apiTokens.expiresDays('0'), null);
			assert.strictEqual(apiTokens.expiresDays('abc'), null);
			assert.strictEqual(apiTokens.EXPIRY[0][0], '90');
			assert.ok(apiTokens.EXPIRY.some(e => e[0] === ''), 'no expiry is a choice');
		});

		it('builds the curl line', () => {
			assert.strictEqual(apiTokens.exampleCommand('twp_1_ab', 'https://wh.example'), 'curl -H "Authorization: Bearer twp_1_ab" https://wh.example/api/v1/chain');
		});
	});

	describe('markup', () => {
		it('lists a token with its mask, dates and a revoke button', () => {
			const html = apiTokens.rowHtml(token({ lastUsedAt: '2026-10-12T09:01:00Z', lastUsedIP: '203.0.113.7', expiresAt: '2026-11-11T12:00:00Z' }), {}, NOW);
			assert.ok(html.includes('Discord bot'));
			assert.ok(html.includes('Tok mask A'));
			assert.ok(html.includes('2026-10-10 08:30'));
			assert.ok(html.includes('2026-10-12 09:01 from 203.0.113.7'));
			assert.ok(html.includes('in 30 days'));
			assert.ok(html.includes("class='apitok-revoke' data-id='7'"));
			assert.ok(!html.includes('apitok-expired'));
		});

		it('greys out an expired token', () => {
			const html = apiTokens.rowHtml(token({ expired: true, expiresAt: '2026-10-01T00:00:00Z' }), {}, NOW);
			assert.ok(html.includes('apitok-expired'));
			assert.ok(html.includes('expired'));
		});

		it('escapes names, owners and labels', () => {
			const evil = '<img src=x onerror=alert(1)>"\'&';
			const html = apiTokens.rowHtml(token({ name: evil, maskLabel: evil, owner: evil }), {}, NOW) + apiTokens.rowHtml(token({ name: evil, owner: evil }), { admin: true }, NOW);
			assert.ok(!html.includes('<img'));
			assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
		});

		it('shows the owner instead of the mask in the mask admin table, and never an IP', () => {
			const html = apiTokens.tableHtml([token({ owner: 'Some Pilot', lastUsedIP: '203.0.113.7', lastUsedAt: '2026-10-12T09:01:00Z' })].map(t => { delete t.lastUsedIP; return t; }), { admin: true }, NOW);
			assert.ok(html.includes('<th>Owner</th>'));
			assert.ok(html.includes('Some Pilot'));
			assert.ok(!html.includes('203.0.113.7'));
			assert.ok(!html.includes('<th>Mask</th>'));
		});

		it('lists tokens as compact blocks in Settings', () => {
			const html = apiTokens.listHtml([token({ lastUsedAt: '2026-10-12T09:01:00Z', lastUsedIP: '203.0.113.7', expiresAt: '2026-11-11T12:00:00Z' }), token({ id: 8, name: 'Second', expired: true })], NOW);
			assert.ok(html.includes('Mask: Tok mask A'));
			assert.ok(html.includes('last used 2026-10-12 09:01 from 203.0.113.7'));
			assert.ok(html.includes('expires in 30 days'));
			assert.ok(html.includes("class='apitok-revoke' data-id='8'"));
			assert.strictEqual((html.match(/apitok-card/g) || []).length, 2, 'two cards, one of them expired');
			assert.ok(html.includes('Times are UTC'));
			assert.ok(apiTokens.listHtml([], NOW).includes('You have no API tokens.'));
			assert.ok(!apiTokens.listHtml([token({ name: '<b>x</b>' })], NOW).includes('<b>x</b>'));
		});

		it('says so when there are no tokens', () => {
			assert.ok(apiTokens.tableHtml([], {}).includes('You have no API tokens.'));
			assert.ok(apiTokens.tableHtml([], { admin: true }).includes('Nobody has an API token for this mask.'));
		});

		it('shows a new token once, with copy and a curl line', () => {
			const html = apiTokens.createdHtml('twp_7_' + 'ab'.repeat(32), 'https://wh.example');
			assert.ok(html.includes("value='twp_7_" + 'ab'.repeat(32) + "'"));
			assert.ok(html.includes('not shown again'));
			assert.ok(html.includes('apitok-copy'));
			assert.ok(html.includes('https://wh.example/api/v1/chain'));
			assert.ok(html.includes('readonly'));
		});

		it('builds the settings view for each state of the server', () => {
			const state = { enabled: true, canCreate: true, max: 10, mask: { id: '990101.0', label: 'Tok mask A' }, tokens: [token()] };
			assert.ok(apiTokens.settingsHtml(null).includes('Loading'));
			assert.ok(apiTokens.settingsHtml({ enabled: false }).includes('turned off'));
			const html = apiTokens.settingsHtml(state, null, '', NOW);
			assert.ok(html.includes('Discord bot'));
			assert.ok(html.includes('apitok-create-btn'));
			assert.ok(html.includes('At most 10 active tokens'));
			assert.ok(!html.includes('not shown again'));
			assert.ok(apiTokens.settingsHtml(state, 'twp_7_x', '', NOW).includes('not shown again'));
			const refused = apiTokens.settingsHtml(Object.assign({}, state, { canCreate: false, reason: 'Not for this mask' }), null, '', NOW);
			assert.ok(refused.includes('Not for this mask'));
			assert.ok(!refused.includes('apitok-create-btn'));
		});
	});

	describe('Mask Admin tab', () => {
		it('shows the mask\'s tokens to admins only', () => {
			const state = { enabled: true, mask: { label: 'Tok mask A' }, maskTokens: [token({ owner: 'Some Pilot' })] };
			assert.ok(apiTokensTab.html(state, null, NOW).includes('Some Pilot'));
			assert.ok(apiTokensTab.html(Object.assign({}, state, { maskTokens: null }), null, NOW).includes('Only mask admins'));
			assert.ok(apiTokensTab.html({ enabled: false }, null, NOW).includes('turned off'));
		});

		it('shows an error or a message', () => {
			assert.ok(apiTokensTab.html(null, { text: 'Request failed (HTTP 500)', bad: true }).includes('Request failed (HTTP 500)'));
			const state = { enabled: true, mask: { label: 'M' }, maskTokens: [] };
			assert.ok(apiTokensTab.html(state, { text: 'Token revoked.', bad: false }, NOW).includes('apitok-good'));
		});
	});
});
