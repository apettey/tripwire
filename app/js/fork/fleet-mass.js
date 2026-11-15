const fleetMass = {
	// "Will my fleet fit through this hole?" (fork feature: fleet-mass-check).
	// Paste the in-game fleet composition (Fleet window > Fleet Composition, select all, copy), a d-scan or a list of ship
	// names; the Mass dialog then says per hull whether it fits the hole's jump limit, how many passes the hole takes
	// before it is at risk, and how many of each hull a fresh hole of this type takes. Paste only: no ESI.
	// Hull masses: appData.mass (tools/mass.json). Hot = hull + the usual prop mod for its size (propKg, rollingCalc.passMass);
	// the remaining-mass range and verdicts are the rolling calculator's (rollingCalc.remaining / classify).

	MAX_LINES: 2000,
	MAX_COUNT: 1000,		// "250x Rifter" and up is a typo, not a fleet
	MAX_UNKNOWN_SHOWN: 8,

	// Hull groups players ask about by name (patch 24.01 cut Marauder and Black Ops mass). A fleet composition paste
	// carries the group in its own column; for d-scans and lists these names decide it.
	GROUPS: {
		"Marauder": ["Paladin", "Golem", "Kronos", "Vargur"],
		"Black Ops": ["Sin", "Redeemer", "Widow", "Panther", "Marshal"]
	},

	/** Whether the feature is on for this user (options.fleetMass.enabled; missing = on) */
	enabled: function(opts) {
		return !(opts && opts.fleetMass && opts.fleetMass.enabled === false);
	},

	/** Lower-case ship name -> {typeID, name, mass} from appData.mass ({typeID: {typeName, mass}}) */
	nameIndex: function(massTable) {
		const index = {};
		Object.keys(massTable || {}).forEach(function(typeID) {
			const t = massTable[typeID];
			const mass = t ? parseFloat(t.mass) : NaN;
			if (!t || !t.typeName || !(mass > 0)) { return; }
			index[String(t.typeName).toLowerCase()] = { typeID: Number(typeID), name: String(t.typeName), mass: mass };
		});
		return index;
	},

	/** The group a hull belongs to: the paste's own group column, else GROUPS, else '' */
	groupOf: function(name, pasted) {
		if (pasted) { return pasted; }
		const groups = Object.keys(fleetMass.GROUPS);
		for (let i = 0; i < groups.length; i++) {
			if (fleetMass.GROUPS[groups[i]].indexOf(name) >= 0) { return groups[i]; }
		}
		return '';
	},

	clean: function(s) {
		return String(s === undefined || s === null ? '' : s).replace(/[​-‍⁠﻿ ]/g, ' ').replace(/\s+/g, ' ').trim();
	},

	/** A fleet composition row: Pilot, System, Ship type, Ship group, Position, Skills "5 - 5 - 5" [, Wing / Squad]
		(the format aa-intel-tool's fleetcomp parser reads). @return {ship, group} or null */
	fleetRow: function(fields) {
		if (fields.length < 6 || !/^[0-5] - [0-5] - [0-5]$/.test(fleetMass.clean(fields[5]))) { return null; }
		const ship = fleetMass.clean(fields[2]);
		return ship ? { ship: ship, group: fleetMass.clean(fields[3]) } : null;
	},

	/** A plain-text line: "Paladin", "3x Paladin", "3 Paladin", "Paladin x3", "Paladin 3", "Paladin<TAB>3", "[Paladin, fit]"
		@return {name, count} candidates to try in order (the whole line first, so a name ending in a number still matches) */
	listCandidates: function(line) {
		let text = fleetMass.clean(line.replace(/\t/g, ' ')).replace(/^[-*•]\s*/, '');
		const eft = /^\[([^,\]]+),[^\]]*\]$/.exec(text);
		if (eft) { text = fleetMass.clean(eft[1]); }
		const out = [{ name: text, count: 1 }];
		let m = /^(\d{1,4})\s*[x×*]?\s+(.+)$/i.exec(text) || /^(\d{1,4})\s*[x×*]\s*(.+)$/i.exec(text);
		if (m) { out.push({ name: m[2], count: parseInt(m[1], 10) }); }
		m = /^(.+?)\s*[x×*]\s*(\d{1,4})$/i.exec(text) || /^(.+?)\s+(\d{1,4})$/.exec(text);
		if (m) { out.push({ name: m[1], count: parseInt(m[2], 10) }); }
		return out;
	},

	/**
	 * Parse a paste into hulls.
	 * @param text fleet composition, d-scan (typeID, name, type, distance; or the old 3 columns) or ship names
	 * @param massTable appData.mass
	 * @return {format: 'fleet'|'dscan'|'list'|'' (most rows), hulls: [{typeID, name, group, count, hullKg}] (heaviest
	 *   first), ships: total count, unknown: [{name, count}], skipped: d-scan rows that aren't ships, lines: rows read}
	 */
	parse: function(text, massTable) {
		const index = fleetMass.nameIndex(massTable);
		const table = massTable || {};
		const byType = {}, unknown = {}, kinds = { fleet: 0, dscan: 0, list: 0 };
		let skipped = 0, lines = 0;
		const add = function(hull, count, group) {
			const key = String(hull.typeID);
			const h = byType[key] = byType[key] || { typeID: hull.typeID, name: hull.name, group: fleetMass.groupOf(hull.name, group), count: 0, hullKg: hull.mass };
			if (!h.group && group) { h.group = group; }
			h.count += count;
		};
		const miss = function(name, count) {
			const k = fleetMass.clean(name);
			if (!k) { return; }
			unknown[k] = (unknown[k] || 0) + count;
		};
		String(text || '').split(/\r\n|\r|\n/).slice(0, fleetMass.MAX_LINES).forEach(function(raw) {
			const line = raw.replace(/\s+$/, '');
			if (!fleetMass.clean(line)) { return; }
			lines++;
			const fields = line.indexOf('\t') >= 0 ? line.replace(/\t+$/, '').split(/\t+/) : [line];
			const fleet = fields.length >= 6 ? fleetMass.fleetRow(fields) : null;
			if (fleet) {
				kinds.fleet++;
				const hull = index[fleet.ship.toLowerCase()];
				if (hull) { add(hull, 1, fleet.group); } else { miss(fleet.ship, 1); }
				return;
			}
			// D-scan: typeID, name, type, distance (or the old name, type, distance). Rows that aren't ships (structures,
			// wrecks, drones, celestials) have no hull mass and are skipped, not reported.
			const typed = fields.length >= 4 && /^\d{1,10}$/.test(fleetMass.clean(fields[0]));
			if (typed || fields.length === 3) {
				kinds.dscan++;
				const t = typed ? table[parseInt(fleetMass.clean(fields[0]), 10)] : null;
				const hull = typed ? (t && parseFloat(t.mass) > 0 ? { typeID: parseInt(fleetMass.clean(fields[0]), 10), name: String(t.typeName), mass: parseFloat(t.mass) } : null) :
					index[fleetMass.clean(fields[1]).toLowerCase()];
				if (hull) { add(hull, 1, ''); } else { skipped++; }
				return;
			}
			kinds.list++;
			const candidates = fleetMass.listCandidates(line);
			for (let i = 0; i < candidates.length; i++) {
				const c = candidates[i];
				const hull = index[fleetMass.clean(c.name).toLowerCase()];
				if (hull && c.count >= 1 && c.count <= fleetMass.MAX_COUNT) { add(hull, c.count, ''); return; }
			}
			miss(candidates[0].name, 1);
		});
		const hulls = Object.keys(byType).map(function(k) { return byType[k]; })
			.sort(function(a, b) { return b.hullKg - a.hullKg || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
		const format = lines ? ['fleet', 'dscan', 'list'].reduce(function(best, k) { return kinds[k] > kinds[best] ? k : best; }, 'fleet') : '';
		return {
			format: format, hulls: hulls,
			ships: hulls.reduce(function(n, h) { return n + h.count; }, 0),
			unknown: Object.keys(unknown).map(function(k) { return { name: k, count: unknown[k] }; }),
			skipped: skipped, lines: lines
		};
	},

	/** Mass the usual prop mod adds to a hull of this mass (kg), from the module masses the fitted jump mass feature
		uses (fit-mass-data.js): 1MN 500 t for frigates and destroyers, 10/50MN 5,000 t for cruisers and battlecruisers,
		100/500MN 50,000 t for battleships (Nestor at 20,000 t; heavier barges and haulers are counted on the safe side)
		and 500,000 t for capitals (the mass log's capital rule). A capsule has none. */
	propKg: function(hullKg) {
		const hull = Number(hullKg);
		if (!(hull > 100e3)) { return 0; }
		return hull <= 5e6 ? 500e3 : hull < 20e6 ? 5e6 : hull <= 500e6 ? 50e6 : 500e6;
	},

	/** Mass of one pass of a hull through a hole: hot (prop mod on, propKg) when asked and under the jump limit, else
		cold when that fits. @return {kg, hot, fits: true|false|null (no jump limit known), coldOnly} */
	hullPass: function(hullKg, jumpKg, hot) {
		const cold = rollingCalc.passMass(hullKg);
		const warm = rollingCalc.passMass(hullKg, { prop: true, propKg: fleetMass.propKg(hullKg) });
		const limit = Number(jumpKg) > 0 ? Number(jumpKg) : null;
		if (cold === null) { return { kg: null, hot: false, fits: null, coldOnly: false }; }
		if (limit === null) { return { kg: hot ? warm : cold, hot: !!hot, fits: null, coldOnly: false }; }
		if (cold > limit) { return { kg: null, hot: false, fits: false, coldOnly: false }; }
		if (hot && warm > limit) { return { kg: cold, hot: false, fits: true, coldOnly: true }; }
		return { kg: hot ? warm : cold, hot: !!hot, fits: true, coldOnly: false };
	},

	/** How many passes of passKg a hole with this remaining range takes.
		@return {safe: passes that can't collapse it even at its lightest, most: passes that can get through at all (the
		last of them may close it, at the hole's heaviest)} or null */
	countIn: function(range, passKg) {
		const m = Number(passKg);
		if (!range || !range.known || !(m > 0)) { return null; }
		// pass k is safe while k * m < min (strictly: equal to the remaining mass closes the hole)
		const safe = range.min > 0 ? Math.max(0, Math.ceil(range.min / m) - 1) : 0;
		// pass k still goes through while (k - 1) * m < max; it closes the hole for sure once k * m >= max
		const most = range.max > 0 ? Math.max(0, Math.ceil(range.max / m)) : 0;
		return { safe: Math.min(safe, 99999), most: Math.min(Math.max(most, safe), 99999) };
	},

	/** The remaining range of a fresh (unjumped, stable) hole of this total mass */
	freshRange: function(totalKg) {
		return rollingCalc.remaining(totalKg, 0, 'stable');
	},

	/**
	 * The fleet against one hole.
	 * @param fleet parse() result
	 * @param hole {totalKg, jumpKg, usedKg, massState} (totalKg null for an unknown or inferred type)
	 * @param opts {hot: prop mods on (default true), back: out and back}
	 * @return {range, fresh, hulls: [{...hull, pass, now, freshCount}], passes, totalKg, tooHeavy, verdict, safePasses,
	 *   closedBy (pass number that certainly closes it, or null), stranded (ships left behind when it closes at the
	 *   earliest), back}
	 */
	check: function(fleet, hole, opts) {
		opts = opts || {};
		hole = hole || {};
		const hot = opts.hot !== false;
		const range = rollingCalc.remaining(hole.totalKg, hole.usedKg, hole.massState);
		const fresh = fleetMass.freshRange(hole.totalKg);
		const hulls = (fleet && fleet.hulls || []).map(function(h) {
			const pass = fleetMass.hullPass(h.hullKg, hole.jumpKg, hot);
			return Object.assign({}, h, {
				pass: pass,
				now: pass.kg ? fleetMass.countIn(range, pass.kg) : null,
				freshCount: pass.kg ? fleetMass.countIn(fresh, pass.kg) : null
			});
		});
		// One leg: every ship that can jump, lightest first (the order that gets the most ships through safely)
		const leg = [];
		let tooHeavy = 0;
		hulls.forEach(function(h) {
			if (h.pass.fits === false) { tooHeavy += h.count; return; }
			for (let i = 0; i < h.count; i++) { leg.push(h.pass.kg); }
		});
		leg.sort(function(a, b) { return a - b; });
		const passes = opts.back ? leg.concat(leg) : leg;
		const totalKg = passes.reduce(function(s, kg) { return s + kg; }, 0);
		let safePasses = null, closedBy = null;
		if (range.known && passes.length) {
			let sum = 0;
			safePasses = 0;
			for (let i = 0; i < passes.length; i++) {
				if (sum + passes[i] < range.min && safePasses === i) { safePasses = i + 1; }
				sum += passes[i];
				if (closedBy === null && sum >= range.max) { closedBy = i + 1; }
			}
		}
		return {
			range: range, fresh: fresh, hulls: hulls, passes: passes.length, legShips: leg.length, totalKg: totalKg,
			tooHeavy: tooHeavy, back: !!opts.back, hot: hot,
			verdict: passes.length ? rollingCalc.classify(range, totalKg) : 'unknown',
			safePasses: safePasses, closedBy: closedBy
		};
	},

	/** Per fresh hole of this type, for the heaviest hull of each GROUPS group: [{group, name, pass, count}] */
	reference: function(massTable, hole, hot) {
		const index = fleetMass.nameIndex(massTable);
		const fresh = fleetMass.freshRange(hole && hole.totalKg);
		return Object.keys(fleetMass.GROUPS).map(function(group) {
			const heaviest = fleetMass.GROUPS[group].map(function(n) { return index[n.toLowerCase()]; }).filter(Boolean)
				.sort(function(a, b) { return b.mass - a.mass; })[0];
			if (!heaviest) { return null; }
			const pass = fleetMass.hullPass(heaviest.mass, hole && hole.jumpKg, hot !== false);
			return { group: group, name: heaviest.name, hullKg: heaviest.mass, pass: pass, count: pass.kg ? fleetMass.countIn(fresh, pass.kg) : null };
		}).filter(Boolean);
	},

	// ---- Rendering (plain strings; every pasted value is escaped) ----

	escape: function(s) {
		return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function(c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	},

	/** "12,345 t" */
	formatT: function(kg) {
		return String(Math.round(Number(kg) / 1000)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' t';
	},

	FORMATS: { fleet: 'fleet composition', dscan: 'd-scan', list: 'ship list' },
	VERDICTS: { safe: 'Safe', may: 'May collapse', collapse: 'Will collapse', unknown: 'Unknown' },
	ICONS: { safe: '✓', may: '!', collapse: '✕', unknown: '?' },

	countText: function(c) {
		if (!c) { return '-'; }
		return c.most > c.safe ? c.safe + ' safely, up to ' + c.most : String(c.safe);
	},

	/**
	 * The result block under the paste box.
	 * @param fleet parse() result, result check() result
	 * @param ctx {typeName: 'B274' or '', inferred: bool (type guessed from the systems), farName, homeName,
	 *   preserved: preserve-mass warning or '', reference: reference() rows}
	 */
	resultHtml: function(fleet, result, ctx) {
		const e = fleetMass.escape, t = fleetMass.formatT;
		ctx = ctx || {};
		if (!fleet || !fleet.lines) { return ''; }
		let html = '';
		if (!fleet.ships) {
			html += "<p class='fleet-mass-note'>No ships recognised. Paste the fleet composition, a d-scan or ship names (one per line, \"3x Paladin\" works too).</p>";
		} else {
			const coldKg = fleet.hulls.reduce(function(s, h) { return s + h.hullKg * h.count; }, 0);
			html += "<p><b>" + fleet.ships + " ship" + (fleet.ships === 1 ? "" : "s") + "</b> from the " + e(fleetMass.FORMATS[fleet.format] || 'paste') +
				", " + t(coldKg) + " cold" + (result.hot ? ", " + t(fleet.hulls.reduce(function(s, h) { return s + (h.hullKg + fleetMass.propKg(h.hullKg)) * h.count; }, 0)) + " hot" : "") + ".</p>";
		}
		if (fleet.unknown.length) {
			const shown = fleet.unknown.slice(0, fleetMass.MAX_UNKNOWN_SHOWN).map(function(u) { return e(u.name) + (u.count > 1 ? " (" + u.count + ")" : ""); });
			html += "<p class='fleet-mass-note'>Not recognised, left out: " + shown.join(", ") +
				(fleet.unknown.length > shown.length ? " and " + (fleet.unknown.length - shown.length) + " more" : "") + ".</p>";
		}
		if (fleet.skipped) { html += "<p class='fleet-mass-note'>" + fleet.skipped + " d-scan row" + (fleet.skipped === 1 ? " that isn't a ship" : "s that aren't ships") + " left out.</p>"; }
		if (ctx.preserved) { html += "<p class='fleet-mass-warning'>" + e(ctx.preserved) + "</p>"; }
		if (!fleet.ships) { return html; }

		const known = result.range && result.range.known;
		if (!known) {
			html += "<p class='fleet-mass-note'>" + (ctx.inferred ? "The hole type is inferred from the systems, so the jump limit is a size guess and there are no counts. " :
				"The hole's mass is unknown, so there are no counts. ") + "Set the hole's type in its signature for the full check.</p>";
		} else {
			const v = result.verdict;
			const legText = result.back ? "Out and back (" + result.passes + " passes)" : "Whole fleet through (" + result.passes + " pass" + (result.passes === 1 ? "" : "es") + ")";
			html += "<p class='fleet-mass-verdict fleet-mass-" + v + "'>" + legText + ": <span class='fleet-mass-badge'><span aria-hidden='true'>" + fleetMass.ICONS[v] + "</span> " +
				fleetMass.VERDICTS[v] + "</span> " + t(result.totalKg) + " of " + t(Math.floor(result.range.min / 1000) * 1000) + " – " +
				t(Math.ceil(result.range.max / 1000) * 1000) + " left.</p>";
			if (result.passes && v !== 'safe' && result.safePasses !== null) {
				html += "<p>Lightest first" + (result.back ? ", everyone out then back" : "") + ": the first <b>" + result.safePasses + "</b> of " + result.passes +
					" passes are safe" + (result.closedBy !== null ? "; pass " + result.closedBy + " closes the hole at the latest" : "; after that it depends on the hole's real mass (±10%)") + ".</p>";
			}
		}
		if (result.tooHeavy) {
			html += "<p class='fleet-mass-warning'>" + result.tooHeavy + " ship" + (result.tooHeavy === 1 ? " is" : "s are") + " too heavy for this hole's jump limit and can't jump it.</p>";
		}

		const jump = function(h) {
			if (h.pass.fits === false) { return "<span class='fleet-mass-no'>✕ Too heavy</span>"; }
			if (h.pass.fits === null) { return "?"; }
			return "<span class='fleet-mass-yes'>✓</span>" + (h.pass.coldOnly ? " cold only" : "");
		};
		html += "<table class='fleet-mass-table'><thead><tr><th>Hull</th><th>#</th><th data-tooltip='Mass of one jump: hull, plus the prop mod when hot (500 t frigates and destroyers, 5,000 t cruisers and battlecruisers, 50,000 t battleships, 500,000 t capitals)'>Jump mass</th>" +
			"<th data-tooltip='Under the jump limit of this hole type'>Fits</th>" +
			(known ? "<th data-tooltip='How many of this hull this hole takes now, given its logged mass and mass state'>This hole now</th>" : "") +
			(result.fresh && result.fresh.known ? "<th data-tooltip='How many of this hull a fresh hole of this type takes (its real mass is ±10%)'>Fresh " + e(ctx.typeName || "hole") + "</th>" : "") +
			"</tr></thead><tbody>";
		result.hulls.forEach(function(h) {
			html += "<tr><td>" + e(h.name) + (h.group ? " <span class='fleet-mass-group'>" + e(h.group) + "</span>" : "") + "</td><td>" + h.count + "</td>" +
				"<td>" + (h.pass.kg ? t(h.pass.kg) + (h.pass.hot ? " hot" : "") : "-") + "</td><td>" + jump(h) + "</td>" +
				(known ? "<td>" + fleetMass.countText(h.now) + "</td>" : "") +
				(result.fresh && result.fresh.known ? "<td>" + fleetMass.countText(h.freshCount) + "</td>" : "") + "</tr>";
		});
		html += "</tbody></table>";

		const ref = (ctx.reference || []).filter(function(r) { return !result.hulls.some(function(h) { return h.group === r.group; }); });
		if (ref.length && result.fresh && result.fresh.known) {
			html += "<p class='fleet-mass-note'>Per fresh " + e(ctx.typeName || "hole") + ": " + ref.map(function(r) {
				return r.pass.fits === false ? e(r.group) + "s can't jump it" :
					e(r.group) + " " + fleetMass.countText(r.count) + " (" + e(r.name) + ", " + t(r.pass.kg) + (r.pass.hot ? " hot" : "") + ")";
			}).join("; ") + ".</p>";
		}
		return html;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		const state = { text: '', hot: true, back: false, open: false, usedKg: null, tracked: false };
		const opts = function() { return typeof options !== "undefined" ? options : undefined; };

		function holeInfo() {
			const $d = $("#dialog-mass");
			const wormhole = typeof tripwire !== "undefined" && tripwire.client ? tripwire.client.wormholes[$d.data("id")] : null;
			if (!wormhole) { return null; }
			const a = tripwire.client.signatures[wormhole.initialID], b = tripwire.client.signatures[wormhole.secondaryID];
			if (!a || !b) { return null; }
			const real = wormhole.type && tripwire.wormholes[wormhole.type] && !tripwire.wormholes[wormhole.type].dummy ? tripwire.wormholes[wormhole.type] : null;
			let guess = null;
			if (!real) {
				// Same guess as the upstream dialog: a size bucket from the system classes (jump limit only)
				try { guess = wormholeAnalysis.likelyWormhole(a.systemID, b.systemID); } catch (e) { guess = null; }
			}
			const pm = typeof preserveMass !== "undefined" && preserveMass.flags ? preserveMass.flags[String(wormhole.id)] : null;
			return {
				wormhole: wormhole, typeName: real ? wormhole.type : '', inferred: !real,
				hole: { totalKg: real ? real.mass : null, jumpKg: real ? real.jump : (guess && guess.jump) || null,
					usedKg: state.usedKg || 0, massState: wormhole.mass },
				preserved: pm ? "Marked preserve mass" + (pm.setBy ? " by " + pm.setBy : "") + (pm.reason ? " (" + pm.reason + ")" : "") +
					": check before taking the fleet through." : ""
			};
		}

		function panel() {
			let $p = $("#fleet-mass");
			if (!$p.length) {
				$p = $("<div id='fleet-mass'><details class='fleet-mass-details'><summary><b>Fleet mass check</b> <span class='fleet-mass-sub'>will my fleet fit?</span></summary>" +
					"<textarea class='fleet-mass-paste' rows='4' spellcheck='false' placeholder='Paste the fleet composition (Fleet window > Fleet Composition, Ctrl+A, Ctrl+C), a d-scan, or ship names (\"3x Paladin\")'></textarea>" +
					"<p class='fleet-mass-controls'><label data-tooltip='Prop mod on for every jump (by hull size: 500 t to 500,000 t); ships it would put over the jump limit go cold'><input type='checkbox' class='fleet-mass-hot'> Prop mods on</label> " +
					"<label data-tooltip='Everyone goes out, then everyone comes back'><input type='checkbox' class='fleet-mass-back'> And back</label> " +
					"<button type='button' class='fleet-mass-clear'>Clear</button></p>" +
					"<div class='fleet-mass-result' aria-live='polite'></div></details></div>");
				const $anchor = $("#dialog-mass input[name='show-mass']").first().closest("p");
				if ($anchor.length) { $anchor.before($p); } else { $("#dialog-mass").append($p); }
			}
			return $p;
		}

		function render() {
			const $p = panel();
			if (!fleetMass.enabled(opts())) { $p.hide(); return; }
			const info = holeInfo();
			if (!info) { $p.hide(); return; }
			$p.show();
			$p.find(".fleet-mass-details").prop("open", state.open);
			const $ta = $p.find(".fleet-mass-paste");
			if ($ta.val() !== state.text) { $ta.val(state.text); }
			$p.find(".fleet-mass-hot").prop("checked", state.hot);
			$p.find(".fleet-mass-back").prop("checked", state.back);
			const table = typeof appData !== "undefined" ? appData.mass : {};
			const fleet = fleetMass.parse(state.text, table);
			const result = fleetMass.check(fleet, info.hole, { hot: state.hot, back: state.back });
			$p.find(".fleet-mass-result").html(fleetMass.resultHtml(fleet, result, {
				typeName: info.typeName, inferred: info.inferred, preserved: info.preserved,
				reference: fleetMass.reference(table, info.hole, state.hot)
			}));
			if (fleet.ships && !state.tracked && typeof forkUsage !== "undefined") {
				state.tracked = true;
				forkUsage.track("fleetMass", "checked");
			}
		}

		$(document).on("input", "#fleet-mass .fleet-mass-paste", function() { state.text = String($(this).val() || ''); render(); });
		$(document).on("change", "#fleet-mass .fleet-mass-hot", function() { state.hot = $(this).prop("checked"); render(); });
		$(document).on("change", "#fleet-mass .fleet-mass-back", function() { state.back = $(this).prop("checked"); render(); });
		$(document).on("click", "#fleet-mass .fleet-mass-clear", function() { state.text = ''; state.tracked = false; render(); $("#fleet-mass .fleet-mass-paste").focus(); });
		// <details> "toggle" doesn't bubble, so follow the summary click (it flips the open state after this handler)
		$(document).on("click", "#fleet-mass summary", function() { state.open = !$(this).parent().prop("open"); });

		// Each opening starts from the hole's own log (the paste stays: the same fleet is checked against several holes)
		$(document).on("dialogopen", "#dialog-mass", function() {
			state.usedKg = null; state.tracked = false;
			setTimeout(render, 0);
		});
		// The logged mass through this hole: parseMassData's total (after auto-mass's fitted masses, which wraps it first)
		if (typeof parseMassData === "function" && !parseMassData.fleetMassWrapped) {
			const previous = parseMassData;
			parseMassData = function() {
				const result = previous.apply(this, arguments);
				try {
					if ($("#dialog-mass").is(":visible") && result && typeof result.totalMass === "number") {
						state.usedKg = result.totalMass;
						render();
					}
				} catch (e) {
					if (typeof console !== "undefined") { console.warn("fleet-mass: could not render", e); }
				}
				return result;
			};
			Object.keys(previous).forEach(function(k) { parseMassData[k] = previous[k]; });
			parseMassData.fleetMassWrapped = true;
		}

		/** Open a hole's Mass dialog with the fleet check expanded and the paste box focused */
		fleetMass.open = function(wormholeID) {
			const w = tripwire.client.wormholes[wormholeID];
			if (!w) { return; }
			const a = tripwire.client.signatures[w.initialID], b = tripwire.client.signatures[w.secondaryID];
			// "Into" the side away from the viewed system, like opening Mass on the far node
			const far = a && b ? rollingCalc.sides(a, b, undefined, typeof viewingSystemID !== "undefined" ? viewingSystemID : undefined).far.systemID : null;
			state.open = true;
			$("#dialog-mass").data("id", w.id).data("systemID", far).dialog("open");
			setTimeout(function() { $("#fleet-mass .fleet-mass-paste").focus(); }, 50);
		};

		// Command palette (Ctrl+K): "Fleet mass check <hole>"
		if (typeof forkCommands !== "undefined") {
			forkCommands.register({
				id: "fleetMass.check", title: "Fleet mass check", group: "Holes", icon: "connection",
				keywords: ["fleet", "mass", "fit", "jump", "composition", "marauder", "black ops", "will it fit"],
				enabled: function(ctx) {
					if (!fleetMass.enabled(opts())) { return "Fleet mass check is switched off in Settings"; }
					return ctx.holes().length ? true : "No wormholes on the chain map";
				},
				args: [{ name: "hole", label: "hole", type: "hole" }],
				run: function(args) { fleetMass.open(args.hole); }
			});
		}

		// Settings > Wormhole Jumps & Mass (Reset = on)
		if (typeof forkSettings !== "undefined") {
			forkSettings.register({
				section: "jumps", order: 23, id: "fleetMass-enabled", type: "checkbox", key: "fleetMass",
				label: "Fleet mass check:", text: "Show \"Will my fleet fit?\" in the mass dialog",
				get: function(o) { return fleetMass.enabled(o); },
				set: function(o, on) { o.fleetMass = { enabled: on }; }
			});
		}

		// Tip (hints.js): paste-only, so easy to miss. When a hole's Mass dialog opens, point at the section.
		if (typeof forkHints !== "undefined") {
			forkHints.register({
				id: "fleetMass.dialog", feature: "fleetMass", section: "jumps",
				trigger: "dialog.open", kind: "callout", placement: "right", dialog: "#dialog-mass",
				eligible: function(ctx, data) { return !!data && data.id === "dialog-mass" && fleetMass.enabled(ctx.options) && !!holeInfo(); },
				anchor: function() { return $("#fleet-mass summary:visible")[0] || null; },
				title: "Will your fleet fit?",
				body: "Paste your fleet composition, a d-scan or ship names here to see which hulls fit this hole, how many passes it takes "
					+ "before it may collapse, and how many Marauders or Black Ops a fresh hole of this type takes. Turn it off in Settings > Wormhole Jumps & Mass."
					+ "\n\nTurn tips off in Settings > General.",
				action: { label: "Show me", run: function() {
					state.open = true;
					$("#fleet-mass .fleet-mass-details").prop("open", true);
					$("#fleet-mass .fleet-mass-paste").focus();
				} },
				priority: 45, maxShows: 2, cooldownHours: 72, ttlSeconds: 600
			});
		}
	});
}
