const rollingCalc = {
	// Worst-case rolling guidance for the mass dialog (fork feature: rolling-calculator).
	// A wormhole's real total mass is its nominal mass +-10%, fixed at spawn and unknown to players.

	VARIANCE: 0.1,

	/** Remaining mass as a fraction of the real total mass, per in-game mass state (wormholes.mass).
		stable: 50% or more left, destab: under 50%, critical: under 10%. */
	STATE_FRACTIONS: {
		stable: { min: 0.5, max: 1 },
		destab: { min: 0.1, max: 0.5 },
		critical: { min: 0, max: 0.1 }
	},

	/** Prop mod mass added to a hot jump: 50,000t, or 500,000t for capitals (same rule as the mass log). */
	propMass: function(hullKg) {
		return hullKg > 500e6 ? 500e6 : 50e6;
	},

	/** Mass a single pass takes off the hole: (hull + prop mod if hot) x2 with a Higgs anchor.
		mods.propKg: the fitted prop module's real mass addition (auto-mass-logging), used instead of the 50kt/500kt rule.
		@return kg, or null if the hull mass is unknown */
	passMass: function(hullKg, mods) {
		const hull = Number(hullKg);
		if (!(hull > 0)) { return null; }
		mods = mods || {};
		const prop = typeof mods.propKg === 'number' && mods.propKg >= 0 ? mods.propKg : rollingCalc.propMass(hull);
		return (hull + (mods.prop ? prop : 0)) * (mods.higgs ? 2 : 1);
	},

	/** Range of mass still left in the hole.
		@param totalKg nominal total mass of the wormhole type (kg)
		@param usedKg mass logged through this connection (kg)
		@param massState 'stable' | 'destab' | 'critical' | anything else (ignored)
		@return {known: false} without a total mass, else
			{known: true, min, max, logMin, logMax, state, inconsistent, overLogged}
			With a mass state, the log and the state are combined through the real total mass T: remaining is
			T - used, and the state says (T - used) / T is in [fmin, fmax], so T is in
			[used / (1 - fmin), used / (1 - fmax)], intersected with [0.9, 1.1] x nominal.
			inconsistent: no T fits both the log and the state (jumps missing from the log, or a stale state),
			or more was logged than the hole could ever take. Then the most cautious bounds are used:
			the lower of the two minimums and the higher of the two maximums. */
	remaining: function(totalKg, usedKg, massState) {
		const total = Number(totalKg);
		if (!(total > 0)) { return { known: false }; }
		const used = Number(usedKg) > 0 ? Number(usedKg) : 0;
		const lightest = total * (1 - rollingCalc.VARIANCE), heaviest = total * (1 + rollingCalc.VARIANCE);
		// More logged than even the heaviest hole could take: the log (or the type) is wrong, so it tells us nothing
		const overLogged = used >= heaviest;
		const logMin = overLogged ? 0 : Math.max(0, lightest - used), logMax = overLogged ? heaviest : heaviest - used;
		const fractions = rollingCalc.STATE_FRACTIONS[massState];
		let min = logMin, max = logMax, inconsistent = overLogged;
		if (fractions) {
			const stateMin = lightest * fractions.min, stateMax = heaviest * fractions.max;
			const tLow = overLogged ? Infinity : Math.max(lightest, used / (1 - fractions.min));
			const tHigh = Math.min(heaviest, fractions.max >= 1 ? Infinity : used / (1 - fractions.max));
			if (tLow <= tHigh) {
				min = tLow - used;
				max = tHigh - used;
			} else if (used === 0) {
				// Nothing logged but the hole is already reduced: nobody logged their jumps, the state alone decides
				min = stateMin;
				max = stateMax;
			} else {
				inconsistent = true;
				min = Math.min(logMin, stateMin);
				max = Math.max(logMax, stateMax);
			}
		}
		return { known: true, min: min, max: max, logMin: logMin, logMax: logMax,
			state: fractions ? massState : null, inconsistent: inconsistent, overLogged: overLogged };
	},

	/** Verdict for one pass of passKg through a hole with the given remaining range.
		'safe': cannot collapse even if the hole is at its lightest; 'collapse': collapses even at its heaviest;
		'may': depends on the hole's real mass; 'unknown': no range or no ship mass. */
	classify: function(range, passKg) {
		const m = Number(passKg);
		if (!range || !range.known || !(m > 0)) { return 'unknown'; }
		if (m < range.min) { return 'safe'; }
		if (m >= range.max) { return 'collapse'; }
		return 'may';
	},

	/** Range left after a pass of passKg, assuming the hole survived it. */
	afterPass: function(range, passKg) {
		if (!range || !range.known) { return { known: false }; }
		const m = Number(passKg) > 0 ? Number(passKg) : 0;
		return Object.assign({}, range, { min: Math.max(0, range.min - m), max: Math.max(0, range.max - m) });
	},

	/** Out-and-back plan.
		@param p {totalKg, jumpKg, usedKg, massState, outKg, backKg}
		@return {range, out: {mass, verdict, tooHeavy}, back: {mass, verdict, tooHeavy}, stranded, rearGuard}
			stranded: 'certain' | 'possible' | 'blocked' (return pass over the jump limit) | null (you'd end up on the far side)
			rearGuard: true when you get home but the return pass may close the hole behind you */
	plan: function(p) {
		p = p || {};
		const range = rollingCalc.remaining(p.totalKg, p.usedKg, p.massState);
		const leg = function(kg, r) {
			const mass = Number(kg) > 0 ? Number(kg) : null;
			const tooHeavy = !!(mass && Number(p.jumpKg) > 0 && mass > Number(p.jumpKg));
			return { mass: mass, tooHeavy: tooHeavy, verdict: tooHeavy ? 'too-heavy' : rollingCalc.classify(r, mass) };
		};
		const out = leg(p.outKg, range);
		const back = out.verdict === 'collapse' || out.verdict === 'too-heavy' ?
			{ mass: Number(p.backKg) > 0 ? Number(p.backKg) : null, tooHeavy: false, verdict: 'none' } :
			leg(p.backKg, rollingCalc.afterPass(range, out.mass));
		return {
			range: range,
			afterOut: rollingCalc.afterPass(range, out.mass),
			out: out,
			back: back,
			stranded: out.verdict === 'collapse' ? 'certain' : out.verdict === 'may' ? 'possible' :
				back.verdict === 'too-heavy' ? 'blocked' : null,
			rearGuard: out.verdict === 'safe' && (back.verdict === 'may' || back.verdict === 'collapse')
		};
	},

	LABELS: {
		safe: 'Safe',
		may: 'May collapse',
		collapse: 'Will collapse',
		'too-heavy': 'Too heavy to jump',
		unknown: 'Unknown',
		none: '-'
	},

	/** Mass in kt with thousands separators. round: 'floor' (for a minimum), 'ceil' (for a maximum), else nearest,
		so a bound is never shown on the wrong side of a ship mass. */
	formatKt: function(kg, round) {
		const fn = round === 'floor' ? Math.floor : round === 'ceil' ? Math.ceil : Math.round;
		return String(fn(kg / 1e6)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + 'kt';
	},

	/** Which end of a connection is home and which is far for an out-and-back pass.
		The far side is the chain node the dialog was opened from (clickedSystemID); if neither end is that,
		"out" goes away from the viewed system, else from the first signature's side.
		@return {home, far} (the given signature objects) */
	sides: function(sigA, sigB, clickedSystemID, viewingID) {
		if (clickedSystemID !== undefined && clickedSystemID !== null) {
			if (sigB.systemID == clickedSystemID && sigA.systemID != clickedSystemID) { return { home: sigA, far: sigB }; }
			if (sigA.systemID == clickedSystemID && sigB.systemID != clickedSystemID) { return { home: sigB, far: sigA }; }
		}
		return viewingID !== undefined && sigB.systemID == viewingID ? { home: sigB, far: sigA } : { home: sigA, far: sigB };
	},

	/** Default roller ships (kt): battleships for holes that pass them, a medium hull for smaller holes */
	ROLLERS: { bsCold: 200, bsHot: 300, medCold: 15, medHot: 60 },
	BATTLESHIP_HOLE_KG: 300e6,	// a hole that takes at least this per jump passes battleships
	MAX_STEPS: 12,
	LIVE_MS: 10000,	// how often an open mass dialog looks for new passes
	LIVE_TIMEOUT_MS: 15000,
	SUMMARY_ROW_IDS: ['small-mass', 'medium-mass', 'large-mass'],

	/** Which rows of the mass table body are jump rows. The dialog adds one row per parsed jump first, then the
		summary rows (small / medium / large by id, and a total row without one).
		@param ids the id of each tbody row in order @param jumpCount number of jumps in the log
		@return array of booleans */
	jumpRowFlags: function(ids, jumpCount) {
		return (ids || []).map(function(id, i) {
			return i < jumpCount && rollingCalc.SUMMARY_ROW_IDS.indexOf(id) < 0;
		});
	},

	/** Roller ships for a hole: {name, cold, hot} in kg.
		@param maxJumpKg the hole type's jump mass limit; a hole under 300kt (medium and small holes) gets the medium roller
		@param opts options.rollPlan {bsCold, bsHot, medCold, medHot} in kt (missing or invalid values use the defaults)
		A roller never exceeds the hole's jump limit: hot is clamped to it and cold to hot. */
	rollerProfile: function(maxJumpKg, opts) {
		const d = rollingCalc.ROLLERS, o = opts || {};
		const kt = function(v, fallback) { return Number(v) > 0 ? Number(v) : fallback; };
		const max = Number(maxJumpKg) > 0 ? Number(maxJumpKg) : 0;
		const battleship = !max || max >= rollingCalc.BATTLESHIP_HOLE_KG;
		let cold = (battleship ? kt(o.bsCold, d.bsCold) : kt(o.medCold, d.medCold)) * 1e6;
		let hot = (battleship ? kt(o.bsHot, d.bsHot) : kt(o.medHot, d.medHot)) * 1e6;
		if (max) { hot = Math.min(hot, max); }
		cold = Math.min(cold, hot);
		return { name: battleship ? 'battleship' : 'medium', cold: cold, hot: hot };
	},

	/** Step-by-step way to roll a hole shut with everyone ending on the home side.
		@param p {lo, hi, cold, hot, maxJump, rollerName} remaining mass range (worst case) and the roller's pass masses, kg
		@return {steps: [{dir: 'out'|'back', mass, kind: 'hot'|'cold', status: 'safe'|'may'|'will', after: {lo, hi}}],
			outcome: 'closes' (the last return pass will close it) | 'may-close' (it may; repeat the last pair if not) |
			'too-light' (not enough mass left for this roller to go out safely) | 'long' (cap reached) | 'unknown',
			warning: string, more: hot round trips left out after the listed ones, repeatFrom: step number to repeat (may-close)}
		Never recommends an outbound jump that may collapse the hole. */
	recommend: function(p) {
		p = p || {};
		let lo = Number(p.lo), hi = Number(p.hi);
		let hot = Number(p.hot), cold = Number(p.cold);
		const result = { steps: [], outcome: 'unknown', warning: '', more: 0, repeatFrom: 0 };
		if (!(hi > 0) || !(lo >= 0) || !(hot > 0)) { return result; }
		if (Number(p.maxJump) > 0) { hot = Math.min(hot, Number(p.maxJump)); }
		cold = cold > 0 ? Math.min(cold, hot) : hot;
		const push = function(dir, mass, kind, st) {
			lo = Math.max(0, lo - mass); hi = Math.max(0, hi - mass);
			result.steps.push({ dir: dir, mass: mass, kind: kind, status: st, after: { lo: lo, hi: hi } });
		};
		// Hot round trips while a whole one is safe even at the lightest hole; the first few are listed, the rest counted
		const pairs = 2 * hot < lo ? Math.ceil(lo / (2 * hot)) - 1 : 0;
		const listed = Math.min(pairs, Math.floor((rollingCalc.MAX_STEPS - 2) / 2));
		for (let i = 0; i < listed; i++) { push('out', hot, 'hot', 'safe'); push('back', hot, 'hot', 'safe'); }
		if (pairs > listed) {
			result.more = pairs - listed;
			result.moreAt = result.steps.length;
			lo = Math.max(0, lo - result.more * 2 * hot); hi = Math.max(0, hi - result.more * 2 * hot);
		}
		// Finish: an outbound pass under the lightest remaining mass, then a hot return
		for (;;) {
			if (result.steps.length + 2 > rollingCalc.MAX_STEPS) { result.outcome = 'long'; return result; }
			const kind = cold < lo ? 'cold' : hot < lo ? 'hot' : null;
			if (!kind) {
				result.outcome = 'too-light';
				result.warning = lo < 1e6 ? 'No ship can safely go out: the hole may close on any jump.' :
					'Too little mass left for a ' + (p.rollerName || 'battleship') + ' to go out safely: use a lighter ship out (under ' +
					rollingCalc.formatKt(lo, 'floor') + ') or accept the risk of being stranded.';
				return result;
			}
			push('out', kind === 'cold' ? cold : hot, kind, 'safe');
			const back = hot >= hi ? 'will' : hot >= lo ? 'may' : 'safe';
			push('back', hot, 'hot', back);
			if (back === 'will') { result.outcome = 'closes'; return result; }
			if (back === 'may') {
				result.outcome = 'may-close';
				result.repeatFrom = result.steps.length - 1;
				return result;
			}
		}
	},

	/** Overall verdict of an out-and-back plan: the worse of its two passes */
	worstVerdict: function(plan) {
		const order = ['safe', 'may', 'collapse', 'too-heavy'];
		const a = order.indexOf(plan.out.verdict), b = order.indexOf(plan.back.verdict);
		if (a < 0 && b < 0) { return 'unknown'; }
		return order[Math.max(a, b)];
	},

	/** Symbol that goes with a verdict, so colour is never the only signal */
	ICONS: { safe: '✓', may: '!', collapse: '✕', 'too-heavy': '⊘', unknown: '?', none: '-' },

	/** Jump log (newest first, as mass.php returns it) with the running total and the worst-case mass left after each pass.
		@param jumps [{mass}] newest first @param totalKg nominal total mass of the hole type (or 0)
		@return [{total, left}] in the same order; left is null without a total mass. */
	passLog: function(jumps, totalKg) {
		const list = jumps || [];
		const lightest = Number(totalKg) > 0 ? Number(totalKg) * (1 - rollingCalc.VARIANCE) : null;
		let sum = 0;
		const out = new Array(list.length);
		for (let i = list.length - 1; i >= 0; i--) {	// oldest first
			sum += Number(list[i] && list[i].mass) > 0 ? Number(list[i].mass) : 0;
			out[i] = { total: sum, left: lightest === null ? null : Math.max(0, lightest - sum) };
		}
		return out;
	},

	/** Number of passes and mass (kg) through a hole, from the raw mass.php rows.
		@param lookup function(row) -> pass mass in kg, or null for a row that can't be weighed (skipped) */
	summarisePasses: function(rows, lookup) {
		const out = { passes: 0, massKg: 0 };
		(Array.isArray(rows) ? rows : []).forEach(function(row) {
			const m = lookup(row);
			if (m > 0) { out.passes++; out.massKg += m; }
		});
		return out;
	},

	/** Text and status class for one step of recommend() */
	stepText: function(step, farName, homeName) {
		const where = step.dir === 'out' ? 'Out to ' + farName : 'Back to ' + homeName;
		return where + ' (' + step.kind + ', ' + rollingCalc.formatKt(step.mass) + ')';
	},

	/** HTML of the "How to roll this hole" panel body.
		@param rec recommend() result @param profile rollerProfile() result
		@param ctx {farName, homeName, startedText: 'Rolling started by X at HH:MM EVE' or '', preserved: preserve-mass warning or ''} */
	recommendHtml: function(rec, profile, ctx) {
		const e = rollingCalc.escape, L = { safe: 'Safe', may: 'May collapse', will: 'Will collapse' };
		const icon = { safe: rollingCalc.ICONS.safe, may: rollingCalc.ICONS.may, will: rollingCalc.ICONS.collapse };
		ctx = ctx || {};
		let html = '';
		if (ctx.preserved) { html += "<p class='rolling-warning'>" + e(ctx.preserved) + "</p>"; }
		if (ctx.startedText) { html += "<p class='rolling-note'>" + e(ctx.startedText) + "</p>"; }
		html += "<p class='rolling-note'>Assuming " + e(profile.name) + " rollers: " + rollingCalc.formatKt(profile.cold) + " cold / " +
			rollingCalc.formatKt(profile.hot) + " hot (change in Settings). Everyone starts in " + e(ctx.homeName) + ".</p>";
		if (rec.outcome === 'unknown' && !rec.steps.length) { return html + "<p class='rolling-hint'>Not enough information to plan.</p>"; }
		const more = "<li class='rolling-more'>" + rec.more + " more hot round trip" + (rec.more === 1 ? "" : "s") +
			" (out and back, " + rollingCalc.formatKt(profile.hot) + " each way), all safe</li>";
		html += "<ul class='rolling-steps'>" + rec.steps.map(function(s, i) {
			return (rec.more > 0 && rec.moreAt === i ? more : "") +
				"<li class='rolling-step rolling-step-" + s.status + "'><span class='rolling-step-num'>" + (i + 1) + ".</span> <span class='rolling-step-icon' aria-hidden='true'>" + icon[s.status] + "</span> " +
				e(rollingCalc.stepText(s, ctx.farName, ctx.homeName)) + " <span class='rolling-step-status'>" + L[s.status] + "</span></li>";
		}).join('') + (rec.more > 0 && rec.moreAt >= rec.steps.length ? more : "") + "</ul>";
		if (rec.outcome === 'closes') {
			html += "<p class='rolling-caution'>The hole closes on the way back, with everyone home.</p>";
		} else if (rec.outcome === 'may-close') {
			html += "<p class='rolling-caution'>The last return pass may close it. If it didn't close, repeat steps " + rec.repeatFrom +
				"&ndash;" + (rec.repeatFrom + 1) + " until it does.</p>";
		} else if (rec.outcome === 'long') {
			html += "<p class='rolling-note'>That is the first " + rollingCalc.MAX_STEPS + " steps; check the remaining mass again after them.</p>";
		} else if (rec.outcome === 'too-light') {
			html += "<p class='rolling-warning'>" + e(rec.warning) + "</p>";
		}
		return html;
	},

	escape: function(s) {
		return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function(c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	},

	/** Ship choices for the dialog: the current ship first, then ships seen in this hole's log (unique by name).
		@param currentShip {typeName, mass, propKg?, higgs?} or null; jumps parseMassData().jumps ({shipName, originalMass},
			plus fit: {source: 'assets', base, propMass, multiplier} and characterName for a logged fit, auto-mass-logging)
		A fitted ship's mass is hull + plates (before Higgs), with its real prop module (propKg) and Higgs anchor (higgs).
		currentCharacterID: with a current fit, that pilot's logged fits are left out (the current one is listed first). */
	shipChoices: function(currentShip, jumps, currentCharacterID) {
		const out = [], seen = {};
		const add = function(name, mass, current, fit) {
			if (!name || !(Number(mass) > 0) || seen[name]) { return; }
			seen[name] = true;
			const choice = { name: name, mass: Number(mass), current: !!current };
			if (fit) { choice.propKg = Number(fit.propKg) || 0; choice.higgs = !!fit.higgs; }
			out.push(choice);
		};
		if (currentShip) {
			add(currentShip.typeName, currentShip.mass, true, currentShip.propKg !== undefined ? currentShip : null);
		}
		(jumps || []).forEach(function(j) {
			if (!j) { return; }
			if (j.fit && j.fit.source === 'assets' && Number(j.fit.base) > 0) {
				if (currentShip && currentShip.propKg !== undefined && currentCharacterID && j.characterID == currentCharacterID) { return; }
				add(j.shipName + " (" + (j.characterName || "logged") + "'s fit)", j.fit.base, false,
					{ propKg: j.fit.propMass, higgs: Number(j.fit.multiplier) > 1 });
			} else {
				add(j.shipName, j.originalMass, false);
			}
		});
		return out;
	},

	/** Whether the feature is on (options.rollingCalc.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.rollingCalc && opts.rollingCalc.enabled === false);
	},

	/** Whether the "How to roll this hole" panel is on (options.rollPlan.enabled; on unless explicitly false) */
	planEnabled: function(opts) {
		return rollingCalc.enabled(opts) && !(opts && opts.rollPlan && opts.rollPlan.enabled === false);
	},

	/** HTML for the verdicts of a plan (from plan()) */
	planHtml: function(plan, outName, backName) {
		const e = rollingCalc.escape, L = rollingCalc.LABELS;
		if (!plan.range.known) {
			return "<p class='rolling-hint'>Set the hole type in the signature to get rolling guidance.</p>";
		}
		const r = plan.range;
		const row = function(label, leg) {
			return "<tr class='rolling-leg rolling-" + leg.verdict + "'><th>" + label + "</th>" +
				"<td>" + (leg.mass ? rollingCalc.formatKt(leg.mass) : '?') + "</td>" +
				"<td><span class='rolling-verdict'>" + L[leg.verdict] + "</span></td></tr>";
		};
		let html = "<p class='rolling-range'>Remaining: <b>" + rollingCalc.formatKt(r.min, 'floor') + " &ndash; " + rollingCalc.formatKt(r.max, 'ceil') + "</b>" +
			" <span class='rolling-note'>(worst case: &plusmn;10%" + (r.state ? ", " + e(r.state === 'critical' ? 'crit' : r.state) : "") + ")</span></p>";
		if (r.inconsistent) {
			html += "<p class='rolling-note'>" + (r.overLogged ?
				"More mass is logged than this hole can take; check the hole type. Ignoring the log." :
				"The logged mass doesn't fit the hole's mass state (jumps missing from the log, or the state is out of date); showing the widest range.") + "</p>";
		}
		html += "<table class='rolling-legs'><tbody>" +
			row("Out to " + e(outName), plan.out) +
			row("Back to " + e(backName), plan.back) +
			"</tbody></table>";
		if (plan.out.verdict === 'too-heavy') {
			html += "<p class='rolling-warning'>This ship is over the hole's jump mass limit.</p>";
		} else if (plan.stranded === 'certain') {
			html += "<p class='rolling-warning'>The out pass will collapse the hole: you will be stranded in " + e(outName) + ".</p>";
		} else if (plan.stranded === 'possible') {
			html += "<p class='rolling-warning'>The out pass may collapse the hole: you could be stranded in " + e(outName) + ".</p>";
		} else if (plan.stranded === 'blocked') {
			html += "<p class='rolling-warning'>Too heavy to jump back this way: you would be stranded in " + e(outName) + ".</p>";
		} else if (plan.rearGuard) {
			html += "<p class='rolling-caution'>The return pass " + (plan.back.verdict === 'collapse' ? 'will' : 'may') +
				" close the hole: you get home, but anyone still in " + e(outName) + " could be stranded.</p>";
		}
		return html;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		const state = { massData: null, choice: null, outProp: null, backProp: null, higgs: null, customKt: '', planOpen: null, fingerprint: null };

		function panel() {
			let $p = $("#rolling-calc");
			if (!$p.length) {
				$p = $("<div id='rolling-calc'></div>");
				const $total = $("#mass-jumped").closest("p");
				if ($total.length) { $total.after($p); } else { $("#dialog-mass").prepend($p); }
			}
			return $p;
		}

		function currentShip() {
			const eve = typeof tripwire !== "undefined" && tripwire.client ? tripwire.client.EVE : null;
			// The tracked character's fitted mass (auto-mass-logging), when its fit is known
			const fit = eve && eve.characterID && typeof autoMass !== "undefined" && autoMass.currentFit ? autoMass.currentFit(eve.characterID) : null;
			if (fit && fit.source === 'assets' && fit.mass && fit.mass.known) {
				return { typeName: fit.shipName + ", fitted", mass: fit.mass.base, propKg: fit.mass.prop ? fit.mass.prop.mass : 0, higgs: fit.mass.multiplier > 1 };
			}
			const data = eve && eve.shipTypeID && typeof appData !== "undefined" && appData.mass ? appData.mass[eve.shipTypeID] : null;
			return data ? { typeName: data.typeName, mass: parseFloat(data.mass) } : null;
		}

		// Same lookup as the upstream dialog: the hole's type, or one inferred from the system classes
		function holeInfo() {
			const wormhole = tripwire.client.wormholes[$("#dialog-mass").data("id")];
			if (!wormhole) { return null; }
			const a = tripwire.client.signatures[wormhole.initialID], b = tripwire.client.signatures[wormhole.secondaryID];
			if (!a || !b) { return null; }
			// No guidance on a type guessed from the system classes: its mass is only a size bucket
			const type = wormhole.type && tripwire.wormholes[wormhole.type] && !tripwire.wormholes[wormhole.type].dummy ?
				tripwire.wormholes[wormhole.type] : null;
			// "Out" goes to the chain node the dialog was opened from (global-hooks passes it as systemID)
			const s = rollingCalc.sides(a, b, $("#dialog-mass").data("systemID"),
				typeof viewingSystemID !== "undefined" ? viewingSystemID : undefined);
			const home = s.home, far = s.far;
			const name = function(id) {
				try { return systemAnalysis.analyse(id).name; } catch (e) { return String(id); }
			};
			return { wormhole: wormhole, type: type || {}, homeName: name(home.systemID), farName: name(far.systemID) };
		}

		function render() {
			state.lastKey = holeKey();
			const $p = panel();
			if (!rollingCalc.enabled(typeof options !== "undefined" ? options : undefined)) { $p.hide().empty(); planPanel().hide().empty(); return; }
			const info = holeInfo();
			if (!info || !state.massData) { $p.hide().empty(); planPanel().hide().empty(); return; }
			$p.show();

			const eve = tripwire.client ? tripwire.client.EVE : null;
			const ships = state.ships = rollingCalc.shipChoices(currentShip(), state.massData.jumps, eve ? eve.characterID : null);
			if (state.choice === null) { state.choice = ships.length ? ships[0].name : 'custom'; }
			const chosen = ships.filter(function(s) { return s.name === state.choice; })[0];
			if (state.higgs === null) { state.higgs = chosen && chosen.higgs !== undefined ? chosen.higgs : !!(tripwire.massOptions && tripwire.massOptions.higgs); }
			if (state.outProp === null) { state.outProp = !!(tripwire.massOptions && tripwire.massOptions.prop); }
			if (state.backProp === null) { state.backProp = state.outProp; }

			const ship = ships.filter(function(s) { return s.name === state.choice; })[0];
			const hull = ship ? ship.mass : parseFloat(state.customKt) * 1e6;
			const plan = rollingCalc.plan({
				totalKg: info.type.mass, jumpKg: info.type.jump, usedKg: state.massData.totalMass, massState: info.wormhole.mass,
				outKg: rollingCalc.passMass(hull, { prop: state.outProp, higgs: state.higgs, propKg: ship ? ship.propKg : undefined }),
				backKg: rollingCalc.passMass(hull, { prop: state.backProp, higgs: state.higgs, propKg: ship ? ship.propKg : undefined })
			});

			const e = rollingCalc.escape;
			// One button per ship, coloured by an out-and-back with that ship (and an icon: colour is never the only signal)
			const shipVerdict = function(mass, s) {
				const higgs = s && s.name === state.choice ? state.higgs : (s && s.higgs !== undefined ? s.higgs : state.higgs);
				const pm = function(prop) { return rollingCalc.passMass(mass, { prop: prop, higgs: higgs, propKg: s ? s.propKg : undefined }); };
				return rollingCalc.worstVerdict(rollingCalc.plan({
					totalKg: info.type.mass, jumpKg: info.type.jump, usedKg: state.massData.totalMass, massState: info.wormhole.mass,
					outKg: pm(state.outProp), backKg: pm(state.backProp)
				}));
			};
			const button = function(value, label, verdict, selected) {
				return "<button type='button' class='rolling-ship-btn rolling-btn-" + verdict + (selected ? " selected" : "") + "' data-ship='" + e(value) + "'" +
					" aria-pressed='" + (selected ? "true" : "false") + "' title='Out and back with this ship: " + e(rollingCalc.LABELS[verdict]) + "'>" +
					"<span class='rolling-btn-icon' aria-hidden='true'>" + rollingCalc.ICONS[verdict] + "</span> " + label + "</button> ";
			};
			const customHull = parseFloat(state.customKt) * 1e6;
			let controls = "<p class='rolling-controls'><b>Rolling:</b> " +
				ships.map(function(s) {
					return button(s.name, e(s.name) + (s.current ? " (current)" : "") + " " + rollingCalc.formatKt(s.mass), shipVerdict(s.mass, s), s.name === state.choice);
				}).join('') +
				button('custom', "Custom mass", customHull > 0 ? shipVerdict(customHull, null) : 'unknown', state.choice === 'custom') +
				(state.choice === 'custom' ? " <input type='number' class='rolling-custom' min='0' step='1' placeholder='kt' value='" + e(state.customKt) + "'> kt" : "") +
				" <label data-tooltip='Prop mod on for the out pass'><input type='checkbox' class='rolling-out-prop'" + (state.outProp ? " checked" : "") + "> Out hot</label>" +
				" <label data-tooltip='Prop mod on for the return pass'><input type='checkbox' class='rolling-back-prop'" + (state.backProp ? " checked" : "") + "> Back hot</label>" +
				" <label data-tooltip='Higgs anchor doubles jump mass'><input type='checkbox' class='rolling-higgs'" + (state.higgs ? " checked" : "") + "> Higgs</label></p>";
			if (!plan.range.known) { controls = ''; }

			const focused = document.activeElement && $(document.activeElement).hasClass("rolling-custom");
			$p.html(controls + rollingCalc.planHtml(plan, info.farName, info.homeName));
			if (focused) {
				const input = $p.find(".rolling-custom")[0];
				if (input) { input.focus(); const v = input.value; input.value = ''; input.value = v; }
			}
			renderPlan(info, plan);
		}

		function planPanel() {
			let $r = $("#rolling-plan");
			if (!$r.length) {
				$r = $("<div id='rolling-plan'></div>");
				panel().after($r);
			}
			return $r;
		}

		// "How to roll this hole": the step list for a typical roller crew (Settings > Wormhole Jumps & Mass > Roller ships)
		function renderPlan(info, plan) {
			const $r = planPanel();
			const opts = typeof options !== "undefined" ? options : undefined;
			if (!plan.range.known || !rollingCalc.planEnabled(opts)) { $r.hide().empty(); return; }
			const profile = rollingCalc.rollerProfile(info.type.jump, opts && opts.rollPlan);
			const rec = rollingCalc.recommend({ lo: plan.range.min, hi: plan.range.max, cold: profile.cold, hot: profile.hot,
				maxJump: info.type.jump, rollerName: profile.name });
			const pm = typeof preserveMass !== "undefined" && preserveMass.flags ? preserveMass.flags[String(info.wormhole.id)] : null;
			const flag = typeof holeRolling !== "undefined" && holeRolling.flags ? holeRolling.flags[String(info.wormhole.id)] : null;
			const preserved = pm ? "Marked preserve mass" + (pm.setBy ? " by " + pm.setBy : "") + (pm.reason ? " (" + pm.reason + ")" : "") +
				": don't roll it unless that has changed." : "";
			const body = rollingCalc.recommendHtml(rec, profile, { farName: info.farName, homeName: info.homeName, preserved: preserved,
				startedText: flag ? "Rolling " + holeRolling.startedText(flag) : "" });
			const open = state.planOpen === null ? !preserved : state.planOpen;
			$r.show().html("<details class='rolling-plan-details'" + (open ? " open" : "") + "><summary><b>How to roll this hole</b></summary>" + body + "</details>");
		}

		$(document).on("click", "#rolling-plan summary", function() {
			state.planOpen = !$(this).parent().prop("open");
		});
		$(document).on("click", "#rolling-calc .rolling-ship-btn", function() {
			state.choice = $(this).attr("data-ship");
			const ship = state.ships ? state.ships.filter(function(s) { return s.name === state.choice; })[0] : null;
			if (ship && ship.higgs !== undefined) { state.higgs = ship.higgs; }	// a logged fit knows its Higgs anchor
			render();
		});
		$(document).on("input", "#rolling-calc .rolling-custom", function() { state.customKt = $(this).val(); render(); });
		$(document).on("change", "#rolling-calc .rolling-out-prop", function() { state.outProp = $(this).prop("checked"); render(); });
		$(document).on("change", "#rolling-calc .rolling-back-prop", function() { state.backProp = $(this).prop("checked"); render(); });
		$(document).on("change", "#rolling-calc .rolling-higgs", function() { state.higgs = $(this).prop("checked"); render(); });

		// A fresh start every time the dialog opens; the mass log arrives later through parseMassData
		$(document).on("dialogopen", "#dialog-mass", function() {
			state.massData = null; state.choice = null; state.outProp = null; state.backProp = null; state.higgs = null;
			state.planOpen = null; state.fingerprint = null;
			panel().hide().empty();
			planPanel().hide().empty();
			startLive();
		});
		$(document).on("dialogclose", "#dialog-mass", function() { stopLive(); });

		// Live mass: while the dialog is open, look for new passes every 10 s and redraw the log and the recommendation
		// when someone else's pass (or a hot/cold correction) arrived. Stops when the dialog closes.
		let liveTimer = null, liveBusy = false;
		function startLive() {
			stopLive();
			liveTimer = setInterval(pollLive, rollingCalc.LIVE_MS);
		}
		function stopLive() {
			if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
		}
		function pollLive() {
			try {
				const $d = $("#dialog-mass");
				if (!$d.dialog("isOpen")) { stopLive(); return; }
				if (liveBusy || document.hidden || state.fingerprint === null || !rollingCalc.enabled(typeof options !== "undefined" ? options : undefined)) { return; }
				liveBusy = true;
				$.ajax({ url: "mass.php", type: "POST", data: { wormholeID: $d.data("id") }, dataType: "JSON", timeout: rollingCalc.LIVE_TIMEOUT_MS }).done(function(data) {
					if (!data || !data.jumps || !$d.dialog("isOpen")) { return; }
					if (JSON.stringify(data.jumps) === state.fingerprint) { return; }
					const open = $d.dialog("option", "open");
					if (typeof open !== "function") { return; }
					// The dialog's own refresh, fed with this response instead of fetching mass.php again (synchronous, so no flash).
					// Relies on the open handler being synchronous with a single mass.php call; if another mass.php call is added
					// inside open, it would get this response too. Fallback: just call open (one extra fetch).
					const real = $.ajax;
					$.ajax = function(settings) {
						if (settings && settings.url === "mass.php") { return $.Deferred().resolve(data).promise(); }
						return real.apply(this, arguments);
					};
					try { open.call($d[0]); } finally { $.ajax = real; }
				}).always(function() { liveBusy = false; });
			} catch (e) {
				liveBusy = false;
				if (typeof console !== "undefined") { console.warn("rolling-calculator: live refresh failed", e); }
			}
		}

		// The jump log gets a running total and the worst-case mass left after each pass (two extra columns)
		function decorateLog() {
			try {
				const info = holeInfo();
				if (!state.massData || !info || !rollingCalc.enabled(typeof options !== "undefined" ? options : undefined)) { return; }
				const log = rollingCalc.passLog(state.massData.jumps, info.type.mass);
				const $table = $("#massTable");
				if (!$table.find("thead th.rolling-log-head").length) {
					$table.find("thead tr").append(
						"<th class='rolling-log-head' data-tooltip='Mass through the hole up to and including this pass'>Total</th>" +
						"<th class='rolling-log-head' data-tooltip='Worst case: the lightest this hole can be (-10%) minus the total'>Left</th>");
				}
				const $rows = $table.find("tbody tr");
				const isJump = rollingCalc.jumpRowFlags($rows.map(function() { return this.id; }).get(), log.length);
				let i = 0;
				$rows.each(function(n) {
					const $row = $(this);
					$row.children(".rolling-log-cell").remove();
					const entry = isJump[n] ? log[i++] : null;
					$row.append("<td class='rolling-log-cell'>" + (entry ? rollingCalc.formatKt(entry.total) : "") + "</td>" +
						"<td class='rolling-log-cell'>" + (entry && entry.left !== null ? "&ge;&nbsp;" + rollingCalc.formatKt(entry.left, "floor") : "") + "</td>");
				});
			} catch (e) {
				if (typeof console !== "undefined") { console.warn("rolling-calculator: could not decorate the log", e); }
			}
		}
		if (typeof parseMassData === "function" && !parseMassData.rollingCalcWrapped) {
			const previous = parseMassData;
			parseMassData = function() {
				const result = previous.apply(this, arguments);
				try {
					if ($("#dialog-mass").is(":visible") || $("#dialog-mass").dialog("isOpen")) {
						state.massData = result;
						state.fingerprint = JSON.stringify(arguments[0]);
						render();
						setTimeout(decorateLog, 0);	// after the dialog added its rows (and auto-mass its badges)
					}
				} catch (e) {
					if (typeof console !== "undefined") { console.warn("rolling-calculator: could not render", e); }
				}
				return result;
			};
			parseMassData.rollingCalcWrapped = true;
		}

		// Keep the verdicts current when a sync changes the hole (mass state, type, sigs) while the dialog is open
		function holeKey() {
			const info = holeInfo();
			return info ? [info.wormhole.mass, info.wormhole.type, info.homeName, info.farName].join('|') : '';
		}
		function refreshIfChanged() {
			try {
				if (!state.massData || !$("#dialog-mass").dialog("isOpen")) { return; }
				if (holeKey() !== state.lastKey) { render(); }
			} catch (e) {
				if (typeof console !== "undefined") { console.warn("rolling-calculator: could not refresh", e); }
			}
		}
		// tripwire.parse handles synced signatures, tripwire.chainMap.parse synced wormholes
		[typeof tripwire !== "undefined" ? tripwire : null, typeof tripwire !== "undefined" ? tripwire.chainMap : null].forEach(function(owner) {
			if (!owner || typeof owner.parse !== "function" || owner.parse.rollingCalcWrapped) { return; }
			const previous = owner.parse;
			const wrapped = function() {
				const result = previous.apply(this, arguments);
				refreshIfChanged();
				return result;
			};
			Object.keys(previous).forEach(function(k) { wrapped[k] = previous[k]; });
			wrapped.rollingCalcWrapped = true;
			owner.parse = wrapped;
		});

		// Settings > Wormhole Jumps & Mass: "Rolling guidance", applied on Save like its neighbours (Reset = on)
		forkSettings.register({
			section: "jumps", order: 20, id: "rollingCalc-enabled", type: "checkbox", key: "rollingCalc",
			label: "Rolling guidance:", text: "Show worst-case rolling in the mass dialog",
			get: function(o) { return rollingCalc.enabled(o); },
			set: function(o, on) { o.rollingCalc = { enabled: on }; }
		});

		// Settings > Wormhole Jumps & Mass: "Roller ships" for the recommendation (kt; blank = the default)
		const rollerRow = function(prefix, label, cold, hot) {
			return "<div>" + label + ": <input type='number' min='1' step='1' id='rollPlan-" + prefix + "Cold' class='rollplan-input' placeholder='" + cold + "'> kt cold, " +
				"<input type='number' min='1' step='1' id='rollPlan-" + prefix + "Hot' class='rollplan-input' placeholder='" + hot + "'> kt hot</div>";
		};
		forkSettings.register({
			section: "jumps", order: 21, id: "rollPlan", type: "custom", key: "rollPlan", label: "Roller ships:",
			html: "<label><input type='checkbox' id='rollPlan-enabled'> Show \"How to roll this hole\" in the mass dialog</label>" +
				rollerRow("bs", "Battleships", rollingCalc.ROLLERS.bsCold, rollingCalc.ROLLERS.bsHot) +
				rollerRow("med", "Medium holes", rollingCalc.ROLLERS.medCold, rollingCalc.ROLLERS.medHot) +
				"<div class='rolling-note'>Mass of the ships you roll with, used for the recommendation (hot is capped at the hole's jump limit).</div>",
			load: function(o) {
				const p = o.rollPlan || {};
				$("#rollPlan-enabled").prop("checked", p.enabled !== false);
				["bsCold", "bsHot", "medCold", "medHot"].forEach(function(k) { $("#rollPlan-" + k).val(Number(p[k]) > 0 ? p[k] : ""); });
			},
			save: function(o) {
				const p = { enabled: $("#rollPlan-enabled").prop("checked") };
				["bsCold", "bsHot", "medCold", "medHot"].forEach(function(k) {
					const v = parseFloat($("#rollPlan-" + k).val());
					if (v > 0) { p[k] = v; }
				});
				o.rollPlan = p;
			}
		});
	});
}
