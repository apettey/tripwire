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
		@return kg, or null if the hull mass is unknown */
	passMass: function(hullKg, mods) {
		const hull = Number(hullKg);
		if (!(hull > 0)) { return null; }
		mods = mods || {};
		return (hull + (mods.prop ? rollingCalc.propMass(hull) : 0)) * (mods.higgs ? 2 : 1);
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

	escape: function(s) {
		return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function(c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	},

	/** Ship choices for the dialog: the current ship first, then ships seen in this hole's log (unique by name).
		@param currentShip {typeName, mass} or null; jumps parseMassData().jumps ({shipName, originalMass}) */
	shipChoices: function(currentShip, jumps) {
		const out = [], seen = {};
		const add = function(name, mass, current) {
			if (!name || !(Number(mass) > 0) || seen[name]) { return; }
			seen[name] = true;
			out.push({ name: name, mass: Number(mass), current: !!current });
		};
		if (currentShip) { add(currentShip.typeName, currentShip.mass, true); }
		(jumps || []).forEach(function(j) { if (j) { add(j.shipName, j.originalMass, false); } });
		return out;
	},

	/** Whether the feature is on (options.rollingCalc.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.rollingCalc && opts.rollingCalc.enabled === false);
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
		const state = { massData: null, choice: null, outProp: null, backProp: null, higgs: null, customKt: '' };

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
			if (!rollingCalc.enabled(typeof options !== "undefined" ? options : undefined)) { $p.hide().empty(); return; }
			const info = holeInfo();
			if (!info || !state.massData) { $p.hide().empty(); return; }
			$p.show();

			const ships = rollingCalc.shipChoices(currentShip(), state.massData.jumps);
			if (state.choice === null) { state.choice = ships.length ? ships[0].name : 'custom'; }
			if (state.higgs === null) { state.higgs = !!(tripwire.massOptions && tripwire.massOptions.higgs); }
			if (state.outProp === null) { state.outProp = !!(tripwire.massOptions && tripwire.massOptions.prop); }
			if (state.backProp === null) { state.backProp = state.outProp; }

			const ship = ships.filter(function(s) { return s.name === state.choice; })[0];
			const hull = ship ? ship.mass : parseFloat(state.customKt) * 1e6;
			const plan = rollingCalc.plan({
				totalKg: info.type.mass, jumpKg: info.type.jump, usedKg: state.massData.totalMass, massState: info.wormhole.mass,
				outKg: rollingCalc.passMass(hull, { prop: state.outProp, higgs: state.higgs }),
				backKg: rollingCalc.passMass(hull, { prop: state.backProp, higgs: state.higgs })
			});

			const e = rollingCalc.escape;
			let controls = "<p class='rolling-controls'><b>Rolling:</b> <select class='rolling-ship'>" +
				ships.map(function(s) {
					return "<option value='" + e(s.name) + "'" + (s.name === state.choice ? " selected" : "") + ">" +
						e(s.name) + (s.current ? " (current)" : "") + " " + rollingCalc.formatKt(s.mass) + "</option>";
				}).join('') +
				"<option value='custom'" + (state.choice === 'custom' ? " selected" : "") + ">Custom mass</option></select>" +
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
		}

		$(document).on("change", "#rolling-calc .rolling-ship", function() { state.choice = $(this).val(); render(); });
		$(document).on("input", "#rolling-calc .rolling-custom", function() { state.customKt = $(this).val(); render(); });
		$(document).on("change", "#rolling-calc .rolling-out-prop", function() { state.outProp = $(this).prop("checked"); render(); });
		$(document).on("change", "#rolling-calc .rolling-back-prop", function() { state.backProp = $(this).prop("checked"); render(); });
		$(document).on("change", "#rolling-calc .rolling-higgs", function() { state.higgs = $(this).prop("checked"); render(); });

		// A fresh start every time the dialog opens; the mass log arrives later through parseMassData
		$(document).on("dialogopen", "#dialog-mass", function() {
			state.massData = null; state.choice = null; state.outProp = null; state.backProp = null; state.higgs = null;
			panel().hide().empty();
		});
		if (typeof parseMassData === "function" && !parseMassData.rollingCalcWrapped) {
			const previous = parseMassData;
			parseMassData = function() {
				const result = previous.apply(this, arguments);
				try {
					if ($("#dialog-mass").is(":visible") || $("#dialog-mass").dialog("isOpen")) {
						state.massData = result;
						render();
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

		// Settings > Chain Map Settings: "Rolling guidance" checkbox, applied on Save like the other chain settings
		const $table = $("#dialog-options #optionsAccordion > div").eq(1).find("table.optionsTable").first();
		if ($table.length && !$("#rollingCalc-enabled").length) {
			$table.append("<tr><th>Rolling guidance:</th><td><label><input type='checkbox' id='rollingCalc-enabled' /> Show worst-case rolling in the mass dialog</label></td></tr>");
		}
		$(document).on("dialogopen", "#dialog-options", function() {
			$("#rollingCalc-enabled").prop("checked", rollingCalc.enabled(options));
		});
		document.addEventListener("click", function(e) {
			const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
			if (!button || $.trim($(button).text()) !== "Save") { return; }
			if (!$(button).closest(".ui-dialog").find("#dialog-options").length || !$("#rollingCalc-enabled").length) { return; }
			options.rollingCalc = { enabled: $("#rollingCalc-enabled").prop("checked") };
		}, true);

		// Settings > Reset: back to on (a missing key means on)
		if (typeof options !== "undefined" && typeof options.reset === "function" && !options.reset.rollingCalcWrapped) {
			const reset = options.reset;
			const wrapped = function() {
				const result = reset.apply(this, arguments);
				delete this.rollingCalc;
				return result;
			};
			Object.keys(reset).forEach(function(k) { wrapped[k] = reset[k]; });
			wrapped.rollingCalcWrapped = true;
			options.reset = wrapped;
		}
	});
}
