const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/environment-tags');

describe('environmentTags', () => {
	const NOW = Date.parse('2026-10-12T04:30:00Z');
	const obs = (over) => Object.assign({
		id: '1', created_at: '2026-10-12T02:30:00.000Z', observation_type: 'gamma_a', observation_category: 'storm',
		display_name: 'Gamma Ray Storm', hours_in_system: 3, system_id: 30000017, system_name: 'Futzchag'
	}, over);

	describe('enabled / stormsEnabled', () => {
		it('are on unless switched off', () => {
			assert.strictEqual(environmentTags.enabled(undefined), true);
			assert.strictEqual(environmentTags.enabled({}), true);
			assert.strictEqual(environmentTags.enabled({ environmentTags: {} }), true);
			assert.strictEqual(environmentTags.enabled({ environmentTags: { enabled: false } }), false);
			assert.strictEqual(environmentTags.stormsEnabled({}), true);
			assert.strictEqual(environmentTags.stormsEnabled({ environmentTags: { storms: false } }), false);
			assert.strictEqual(environmentTags.stormsEnabled({ environmentTags: { enabled: false } }), false);
		});
	});

	describe('parseStorms', () => {
		it('keeps storms, takes the kind from the observation type, drops other categories and unknown kinds', () => {
			const out = environmentTags.parseStorms([
				obs({}),
				obs({ system_id: 2, observation_type: 'electric_b', display_name: 'Electric Storm' }),
				obs({ system_id: 3, observation_category: 'space_oddity', observation_type: 'toms_shuttle' }),
				obs({ system_id: 4, observation_type: 'nebula_a' })
			], NOW);
			assert.deepStrictEqual(Object.keys(out).sort(), ['2', '30000017']);
			assert.strictEqual(out[30000017].kind, 'gamma');
			assert.strictEqual(out[2].kind, 'electric');
			assert.strictEqual(out[30000017].reportedMs, Date.parse('2026-10-12T02:30:00Z'));
			assert.strictEqual(out[30000017].hoursInSystem, 3);
		});

		it('keeps the newest report of a system and drops reports older than a week', () => {
			const out = environmentTags.parseStorms([
				obs({ observation_type: 'plasma_a', created_at: '2026-10-11T00:00:00Z' }),
				obs({ observation_type: 'exotic_b', created_at: '2026-10-12T01:00:00Z' }),
				obs({ observation_type: 'gamma_a', created_at: '2026-10-12T00:00:00Z' }),
				obs({ system_id: 9, created_at: '2026-10-01T00:00:00Z' })
			], NOW);
			assert.strictEqual(out[30000017].kind, 'exotic');
			assert.strictEqual(out[9], undefined);
		});

		it('never carries feed text into a tooltip (malicious display_name / system_name)', () => {
			const evil = '<img src=x onerror=alert(1)>"\'';
			const storms = environmentTags.parseStorms([obs({ display_name: evil, system_name: evil, created_by_name: evil })], NOW);
			assert.deepStrictEqual(Object.keys(storms[30000017]).sort(), ['hoursInSystem', 'kind', 'reportedMs']);
			const tags = environmentTags.tagsFor(30000017, {}, { storms: storms, nowMs: NOW });
			const html = environmentTags.tagsHtml(tags);
			assert.ok(html.indexOf('onerror') < 0 && html.indexOf('<img') < 0, html);
			assert.ok(/Gamma Ray Storm, reported/.test(tags[0].tip));
		});

		it('survives junk', () => {
			assert.deepStrictEqual(environmentTags.parseStorms(null, NOW), {});
			assert.deepStrictEqual(environmentTags.parseStorms({ a: 1 }, NOW), {});
			assert.deepStrictEqual(environmentTags.parseStorms([null, 5, 'x', obs({ created_at: 'nope' }), obs({ system_id: 'abc' })], NOW), {});
			assert.strictEqual(environmentTags.parseStorms([obs({ hours_in_system: 'many' })], NOW)[30000017].hoursInSystem, null);
		});
	});

	describe('parseA0', () => {
		it('reads the id list and ignores a bad file', () => {
			assert.deepStrictEqual([...environmentTags.parseA0({ systems: [30000017, '30000036', 0, 'x'] })], [30000017, 30000036]);
			assert.strictEqual(environmentTags.parseA0(null).size, 0);
			assert.strictEqual(environmentTags.parseA0({ systems: 'no' }).size, 0);
		});
	});

	describe('tagsFor', () => {
		const storms = environmentTags.parseStorms([obs({})], NOW);
		const ctx = { storms: storms, a0: new Set([30000017, 31000070]), nowMs: NOW };

		it('gives a storm tag with a tooltip, then the A0 tag', () => {
			const tags = environmentTags.tagsFor(30000017, { name: 'Futzchag' }, ctx);
			assert.deepStrictEqual(tags.map(t => t.type), ['storm', 'a0']);
			assert.strictEqual(tags[0].kind, 'gamma');
			assert.ok(/Gamma Ray Storm, reported 2 h ago \(already there 3 h\)/.test(tags[0].tip), tags[0].tip);
		});

		it('never tags an A0 wormhole system, an unknown system or a generic node', () => {
			assert.deepStrictEqual(environmentTags.tagsFor(31000070, { class: [1] }, ctx), []);
			assert.deepStrictEqual(environmentTags.tagsFor(30000999, { name: 'x' }, ctx), []);
			assert.deepStrictEqual(environmentTags.tagsFor('Class-3', {}, ctx), []);
		});

		it('works with no data at all', () => {
			assert.deepStrictEqual(environmentTags.tagsFor(30000017, {}, { nowMs: NOW }), []);
		});
	});

	describe('tagHtml / insertTags', () => {
		it('escapes the tooltip and colours the storm by kind', () => {
			const html = environmentTags.tagHtml({ type: 'storm', kind: 'plasma', tip: "<b>x</b> 'q'" });
			assert.ok(html.indexOf('<b>') < 0 && html.indexOf('&lt;b&gt;') > 0 && html.indexOf('&#39;q&#39;') > 0);
			assert.ok(html.indexOf('env-plasma') > 0 && html.indexOf(environmentTags.STORMS.plasma.color) > 0);
			assert.ok(environmentTags.tagHtml({ type: 'a0', tip: 'A0' }).indexOf('>A0</span>') > 0);
		});

		it('inserts before the icon row, once', () => {
			const node = "<div id='node1'><div class='nodeIcons'></div></div>";
			const once = environmentTags.insertTags(node, "<span class='env-tags'></span>");
			assert.strictEqual(once, "<div id='node1'><span class='env-tags'></span><div class='nodeIcons'></div></div>");
			assert.strictEqual(environmentTags.insertTags(once, "<span class='env-tags'></span>"), once);
			assert.strictEqual(environmentTags.insertTags('<div></div>', 'x'), '<div></div>');
			assert.strictEqual(environmentTags.insertTags(node, ''), node);
		});
	});

	describe('decorate / chainSystemIDs', () => {
		const row = (id, v, extra) => Object.assign({ c: [{ v: v, systemID: id, f: "<div id='node" + v + "'><div class='nodeIcons'></div></div>" }] }, extra || {});
		const systems = { 30000017: { name: 'Futzchag' }, 31000070: { class: [1], effect: 'Pulsar' }, 30000036: { name: 'Yishinoon' } };
		const ctx = { storms: environmentTags.parseStorms([obs({})], NOW), a0: new Set([30000017, 30000036]), nowMs: NOW };

		it('tags chain systems in place, skips destination rows, lists unique chain systems', () => {
			const result = { map: { rows: [
				row(30000036, 1), row(30000017, 2), row(30000017, 3), row(31000070, 4),
				row(30000017, 'dest-5'), row(30000017, 6, { destination: true })
			] } };
			const r = environmentTags.decorate(result, id => systems[id], ctx);
			assert.deepStrictEqual(r.systemIDs, [30000036, 30000017, 31000070]);
			assert.deepStrictEqual(r.tagged, [30000036, 30000017]);
			assert.ok(result.map.rows[0].c[0].f.indexOf('env-a0') > 0);
			assert.ok(result.map.rows[1].c[0].f.indexOf('env-gamma') > 0);
			assert.ok(result.map.rows[3].c[0].f.indexOf('env-tags') < 0);
			assert.ok(result.map.rows[4].c[0].f.indexOf('env-tags') < 0);
			assert.ok(result.map.rows[5].c[0].f.indexOf('env-tags') < 0);
		});

		it('copes with an empty or missing map', () => {
			assert.deepStrictEqual(environmentTags.decorate(null, () => null, ctx), { systemIDs: [], tagged: [] });
			assert.deepStrictEqual(environmentTags.decorate({ map: { rows: [] } }, () => null, ctx), { systemIDs: [], tagged: [] });
		});
	});

	describe('summary', () => {
		const systems = {
			1: { effect: 'Pulsar' }, 2: { effect: 'Pulsar' }, 3: { effect: 'Wolf-Rayet Star' }, 4: {}, 5: { effect: 'Black Hole' },
			6: { effect: 'Something New' }
		};
		const names = { 1: 'J1', 3: 'J3', 4: 'Futzchag', 5: 'J5', 6: 'J6' };
		const nameOf = id => names[id];
		const stormOf = kind => ({ kind: kind });

		it('counts effects in a fixed order and names storms', () => {
			const m = environmentTags.summaryModel([1, 2, 3, 4, 5, 6, 99], id => systems[id], { 4: stormOf('gamma') }, nameOf);
			assert.deepStrictEqual(m.effects, [{ name: 'Black Hole', count: 1 }, { name: 'Pulsar', count: 2 }, { name: 'Wolf-Rayet', count: 1 }]);
			assert.strictEqual(environmentTags.summaryText(m), 'Chain: 1 Black Hole, 2 Pulsar, 1 Wolf-Rayet · Storm: Gamma in Futzchag');
		});

		it('says only what there is', () => {
			assert.strictEqual(environmentTags.summaryText(environmentTags.summaryModel([4], id => systems[id], {}, nameOf)), '');
			assert.strictEqual(environmentTags.summaryText(environmentTags.summaryModel([3], id => systems[id], {}, nameOf)), 'Chain: 1 Wolf-Rayet');
			assert.strictEqual(environmentTags.summaryText(environmentTags.summaryModel([4], id => systems[id], { 4: stormOf('electric') }, nameOf)), 'Storm: Electric in Futzchag');
			assert.strictEqual(environmentTags.summaryText(environmentTags.summaryModel([], id => systems[id], null, nameOf)), '');
		});

		it('caps the storm list', () => {
			const storms = { 1: stormOf('gamma'), 3: stormOf('plasma'), 4: stormOf('exotic'), 5: stormOf('electric'), 6: stormOf('gamma') };
			const text = environmentTags.summaryText(environmentTags.summaryModel([1, 3, 4, 5, 6], id => systems[id], storms, nameOf));
			assert.ok(text.indexOf('Storms: Gamma in J1, Plasma in J3, Exotic in Futzchag, +2 more') >= 0, text);
		});
	});

	describe('ago', () => {
		it('words the age', () => {
			assert.strictEqual(environmentTags.ago(60000), 'just now');
			assert.strictEqual(environmentTags.ago(30 * 60000), '30 min ago');
			assert.strictEqual(environmentTags.ago(5 * 3600000), '5 h ago');
			assert.strictEqual(environmentTags.ago(72 * 3600000), '3 d ago');
		});
	});
});
