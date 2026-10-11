const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/system-threat-90d');
include('app/js/fork/system-threat');

describe('System threat 90 days', () => {
	const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
	const hours = () => new Array(24).fill(0);
	const busy = { start: 18, end: 22, kills: 14, share: 62 };
	const period = (over) => Object.assign({ kills: 14, hours: Object.assign(hours(), { 18: 3, 19: 4, 20: 5, 21: 2 }), busiest: busy, groups: [] }, over);
	const profile = (over) => Object.assign({ analysedAt: '2026-10-11T11:48:00Z', coveredDays: 90, level: 'high', d7: period({ kills: 2 }), d90: period() }, over);

	describe('windowLabel / localLabel / timezone', () => {
		it('pads the hours', () => assert.equal(threat90d.windowLabel({ start: 3, end: 7 }), '03:00–07:00'));
		it('wraps past midnight', () => assert.equal(threat90d.windowLabel({ start: 22, end: 2 }), '22:00–02:00'));
		it('shows the viewer\'s clock', () => assert.equal(threat90d.localLabel(busy, 120), '20:00–00:00'));
		it('handles negative offsets and half hours', () => {
			assert.equal(threat90d.localLabel(busy, -300), '13:00–17:00');
			assert.equal(threat90d.localLabel(busy, 330), '23:30–03:30');
		});
		it('is empty when the viewer is on EVE time', () => assert.equal(threat90d.localLabel(busy, 0), ''));
		it('names the time zone from the middle of the window', () => {
			assert.equal(threat90d.timezone({ start: 18, end: 22 }), 'EU');
			assert.equal(threat90d.timezone({ start: 0, end: 4 }), 'US');
			assert.equal(threat90d.timezone({ start: 22, end: 2 }), 'US');
			assert.equal(threat90d.timezone({ start: 8, end: 12 }), 'AU');
		});
	});

	describe('inWindow', () => {
		it('inside and outside', () => {
			assert.equal(threat90d.inWindow(18, busy), true);
			assert.equal(threat90d.inWindow(21, busy), true);
			assert.equal(threat90d.inWindow(22, busy), false);
			assert.equal(threat90d.inWindow(3, busy), false);
		});
		it('wraps around midnight', () => {
			const w = { start: 22, end: 2 };
			assert.deepEqual([21, 22, 23, 0, 1, 2].map(h => threat90d.inWindow(h, w)), [false, true, true, true, true, false]);
		});
		it('no window', () => assert.equal(threat90d.inWindow(5, null), false));
	});

	describe('cleanHours', () => {
		it('always 24 non-negative counts', () => {
			assert.equal(threat90d.cleanHours(null).length, 24);
			assert.deepEqual(threat90d.cleanHours([1, '2', -3, 'x']).slice(0, 5), [1, 2, 0, 0, 0]);
		});
	});

	describe('sparkline', () => {
		const svg = threat90d.sparkline(period().hours, busy);
		it('has 24 bars with a tooltip each', () => {
			assert.equal((svg.match(/<rect /g) || []).length, 24);
			assert.ok(svg.includes('<title>20:00 EVE: 5 kills</title>'));
			assert.ok(svg.includes('<title>18:00 EVE: 3 kills</title>'));
			assert.ok(svg.includes('<title>05:00 EVE: 0 kills</title>'));
		});
		it('uses singular for one kill', () => assert.ok(threat90d.sparkline(Object.assign(hours(), { 4: 1 }), null).includes('04:00 EVE: 1 kill<')));
		it('marks the busiest window only', () => assert.equal((svg.match(/threat90d-busy/g) || []).length, 4));
		it('the tallest bar fills the height', () => assert.ok(svg.includes("y='0' width='6' height='26'")));
		it('is labelled for screen readers', () => assert.ok(svg.includes("role='img'") && svg.includes('Kills by hour of day, EVE time: 14 kills')));
	});

	describe('groupsHtml', () => {
		const groups = [{ kind: 'alliance', id: 99005839, kills: 12, losses: 1, days: 5, lastSeen: '2026-10-10T20:00:00Z' },
			{ kind: 'corporation', id: 849473841, kills: 1, losses: 0, days: 3, lastSeen: '2026-10-09T20:00:00Z' }];
		it('links to zKillboard with escaped names', () => {
			const html = threat90d.groupsHtml(groups, { 99005839: 'We <b>Form</b>', 849473841: 'Beach Boys' });
			assert.ok(html.includes("href='https://zkillboard.com/alliance/99005839/'"));
			assert.ok(html.includes("href='https://zkillboard.com/corporation/849473841/'"));
			assert.ok(html.includes('We &lt;b&gt;Form&lt;/b&gt;'));
			assert.ok(!html.includes('<b>Form'));
			assert.ok(html.includes('12 kills · 5 days · 1 lost'));
			assert.ok(html.includes('1 kill · 3 days<'));
		});
		it('falls back to the kind and ID while names are pending', () => assert.ok(threat90d.groupsHtml(groups, {}).includes('Alliance 99005839')));
		it('says so when nobody qualifies', () => assert.ok(threat90d.groupsHtml([], {}).includes('3 or more different days')));
		it('ignores a hostile ID', () => assert.ok(threat90d.groupURL({ kind: 'alliance', id: "1'><script>" }).endsWith('/alliance/1/')));
	});

	describe('analysedText', () => {
		const at = ms => new Date(NOW - ms).toISOString();
		it('just now', () => assert.equal(threat90d.analysedText(at(30000), NOW), 'analysed just now'));
		it('minutes', () => assert.equal(threat90d.analysedText(at(12 * 60000), NOW), 'analysed 12 min ago'));
		it('hours', () => assert.equal(threat90d.analysedText(at(3 * 3600000), NOW), 'analysed 3 h ago'));
		it('days', () => assert.equal(threat90d.analysedText(at(3 * 86400000), NOW), 'analysed 3 d ago'));
		it('unknown', () => assert.equal(threat90d.analysedText('', NOW), ''));
	});

	describe('html', () => {
		const names = { 99005839: 'WE FORM V0LTA' };
		const withGroups = profile({ d90: period({ groups: [{ kind: 'alliance', id: 99005839, kills: 9, losses: 0, days: 6, lastSeen: '2026-10-10T20:00:00Z' }] }) });
		it('nothing without a profile', () => { assert.equal(threat90d.html(null, NOW, {}), ''); assert.equal(threat90d.html({}, NOW, {}), ''); });
		it('90 d view: chart, window, local time, level, groups, analysed', () => {
			const html = threat90d.html(withGroups, NOW, { period: 'd90', names: names, offsetMinutes: 120 });
			assert.ok(html.includes('14 kills in 90 days'));
			assert.ok(html.includes('threat90d-high'));
			assert.ok(html.includes('Most active <b>18:00–22:00 EVE</b>'));
			assert.ok(html.includes('EU time zone, 20:00–00:00 your time'));
			assert.ok(html.includes('WE FORM V0LTA'));
			assert.ok(html.includes('analysed 12 min ago'));
			assert.ok(html.includes("data-period='d90' aria-pressed='true'") && html.includes("data-period='d7' aria-pressed='false'"));
			assert.ok(!html.includes('so far'));
		});
		it('7 d view uses the 7-day period and no level pill', () => {
			const html = threat90d.html(profile({ d7: period({ kills: 9, busiest: null }) }), NOW, { period: 'd7' });
			assert.ok(html.includes('9 kills in 7 days'));
			assert.ok(html.includes("data-period='d7' aria-pressed='true'"));
			assert.ok(!html.includes('threat90d-level'));
			assert.ok(html.includes('Too few kills to name a busiest time.'));
		});
		it('unknown period falls back to 90 d', () => assert.ok(threat90d.html(profile(), NOW, { period: 'x' }).includes('in 90 days')));
		it('no kills in the period: no chart', () => {
			const html = threat90d.html(profile({ d90: period({ kills: 0, hours: hours(), busiest: null }), level: 'none' }), NOW, { period: 'd90' });
			assert.ok(html.includes('No kills seen in this period.'));
			assert.ok(!html.includes('<svg'));
		});
		it('says how little of the period is covered', () => {
			assert.ok(threat90d.html(profile({ coveredDays: 0.3 }), NOW, {}).includes('kills seen for under a day so far'));
			assert.ok(threat90d.html(profile({ coveredDays: 12.4 }), NOW, {}).includes('kills seen for about 12 days so far'));
			assert.ok(!threat90d.html(profile({ coveredDays: 12.4 }), NOW, { period: 'd7' }).includes('so far'));
		});
	});

	describe('period storage', () => {
		it('defaults to 90 d, setPeriod rejects junk', () => {
			assert.equal(threat90d.period, 'd90');
			threat90d.setPeriod('d7');
			assert.equal(threat90d.period, 'd7');
			threat90d.setPeriod('weird');
			assert.equal(threat90d.period, 'd90');
		});
	});

	describe('in the Threat & residents section', () => {
		const response = (detail) => ({ retentionSeconds: 172800, localSince: null, systems: { 31000005: { stats: null, local: { kills1h: 0, kills24h: 0, killsWindow: 0, lastKill: null }, fetchedAt: null } },
			detail: Object.assign({ systemID: 31000005, corporations: [], alliances: [], structures: [], names: { 99005839: 'WE FORM V0LTA' }, namesPending: false }, detail) });
		const p = profile({ d90: period({ groups: [{ kind: 'alliance', id: 99005839, kills: 9, losses: 0, days: 6, lastSeen: '2026-10-10T20:00:00Z' }] }) });
		it('the model carries the profile and the names', () => {
			const model = systemThreat.infoModel(response({ profile: p }), NOW, {});
			assert.strictEqual(model.profile, p);
			assert.equal(model.names[99005839], 'WE FORM V0LTA');
		});
		it('the expanded section shows it, the collapsed one does not', () => {
			const model = systemThreat.infoModel(response({ profile: p }), NOW, {});
			assert.ok(systemThreat.sectionHtml(model, NOW, {}).includes('threat90d-chart'));
			assert.ok(systemThreat.sectionHtml(model, NOW, {}).includes('WE FORM V0LTA'));
			assert.ok(!systemThreat.sectionHtml(model, NOW, { collapsed: true }).includes('threat90d'));
		});
		it('an older server without a profile shows the section as before', () => {
			const model = systemThreat.infoModel(response({}), NOW, {});
			assert.strictEqual(model.profile, null);
			assert.ok(!systemThreat.sectionHtml(model, NOW, {}).includes('threat90d'));
		});
	});
});
