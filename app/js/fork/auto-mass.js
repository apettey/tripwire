const autoMass = {
	// Fitted jump mass (fork feature: auto-mass-logging).
	// Upstream already logs every tracked jump through a mapped hole (the jumpHistory trigger on `tracking`), with
	// the hull type and the chain map's hot/Higgs toggles. This adds the ship's real mass from its current fitting
	// (ESI assets: modules located in the active ship) and a hot/cold confirmation, stored next to the upstream row
	// (fork_jump_fits, public/jump_fit.php) and used by the mass dialog and the rolling calculator.

	ASSETS_MIN_INTERVAL_MS: 10 * 60 * 1000,	// at most one assets refresh per character per 10 min (and never before ESI's Expires)
	ASSETS_ERROR_BACKOFF_MS: 5 * 60 * 1000,
	NO_SCOPE_RECHECK_MS: 60 * 60 * 1000,
	ASSETS_MAX_PAGES: 50,
	REPORT_RETRY_MS: [4000, 10000, 20000, 40000, 90000],	// the upstream jump row appears after the next sync (or the automapper)
	PROMPT_MS: 30000,
	ASSETS_SCOPE: 'esi-assets.read_assets.v1',
	FIT_FLAG: /^(HiSlot|MedSlot|LoSlot|RigSlot|SubSystemSlot)[0-7]$/,

	/** Whether the feature is on for this user (options.autoMass.enabled; missing = on) */
	enabled: function(opts) {
		return !(opts && opts.autoMass && opts.autoMass.enabled === false);
	},

	/** Whether to ask hot/cold after a jump (options.autoMass.prompt; missing = on) */
	promptEnabled: function(opts) {
		return autoMass.enabled(opts) && !(opts && opts.autoMass && opts.autoMass.prompt === false);
	},

	/** Scopes of an EVE SSO v2 access token (a JWT), or null if it can't be read */
	tokenScopes: function(token) {
		try {
			const part = String(token || '').split('.')[1];
			if (!part) { return null; }
			const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
			const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
			const scp = JSON.parse(json).scp;
			return scp === undefined ? [] : [].concat(scp);
		} catch (e) {
			return null;
		}
	},

	/** true / false, or null when the token can't be read (then we just try and look for a 403) */
	hasAssetsScope: function(token) {
		const scopes = autoMass.tokenScopes(token);
		return scopes === null ? null : scopes.indexOf(autoMass.ASSETS_SCOPE) >= 0;
	},

	/** Index ESI asset pages: fitted modules by the item they sit in, and every assembled item (ships).
		@param pages array of asset arrays (ESI /characters/{id}/assets/ pages)
		@return {fits: {itemID: [typeID...]}, items: {itemID: typeID}} */
	indexAssets: function(pages) {
		const fits = {}, items = {};
		(pages || []).forEach(function(page) {
			(page || []).forEach(function(a) {
				if (!a || a.item_id === undefined) { return; }
				if (a.is_singleton) { items[a.item_id] = a.type_id; }
				if (autoMass.FIT_FLAG.test(a.location_flag || '') && a.location_type === 'item') {
					(fits[a.location_id] = fits[a.location_id] || []).push(a.type_id);
				}
			});
		});
		return { fits: fits, items: items };
	},

	/** Fitted module type IDs of a ship, [] for an unfitted ship, or null when the ship isn't in the asset snapshot
		(boarded or assembled after ESI's snapshot) */
	fitFor: function(index, shipItemID) {
		if (!index || !shipItemID) { return null; }
		if (index.fits[shipItemID]) { return index.fits[shipItemID].slice(); }
		return index.items[shipItemID] !== undefined ? [] : null;
	},

	/** Mass of a fitted ship.
		@param hullKg hull mass (appData.mass), typeIDs fitted module types (or null for hull only), data fitMassData
		@return {known, hull, base, multiplier, cold, hot, prop: {typeID, name, mass} | null, additions: [...], higgs: name | null}
			base = hull + always-on additions (armor plates); cold = base x multiplier (Higgs anchor);
			hot = (base + the heaviest prop module's mass addition) x multiplier. Unknown modules add nothing. */
	fitMass: function(hullKg, typeIDs, data) {
		const hull = Number(hullKg);
		if (!(hull > 0)) { return { known: false }; }
		const types = (data && data.types) || {};
		let base = hull, multiplier = 1, prop = null, higgs = null;
		const additions = [];
		(typeIDs || []).forEach(function(typeID) {
			const t = types[typeID];
			if (!t) { return; }
			if (t.x > 0) { multiplier *= t.x; higgs = t.n; }
			if (t.a > 0) {
				if (t.p) {
					if (!prop || t.a > prop.mass) { prop = { typeID: Number(typeID), name: autoMass.moduleName(t), mass: t.a }; }
				} else {
					base += t.a;
					additions.push({ typeID: Number(typeID), name: autoMass.moduleName(t), mass: t.a });
				}
			}
		});
		return {
			known: true, hull: hull, base: base, multiplier: multiplier,
			cold: base * multiplier, hot: (base + (prop ? prop.mass : 0)) * multiplier,
			prop: prop, additions: additions, higgs: higgs
		};
	},

	/** Display name of a fit-mass-data entry; abyssal (mutated) modules say their mass is a base value */
	moduleName: function(t) {
		return t.n + (t.m ? ' (base value)' : '');
	},

	/** Upstream's guess for a hot jump without a fit: +50,000 t, or +500,000 t over 500,000 t hull (mass.js) */
	ruleProp: function(hullKg) {
		return Number(hullKg) > 500e6 ? 500e6 : 50e6;
	},

	/** Mass of one logged jump.
		@param row the jump log row (mass.php, with the fork's columns: fitSource, baseMass, propMass, higgsMult, hot)
		@param j upstream's parse of that row ({originalMass, mass, prop, higgs})
		@return {mass, prop, higgs, hot, fit: {source, time, base, cold, hotMass, propTypeID, propMass, multiplier} | null} */
	jumpMass: function(row, j) {
		row = row || {};
		const hasHot = row.hot !== undefined && row.hot !== null && row.hot !== '';
		const hot = hasHot ? Number(row.hot) === 1 : !!j.prop;
		const base = Number(row.baseMass);
		if (row.fitSource === 'assets' && base > 0) {
			const multiplier = Number(row.higgsMult) > 0 ? Number(row.higgsMult) : 1;
			const propMass = Number(row.propMass) > 0 ? Number(row.propMass) : 0;
			const cold = base * multiplier, hotMass = (base + propMass) * multiplier;
			return {
				mass: hot ? hotMass : cold, prop: hot && propMass > 0, higgs: multiplier > 1, hot: hot,
				fit: { source: 'assets', time: row.fitTime || null, base: base, cold: cold, hotMass: hotMass,
					propTypeID: row.propTypeID ? Number(row.propTypeID) : null, propMass: propMass, multiplier: multiplier }
			};
		}
		const hull = Number(j.originalMass);
		return {
			mass: (hull + (hot ? autoMass.ruleProp(hull) : 0)) * (j.higgs ? 2 : 1), prop: hot, higgs: !!j.higgs, hot: hot,
			fit: row.fitSource === 'hull' ? { source: 'hull', time: null } : null
		};
	},

	/** Size class of a hull, as upstream's mass dialog (mass.js getMassClass) */
	massClass: function(kg) {
		return kg <= 5e6 ? 'Small' : kg <= 80e6 ? 'Medium' : kg <= 500e6 ? 'Large' : 'X-Large';
	},

	/** Re-total a parsed jump log after per-jump changes. Classes follow the hull, like upstream. */
	totals: function(jumps) {
		const result = { totalMass: 0, smallMass: 0, mediumMass: 0, largeMass: 0, xlMass: 0, jumps: jumps };
		jumps.forEach(function(j) {
			result.totalMass += j.mass;
			switch (autoMass.massClass(j.originalMass)) {
				case 'Small': result.smallMass += j.mass; break;
				case 'Medium': result.mediumMass += j.mass; break;
				case 'Large': result.largeMass += j.mass; break;
				default: result.xlMass += j.mass;
			}
		});
		return result;
	},

	/** Whether to (re)fetch a character's assets now.
		@param st per-character state {index, shipID, fetchedAt, expires, fetching, retryAt, noScope}
		@param now ms, shipID current ship item ID */
	shouldFetch: function(st, now, shipID) {
		if (!st || !shipID || st.fetching) { return false; }
		if (st.retryAt && now < st.retryAt) { return false; }
		if (!st.index) { return true; }
		if (st.expires && now < st.expires) { return false; }	// ESI would return the same cached snapshot
		if (now - (st.fetchedAt || 0) < autoMass.ASSETS_MIN_INTERVAL_MS && st.shipID === shipID) { return false; }
		return true;
	},

	/** HTTP date header to ms, or null */
	httpDate: function(value) {
		const t = value ? Date.parse(value) : NaN;
		return isNaN(t) ? null : t;
	},

	/** Report payload for jump_fit.php (numbers only; names are looked up locally) */
	report: function(characterID, fromID, toID, shipTypeID, mass, fitSource, fitTimeMs, hot) {
		const p = { mode: 'report', characterID: characterID, fromID: fromID, toID: toID, shipTypeID: shipTypeID || '',
			fitSource: fitSource, hot: hot ? 1 : 0 };
		if (fitSource === 'assets' && mass && mass.known) {
			p.baseMass = Math.round(mass.base);
			p.higgsMult = mass.multiplier;
			p.propTypeID = mass.prop ? mass.prop.typeID : '';
			p.propMass = mass.prop ? Math.round(mass.prop.mass) : 0;
			p.fitTime = fitTimeMs ? Math.floor(fitTimeMs / 1000) : '';
		}
		return p;
	},

	/** Whether two systems are gate neighbours (then a jump between them is a gate jump unless a hole is mapped) */
	gateNeighbours: function(map, from, to) {
		const a = map && map[from - 30000000];
		return !!(a && a[to - 30000000] !== undefined);
	},

	/** Wormhole connecting two systems in the given client data, or null */
	holeBetween: function(from, to, wormholes, signatures) {
		let found = null;
		Object.keys(wormholes || {}).forEach(function(k) {
			const w = wormholes[k];
			const a = w && signatures[w.initialID], b = w && signatures[w.secondaryID];
			if (!a || !b || found) { return; }
			if ((a.systemID == from && b.systemID == to) || (a.systemID == to && b.systemID == from)) { found = w; }
		});
		return found;
	},

	/** "12,345 t" */
	formatT: function(kg) {
		return String(Math.round(Number(kg) / 1000)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' t';
	},

	/** "14:05" (local time) for a ms or unix-seconds timestamp or a MySQL datetime (UTC), or '' */
	formatTime: function(t) {
		if (t === null || t === undefined || t === '') { return ''; }
		let d;
		if (typeof t === 'number' || /^\d+$/.test(String(t))) {
			const n = Number(t);
			d = new Date(n < 1e11 ? n * 1000 : n);
		} else {
			d = new Date(String(t).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(t)) ? '' : 'Z'));
		}
		if (isNaN(d.getTime())) { return ''; }
		const pad = function(n) { return (n < 10 ? '0' : '') + n; };
		return pad(d.getHours()) + ':' + pad(d.getMinutes());
	},

	/** Plain-text description of where a jump's mass came from */
	sourceText: function(fit, propName) {
		if (!fit) { return 'Hull mass (no fit logged)'; }
		if (fit.source === 'assets') {
			const time = autoMass.formatTime(fit.time);
			return 'Fitted mass from ESI assets' + (time ? ' as of ' + time : '') + ' (ESI updates assets up to an hour late)' +
				'. Cold ' + autoMass.formatT(fit.cold) + ', hot ' + autoMass.formatT(fit.hotMass) +
				(propName ? ' (' + propName + ')' : fit.propMass ? '' : ' (no prop module fitted)') +
				(fit.multiplier > 1 ? ', Higgs anchor x' + fit.multiplier : '') + '.';
		}
		return 'Hull mass only (the fit was not available)';
	},

	escape: function(s) {
		return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function(c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		if (typeof tripwire === "undefined") { return; }
		const ESI = "https://esi.evetech.net";
		const chars = {};	// characterID => {lastSystemID, index, shipID, fetchedAt, expires, lastModified, fetching, retryAt, noScope}
		const data = function() { return typeof fitMassData !== "undefined" ? fitMassData : { types: {} }; };
		const opts = function() { return typeof options !== "undefined" ? options : undefined; };
		const e = autoMass.escape;

		function userAgent() {
			return "Tripwire Client " + tripwire.version + " (" + window.location.hostname + ") - " + window.navigator.userAgent;
		}

		function hullMass(shipTypeID) {
			const m = typeof appData !== "undefined" && appData.mass ? appData.mass[shipTypeID] : null;
			return m ? { name: m.typeName, mass: parseFloat(m.mass) } : null;
		}

		function systemName(id) {
			const s = (typeof appData !== "undefined" && appData.systems && appData.systems[id]) || (tripwire.systems && tripwire.systems[id]);
			return s && s.name ? s.name : String(id);
		}

		function typeName(typeID) {
			const t = data().types[typeID];
			return t ? autoMass.moduleName(t) : null;
		}

		// --- Assets (fit) lookup, with the tracking character's own token like location/ship in esi.js ---
		function fetchAssets(characterID, character, st) {
			const shipID = character.shipID;
			st.fetching = true;
			const pages = [];
			function done(ok, status) {
				st.fetching = false;
				if (ok) { return; }
				if (status === 403 || status === 401) {
					st.noScope = true;
					st.retryAt = Date.now() + autoMass.NO_SCOPE_RECHECK_MS;
				} else {
					st.retryAt = Date.now() + autoMass.ASSETS_ERROR_BACKOFF_MS;
				}
			}
			function page(n) {
				$.ajax({
					url: ESI + "/characters/" + characterID + "/assets/?" + $.param({ page: n, token: character.accessToken, user_agent: userAgent() }),
					type: "GET",
					dataType: "JSON"
				}).done(function(body, status, xhr) {
					pages.push(body);
					const total = Math.min(Number(xhr.getResponseHeader("x-pages")) || 1, autoMass.ASSETS_MAX_PAGES);
					if (n === 1) {
						st.pendingModified = autoMass.httpDate(xhr.getResponseHeader("last-modified"));
						st.pendingExpires = autoMass.httpDate(xhr.getResponseHeader("expires"));
					}
					if (n < total) { page(n + 1); return; }
					st.index = autoMass.indexAssets(pages);
					st.shipID = shipID;
					st.fetchedAt = Date.now();
					st.lastModified = st.pendingModified || Date.now();
					st.expires = st.pendingExpires;
					st.noScope = false;
					st.retryAt = null;
					done(true);
				}).fail(function(xhr) {
					done(false, xhr ? xhr.status : 0);
				});
			}
			page(1);
		}

		function maybeFetch(characterID, character, st) {
			const scope = autoMass.hasAssetsScope(character.accessToken);
			if (scope === false) {
				st.noScope = true;
				return;
			}
			if (character.tokenExpire && moment.utc(character.tokenExpire).subtract(5, "minutes").isBefore(moment())) { return; }
			if (autoMass.shouldFetch(st, Date.now(), character.shipID)) { fetchAssets(characterID, character, st); }
		}

		/** Fit and mass of a character's current ship: {shipTypeID, shipName, mass (fitMass), source, fitTime, reason} */
		function currentFit(characterID) {
			const character = tripwire.esi && tripwire.esi.characters ? tripwire.esi.characters[characterID] : null;
			if (!character || !character.shipTypeID) { return null; }
			const hull = hullMass(character.shipTypeID);
			if (!hull) { return null; }
			const st = chars[characterID] || {};
			const typeIDs = st.index ? autoMass.fitFor(st.index, character.shipID) : null;
			const usable = autoMass.enabled(opts()) && typeIDs !== null;
			return {
				shipTypeID: character.shipTypeID, shipName: hull.name,
				mass: autoMass.fitMass(hull.mass, usable ? typeIDs : [], data()),
				source: usable ? 'assets' : 'hull',
				fitTime: usable ? st.lastModified : null,
				reason: usable ? null : st.noScope ? 'noscope' : st.index ? 'notinassets' : 'pending'
			};
		}
		autoMass.currentFit = currentFit;

		// --- Reporting a jump ---
		function post(payload) {
			return $.ajax({ url: "jump_fit.php", type: "POST", data: payload, dataType: "JSON", headers: { "X-Requested-With": "XMLHttpRequest" } });
		}

		function reasonText(fit) {
			return fit.reason === 'noscope' ? "Hull only: this character hasn't granted asset access (remove and add it again under Tracking, if this Tripwire asks for it)" :
				fit.reason === 'notinassets' ? "Hull only: this ship isn't in ESI's asset snapshot yet" :
				"Hull only: fit not loaded yet";
		}

		function showPrompt(character, from, to, fit, key, hot) {
			if (typeof jBox === "undefined") { return; }
			const id = "automass-" + key.characterID;
			const m = fit.mass;
			const propName = m.prop ? m.prop.name : null;
			const source = fit.source === 'assets' ?
				"Fit as of " + autoMass.formatTime(fit.fitTime) + " (ESI can lag up to 1 h)" + (propName ? ", " + propName : ", no prop module") +
					(m.multiplier > 1 ? ", Higgs anchor" : "") :
				reasonText(fit);
			const hotMass = fit.source === 'assets' ? m.hot : (m.hull + autoMass.ruleProp(m.hull)) * (tripwire.massOptions && tripwire.massOptions.higgs ? 2 : 1);
			const coldMass = fit.source === 'assets' ? m.cold : m.hull * (tripwire.massOptions && tripwire.massOptions.higgs ? 2 : 1);
			const html = "<div class='automass-prompt' data-wormhole='" + e(key.wormholeID) + "' data-character='" + e(key.characterID) + "' data-time='" + e(key.time) + "'>" +
				"<div>" + e(character.characterName) + " jumped " + e(systemName(from)) + " &rarr; " + e(systemName(to)) + " in " + e(fit.shipName) + "</div>" +
				"<div class='automass-source'>" + e(source) + "</div>" +
				"<div class='automass-choice'>Log as: " +
				"<button type='button' class='automass-set" + (hot ? "" : " active") + "' data-hot='0'>Cold " + e(autoMass.formatT(coldMass)) + "</button> " +
				"<button type='button' class='automass-set" + (hot ? " active" : "") + "' data-hot='1'>Hot " + e(autoMass.formatT(hotMass)) + "</button>" +
				"</div></div>";
			if (autoMass.prompts[id]) { try { autoMass.prompts[id].close(); } catch (err) { /* already gone */ } }
			autoMass.prompts[id] = new jBox("Notice", {
				content: html, color: "blue", autoClose: autoMass.PROMPT_MS, closeOnClick: false, offset: { y: 35 }, animation: "flip",
				addClass: "automass-notice"
			});
		}
		autoMass.prompts = {};

		$(document).on("click", ".automass-prompt .automass-set", function() {
			const $box = $(this).closest(".automass-prompt"), hot = $(this).data("hot");
			const $buttons = $box.find(".automass-set").prop("disabled", true);
			post({ mode: "hot", wormholeID: $box.data("wormhole"), characterID: $box.data("character"), time: $box.data("time"), hot: hot })
				.done(function() {
					$buttons.removeClass("active").filter("[data-hot='" + hot + "']").addClass("active");
					$box.find(".automass-source").text(hot == 1 ? "Logged as hot." : "Logged as cold.");
				})
				.fail(function() { $box.find(".automass-source").text("Couldn't save; try again from the mass dialog."); })
				.always(function() { $buttons.prop("disabled", false); });
		});

		function onJump(characterID, character, from, to) {
			if (!autoMass.enabled(opts())) { return; }
			const client = tripwire.client || {};
			const mapped = autoMass.holeBetween(from, to, client.wormholes, client.signatures || {});
			const map = (tripwire.map && tripwire.map.shortest) || (typeof appData !== "undefined" && appData.map ? appData.map.shortest : null);
			if (!mapped && autoMass.gateNeighbours(map, from, to)) { return; }	// a gate jump: nothing logged upstream either
			const fit = currentFit(characterID);
			if (!fit) { return; }
			const hot = !!(tripwire.massOptions && tripwire.massOptions.prop);
			const payload = autoMass.report(characterID, from, to, fit.shipTypeID, fit.mass, fit.source, fit.fitTime, hot);
			let attempt = 0;
			function send() {
				post(payload).done(function(res) {
					if (res && res.matched) {
						if (autoMass.promptEnabled(opts())) {
							showPrompt(character, from, to, fit, { wormholeID: res.wormholeID, characterID: characterID, time: res.time }, hot);
						}
						return;
					}
					retry();
				}).fail(function(xhr) {
					if (xhr && xhr.status >= 400 && xhr.status < 500) { return; }	// refused: don't hammer
					retry();
				});
			}
			function retry() {
				if (attempt >= autoMass.REPORT_RETRY_MS.length) { return; }	// no logged jump: not through a mapped hole
				setTimeout(send, autoMass.REPORT_RETRY_MS[attempt++]);
			}
			retry();
		}

		function tick() {
			try {
				const characters = tripwire.esi && tripwire.esi.characters ? tripwire.esi.characters : {};
				Object.keys(chars).forEach(function(id) { if (!characters[id]) { delete chars[id]; } });
				Object.keys(characters).forEach(function(id) {
					const character = characters[id];
					const st = chars[id] = chars[id] || {};
					if (autoMass.enabled(opts())) { maybeFetch(id, character, st); }
					const now = character.systemID || null;
					if (st.lastSystemID && now && st.lastSystemID != now) { onJump(id, character, st.lastSystemID, now); }
					if (now) { st.lastSystemID = now; }
				});
			} catch (err) {
				console.warn("auto-mass: tick failed", err);
			}
		}
		setInterval(tick, 2000);
		autoMass.tick = tick;
		autoMass.characters = chars;	// for the console / tests

		// --- Mass dialog: logged fits, hot/cold editing ---
		if (typeof parseMassData === "function" && !parseMassData.autoMassWrapped) {
			if (parseMassData.rollingCalcWrapped) { console.warn("auto-mass: loaded after the rolling calculator"); }
			const upstream = parseMassData;
			parseMassData = function(rows) {
				const jumps = [];
				(rows || []).forEach(function(row) {
					const one = upstream.call(this, [row]);
					if (!one || !one.jumps || !one.jumps.length) { return; }
					const j = one.jumps[0];
					const m = autoMass.jumpMass(row, j);
					j.mass = m.mass; j.prop = m.prop; j.higgs = m.higgs; j.hot = m.hot; j.fit = m.fit;
					j.characterID = row.characterID; j.rawTime = row.time;
					j.propName = m.fit && m.fit.propTypeID ? typeName(m.fit.propTypeID) : null;
					jumps.push(j);
				}, this);
				const result = autoMass.totals(jumps);
				setTimeout(function() { decorate(result); }, 0);	// the dialog adds the rows right after this returns
				return result;
			};
			parseMassData.autoMassWrapped = true;
		}

		function decorate(result) {
			const $rows = $("#dialog-mass #massTable tbody tr").not("#small-mass, #medium-mass, #large-mass");
			result.jumps.forEach(function(j, i) {
				const $cell = $rows.eq(i).children("td").eq(3);
				if (!$cell.length || $cell.find(".automass-badge").length) { return; }
				const editable = j.characterID !== undefined && j.characterID !== null && j.rawTime;
				if (!$cell.find("[data-icon='prop-mod']").length) {
					$cell.prepend("<i data-icon='prop-mod' class='" + (j.prop ? " active" : "inactive") + "'></i> ");
				}
				const $prop = $cell.find("[data-icon='prop-mod']").first();
				$prop.toggleClass("active", !!j.hot).toggleClass("inactive", !j.hot);
				if (editable) {
					$prop.addClass("automass-toggle").attr({
						"data-wormhole": $("#dialog-mass").data("id"), "data-character": j.characterID, "data-time": j.rawTime,
						"data-hot": j.hot ? 1 : 0, title: "Logged " + (j.hot ? "hot" : "cold") + ": click to change", role: "button", tabindex: 0
					});
				}
				const label = j.fit && j.fit.source === 'assets' ? "fit" : "hull";
				$cell.append(" <span class='automass-badge automass-" + label + "' title='" + e(autoMass.sourceText(j.fit, j.propName)) + "'>" + label + "</span>");
			});
		}

		$(document).on("click keydown", "#dialog-mass .automass-toggle", function(ev) {
			if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") { return; }
			ev.preventDefault();
			const $t = $(this);
			post({ mode: "hot", wormholeID: $t.attr("data-wormhole"), characterID: $t.attr("data-character"), time: $t.attr("data-time"),
				hot: $t.attr("data-hot") == 1 ? 0 : 1 })
				.done(function() {
					const open = $("#dialog-mass").dialog("option", "open");
					if (typeof open === "function" && $("#dialog-mass").dialog("isOpen")) { open.call($("#dialog-mass")[0]); }
				})
				.fail(function() { if (typeof Notify !== "undefined") { Notify.trigger("Couldn't change the logged jump", "red"); } });
		});

		// --- Settings > Wormhole Jumps & Mass (takes effect on Save; Reset = on) ---
		forkSettings.register({
			section: "jumps", order: 10, id: "autoMass", type: "custom", key: "autoMass", label: "Jump mass:",
			html: "<label><input type='checkbox' id='autoMass-enabled' /> Log my jumps with my fitted mass (ESI assets)</label><br/>" +
				"<label><input type='checkbox' id='autoMass-prompt' /> Ask hot or cold after a jump</label>",
			load: function(o) {
				$("#autoMass-enabled").prop("checked", autoMass.enabled(o));
				$("#autoMass-prompt").prop("checked", !(o.autoMass && o.autoMass.prompt === false));
			},
			save: function(o) {
				o.autoMass = { enabled: $("#autoMass-enabled").prop("checked"), prompt: $("#autoMass-prompt").prop("checked") };
			}
		});
	});
}
