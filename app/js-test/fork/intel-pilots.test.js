const assert = require('assert');
const { include, loadJSON } = require('../helpers/helpers');
include('app/js/fork/intel-scans');
include('app/js/fork/intel-pilots');

const types = loadJSON('public/intel/types');

const FRIENDLY_CORP = 98000001;
const RAIDERS = 98000002;
const LONERS = 98000003;
const ALLIANCE = 99000001;
const NPC = 1000167;
const danger = (d, kills, solo, ships) => ({ danger: d, gang: 100 - d, kills: kills, losses: 3, solo: solo || 0, kills7d: 2, lastMonth: "2026-10", ships: ships || [] });

const NAMES = ["Raider One", "<img src=x onerror=alert(1)>", "Raider Three", "Loner", "Friend", "Newbie", "Ghost", "Pending Pilot"];
const VIEW = {
	scanID: 7, lookups: true, threat: true, pending: 1, threatPending: false,
	friendly: { corporations: [FRIENDLY_CORP], alliances: [] },
	pilots: [
		[101, RAIDERS, ALLIANCE, danger(92, 400, 150, [[29984, "Tengu", 9]])],
		[102, RAIDERS, ALLIANCE, danger(60, 30)],
		[103, LONERS, ALLIANCE, "q"],
		[104, LONERS, null, null],
		[105, FRIENDLY_CORP, null, null],
		[106, NPC, null, danger(10, 2)],
		[0, null, null, null],
		[null, null, null, null]
	],
	entities: { [RAIDERS]: ["<b>Raiders</b>", "R&D"], [LONERS]: ["Loners", "LONE"], [ALLIANCE]: ["The Alliance", "ALLY"], [FRIENDLY_CORP]: ["Friends", "FRND"] }
};
const ctx = (extra) => Object.assign({ scanID: 7, names: NAMES, view: VIEW, types: types, expanded: {}, affiliation: true, threat: true }, extra || {});

describe('Intel pilots (who is in local)', () => {
	describe('settings', () => {
		it('groups and threat are on by default and can be turned off', () => {
			assert.equal(intelPilots.affiliation(undefined), true);
			assert.equal(intelPilots.affiliation({ intelScans: {} }), true);
			assert.equal(intelPilots.affiliation({ intelScans: { affiliation: false } }), false);
			assert.equal(intelPilots.threat({}), true);
			assert.equal(intelPilots.threat({ intelScans: { threat: false } }), false);
			assert.equal(intelPilots.threat({ intelScans: { affiliation: false } }), true);
		});
	});

	describe('grouping', () => {
		const g = intelPilots.group(NAMES, VIEW);
		it('groups by alliance, then corporation', () => {
			assert.deepEqual(g.groups.map(x => [x.key, x.count, x.friendly]), [["a" + ALLIANCE, 3, false], ["c" + LONERS, 1, false], ["c" + FRIENDLY_CORP, 1, true]]);
			assert.deepEqual(g.groups[0].corps.map(c => [c.id, c.count, c.ticker]), [[RAIDERS, 2, "R&D"], [LONERS, 1, "LONE"]]);
			assert.equal(g.groups[0].ticker, "ALLY");
		});
		it('friendly groups go last, the others biggest first', () => {
			assert.equal(g.friendly, 1);
			assert.equal(g.groups[g.groups.length - 1].friendly, true);
		});
		it('a friendly corporation in another alliance: only that corporation is friendly', () => {
			// Raiders (in the alliance) is friendly; the alliance and Loners are not
			const view = Object.assign({}, VIEW, { friendly: { corporations: [RAIDERS], alliances: [] } });
			const g = intelPilots.group(NAMES, view);
			const alliance = g.groups.filter(x => x.key === "a" + ALLIANCE)[0];
			assert.equal(alliance.friendly, false);
			assert.deepEqual(alliance.corps.map(c => [c.id, c.friendly]), [[LONERS, false], [RAIDERS, true]]);	// friendly last
			assert.deepEqual(alliance.pilots.map(p => p.friendly), [true, true, false]);
			assert.equal(g.friendly, 2);
			// The group's threat summary and badges leave the friendly pilots out (the server doesn't look them up)
			const html = intelPilots.groupThreatHtml(alliance, view, null);
			assert.equal(html.indexOf("Raider One"), -1);
			assert.ok(html.indexOf("Threat loading") >= 0);	// Raider Three (Loners) is still queued
			const expanded = {};
			expanded["7:a" + ALLIANCE] = true;
			expanded["7:a" + ALLIANCE + "c" + RAIDERS] = true;
			const body = intelPilots.html(ctx({ view: view, expanded: expanded }));
			assert.ok(body.indexOf("intel-friendly-tag") >= 0);	// on the nested corporation
			assert.equal(body.indexOf("intel-threat-high"), -1);	// Raider One's badge is gone
		});
		it('friendly by alliance too', () => {
			const view = Object.assign({}, VIEW, { friendly: { corporations: [], alliances: [ALLIANCE] } });
			assert.deepEqual(intelPilots.group(NAMES, view).groups.filter(x => x.friendly).map(x => x.key), ["a" + ALLIANCE]);
		});
		it('NPC corporations and unknown names go to one bucket, unanswered ones to another', () => {
			assert.deepEqual(g.other.map(p => p.name), ["Newbie", "Ghost"]);
			assert.deepEqual(g.pending.map(p => p.name), ["Pending Pilot"]);
			assert.equal(g.total, NAMES.length);
		});
		it('works without an answer', () => {
			const empty = intelPilots.group(["A", "B"], null);
			assert.deepEqual([empty.groups.length, empty.pending.length, empty.other.length], [0, 2, 0]);
		});
	});

	describe('threat', () => {
		it('levels', () => {
			assert.equal(intelPilots.threatLevel(danger(92, 400, 10), null).level, "high");
			assert.equal(intelPilots.threatLevel(danger(92, 5), null).level, "low");	// too few kills to tell
			assert.equal(intelPilots.threatLevel(danger(60, 30), null).level, "mid");
			assert.equal(intelPilots.threatLevel(danger(20, 30), null).level, "low");
			assert.equal(intelPilots.threatLevel(danger(null, 0), null).level, "none");
			assert.equal(intelPilots.threatLevel(null, null), null);
		});
		it('solo hunters and cyno-capable hulls', () => {
			const t = intelPilots.threatLevel(danger(92, 400, 150, [[29984, "Tengu", 3]]), types);	// Tengu: covert cyno
			assert.equal(t.solo, true);
			assert.equal(t.cyno, true);
			assert.equal(t.text, "☠ 92% solo");
			assert.ok(t.title.indexOf("Flies cyno-capable hulls") >= 0);
			assert.equal(intelPilots.threatLevel(danger(92, 400, 150, [[11987, "Guardian", 3]]), types).cyno, false);
			assert.equal(intelPilots.threatLevel(danger(92, 400, 10), null).solo, false);
		});
		it('badges: data, loading, failed, not looked up, friendly', () => {
			const p = (threat, id) => ({ name: "X", id: id === undefined ? 1 : id, threat: threat });
			assert.ok(intelPilots.badgeHtml(p(danger(92, 400)), VIEW, null).indexOf("intel-threat-high") >= 0);
			assert.ok(intelPilots.badgeHtml(p("q"), VIEW, null).indexOf("Threat loading") >= 0);
			assert.ok(intelPilots.badgeHtml(p(null), Object.assign({}, VIEW, { threatPending: true }), null).indexOf("Threat loading") >= 0);
			assert.ok(intelPilots.badgeHtml(p("f"), VIEW, null).indexOf("failed") >= 0);
			assert.ok(intelPilots.badgeHtml(p(null), VIEW, null).indexOf("Not looked up") >= 0);
			assert.equal(intelPilots.badgeHtml(p(null, null), VIEW, null), "");
			assert.equal(intelPilots.badgeHtml(Object.assign(p(danger(92, 400)), { friendly: true }), VIEW, null), "");
			assert.equal(intelPilots.badgeHtml(p(danger(92, 400)), Object.assign({}, VIEW, { threat: false }), null), "");
		});
		it('group rows show their most dangerous pilots', () => {
			const g = intelPilots.group(NAMES, VIEW);
			const html = intelPilots.groupThreatHtml(g.groups[0], VIEW, null);
			assert.ok(html.indexOf("intel-threat-high") >= 0);
			assert.ok(html.indexOf("Raider One 92%, &lt;img src=x onerror=alert(1)&gt; 60%") >= 0);
			assert.equal(html.indexOf("<img"), -1);
			assert.equal(intelPilots.groupThreatHtml(g.groups[2], VIEW, null), "");	// friendly
			assert.ok(intelPilots.groupThreatHtml(g.groups[1], Object.assign({}, VIEW, { threatPending: true }), null).indexOf("Threat loading") >= 0);
		});
	});

	describe('markup', () => {
		it('escapes hostile pilot, corporation and ticker names', () => {
			const expanded = {};
			expanded["7:a" + ALLIANCE] = true;
			expanded["7:a" + ALLIANCE + "c" + RAIDERS] = true;
			const html = intelPilots.html(ctx({ expanded: expanded }));
			assert.equal(html.indexOf("<img"), -1);
			assert.equal(html.indexOf("<b>"), -1);
			assert.ok(html.indexOf("&lt;img src=x onerror=alert(1)&gt;") >= 0);
			assert.ok(html.indexOf("[R&amp;D] &lt;b&gt;Raiders&lt;/b&gt;") >= 0);
		});
		it('collapsed groups show counts, tickers, a friendly tag and zKillboard links', () => {
			const html = intelPilots.html(ctx());
			assert.ok(html.indexOf("[ALLY] The Alliance") >= 0);
			assert.ok(html.indexOf("href='https://zkillboard.com/alliance/" + ALLIANCE + "/'") >= 0);
			assert.ok(html.indexOf("href='https://zkillboard.com/corporation/" + LONERS + "/'") >= 0);
			assert.ok(html.indexOf("intel-friendly-tag") >= 0);
			assert.ok(html.indexOf("NPC corp / unknown") >= 0);
			assert.ok(html.indexOf("looking up 1…") >= 0);
			assert.equal(html.indexOf("Raider Three"), -1);	// pilots only when expanded
		});
		it('expanding an alliance lists its corporations, expanding a corporation its pilots', () => {
			const expanded = {};
			expanded["7:a" + ALLIANCE] = true;
			let html = intelPilots.html(ctx({ expanded: expanded }));
			assert.ok(html.indexOf("[LONE] Loners") >= 0);
			assert.equal(html.indexOf("Raider Three"), -1);
			expanded["7:a" + ALLIANCE + "c" + LONERS] = true;
			html = intelPilots.html(ctx({ expanded: expanded }));
			assert.ok(html.indexOf("href='https://zkillboard.com/character/103/'") >= 0);
			assert.ok(html.indexOf("Threat loading") >= 0);	// Raider Three is queued
		});
		it('the NPC / unknown bucket lists its pilots', () => {
			const html = intelPilots.html(ctx({ expanded: { "7:other": true } }));
			assert.ok(html.indexOf(">Newbie</a>") >= 0);
			assert.ok(html.indexOf(">Ghost<") >= 0 && html.indexOf("character/0/") === -1);
		});
		it('loading state before the first answer', () => {
			const html = intelPilots.html(ctx({ view: null }));
			assert.ok(html.indexOf("Looking up corporations") >= 0);
			assert.ok(html.indexOf("&lt;img") >= 0 && html.indexOf("<img") === -1);
		});
		it('server without lookups: names are "not looked up"', () => {
			const view = Object.assign({}, VIEW, { lookups: false, pilots: NAMES.map(() => [null, null, null, null]) });
			const html = intelPilots.html(ctx({ view: view }));
			assert.ok(html.indexOf("Not looked up") >= 0);
			assert.equal(html.indexOf("looking up"), -1);
		});
		it('threat off: no badges', () => {
			const html = intelPilots.html(ctx({ threat: false }));
			assert.equal(html.indexOf("intel-threat"), -1);
		});
		it('groups off, threat on: most dangerous pilots only', () => {
			const html = intelPilots.html(ctx({ affiliation: false }));
			assert.ok(html.indexOf("Most dangerous") >= 0);
			assert.ok(html.indexOf("Raider One") < html.indexOf("&lt;img"));
			assert.equal(html.indexOf("intel-group"), -1);
			assert.equal(intelPilots.html(ctx({ affiliation: false, threat: false })), "");
		});
	});

	describe('Intel panel integration', () => {
		const local = { id: 7, kind: "local", data: { names: NAMES, invalid: 0 }, age: 30, createdBy: "Me", mine: true };
		it('replaces the plain name list with the groups', () => {
			const summary = intelScans.summarize(local);
			const html = intelScans.detailHtml(local, summary, 10000, false, { opts: {}, pilots: VIEW, types: types, expanded: {} });
			assert.ok(html.indexOf("intel-pilots") >= 0);
			assert.equal(html.indexOf("intel-names"), -1);
			const off = intelScans.detailHtml(local, summary, 10000, false, { opts: { intelScans: { affiliation: false, threat: false } }, pilots: VIEW, types: types, expanded: {} });
			assert.ok(off.indexOf("intel-names") >= 0);
			assert.equal(off.indexOf("intel-pilots"), -1);
		});
		it('ignores an answer for another scan, and the paste preview', () => {
			const summary = intelScans.summarize(local);
			const other = intelScans.detailHtml(local, summary, 10000, false, { opts: {}, pilots: Object.assign({}, VIEW, { scanID: 8 }), types: types, expanded: {} });
			assert.ok(other.indexOf("Looking up corporations") >= 0);
			assert.equal(intelScans.detailHtml(local, summary, 10000, true).indexOf("intel-pilots"), -1);
		});
		it('shows the ships of a d-scan shared around the same time', () => {
			const dscan = { id: 6, kind: "dscan", data: { rows: [[22456, "Sabre", "a", 10], [29984, "Tengu", "b", 20]], invalid: 0 }, age: 100 };
			const old = { id: 5, kind: "dscan", data: { rows: [[22456, "Sabre", "a", 10]], invalid: 0 }, age: 1000 };
			assert.equal(intelScans.shipsNear([local, dscan, old], local, types, 10000), 2);
			assert.equal(intelScans.shipsNear([local, old], local, types, 10000), undefined);
			assert.equal(intelScans.shipsNear([local, dscan], local, null, 10000), undefined);
			const html = intelScans.detailHtml(local, intelScans.summarize(local), 10000, false, { opts: {}, pilots: VIEW, types: types, expanded: {}, shipsOnScan: 2 });
			assert.ok(html.indexOf("8 pilots · 2 ships on scan") >= 0);
		});
		it('polls while the server is still looking up', () => {
			assert.equal(intelScans.pilotsBusy(VIEW, {}), true);	// a name pending
			const done = Object.assign({}, VIEW, { pending: 0, pilots: VIEW.pilots.filter(p => p[3] !== "q") });
			assert.equal(intelScans.pilotsBusy(done, {}), false);
			assert.equal(intelScans.pilotsBusy(Object.assign({}, done, { threatPending: true }), {}), true);
			assert.equal(intelScans.pilotsBusy(Object.assign({}, done, { threatPending: true }), { intelScans: { threat: false } }), false);
			assert.equal(intelScans.pilotsBusy(Object.assign({}, VIEW, { lookups: false }), {}), false);
		});
	});
});
