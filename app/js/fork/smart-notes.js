const smartNotes = {
	// Smart notes (fork-owned): when a system note is displayed, zKillboard kill links become compact kill cards,
	// zKillboard character / corporation / alliance / system links, Dotlan and EveWho links become chips, other long
	// links are shortened, bare https URLs in plain text become links (or cards / chips) and, behind a sub-toggle,
	// system names written in the text become system chips. Render time only: the stored note HTML never changes
	// (editing shows the raw note again, see install()), and everything is built from text with DOM setters
	// (textContent / setAttribute), never from note or killmail HTML. Only https links to an exact host allow-list
	// are recognised; image URLs are built from numeric IDs only.
	// Kill data comes from public/zkill_kill.php (stored kills, otherwise queued for the pooled zKillboard worker);
	// the browser never calls zKillboard, Dotlan or EveWho, it only links to them and loads images from
	// images.evetech.net. Hook: a MutationObserver on the notes list (no upstream file is edited).
	// Settings: options.smartNotes = {enabled, systemNames} (a missing key means on).
	// Keep `const smartNotes` on the first line: the test helper strips it to define a global.
	URL: "zkill_kill.php",
	MAX_IDS: 20,	// kill IDs (and names) per request, as the server allows
	RETRY_MS: [3000, 10000, 30000],	// a queued kill is asked for again after these delays, then shown as the plain link
	LONG_URL: 50,	// other links at least this long are shortened to a chip
	MAX_LABEL: 60,
	SKIP_TAGS: { A: true, CODE: true, PRE: true, SCRIPT: true, STYLE: true, TEXTAREA: true, KBD: true, SAMP: true },
	HOSTS: {
		"zkillboard.com": "zkill", "www.zkillboard.com": "zkill",
		"evemaps.dotlan.net": "dotlan",
		"evewho.com": "evewho", "www.evewho.com": "evewho"
	},
	ENTITY_LABELS: { character: "Character", corporation: "Corporation", alliance: "Alliance", system: "System" },
	/**
	 * System names that are also everyday words, first names or dates: never turned into chips when written in text.
	 * From a review of every capitalised single-word name in the static data (names match case-sensitively, so only
	 * the capitalised word is affected, e.g. at the start of a sentence).
	 */
	NOT_SYSTEM_WORDS: ["Abstention", "Access", "Adroit", "Alf", "Ami", "Ana", "Arena", "Ation", "Bar", "Berta", "Branch", "Cache",
		"Canard", "Cat", "Catch", "Celerity", "Chivalric", "Col", "Couth", "Curse", "Dal", "Decon", "Decorum", "Delve", "Devoid",
		"Domain", "Dour", "Drifters", "Equity", "Erudite", "Essence", "Esteban", "Exit", "Exordium", "Fade", "Forte", "Fortitude",
		"Fountain", "Gallant", "Gateway", "Geminate", "Genesis", "Gens", "Half", "Halle", "Ham", "Hare", "Hier", "Ides", "Impass",
		"Inoue", "Jan", "Janus", "Kari", "Lang", "Lari", "Lazer", "Lenity", "Lor", "Luminaire", "Lustre", "Mai", "Manifest", "Mara",
		"Martha", "Metropolis", "Mettle", "Misha", "Mod", "Ned", "Nein", "Odette", "Odin", "ORE", "Pain", "Parses", "Parts", "Pasha",
		"Perimeter", "Placid", "Polaris", "Pout", "Prism", "Providence", "Rand", "Ratiocinate", "Repute", "Reset", "Rigor",
		"Sagacity", "Slays", "Solemn", "Solitude", "Stain", "Steadfast", "Syndicate", "Tar", "Tenacity", "Toon", "Tribute",
		"Triumph", "Unknown", "Utopia", "Vale", "Valiance", "Van", "Venal", "Venerate", "Weld"],
	MAX_ENTITY_ID: 2147483647,	// character / corporation / alliance IDs are 32-bit

	// ---- Settings ----

	/** Whether smart notes are on in the given user options (on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.smartNotes && opts.smartNotes.enabled === false);
	},

	/** Whether system names written in notes become chips (on unless explicitly false) */
	systemNames: function(opts) {
		return !(opts && opts.smartNotes && opts.smartNotes.systemNames === false);
	},

	opts: function() {
		return typeof options !== "undefined" ? options : null;
	},

	// ---- Recognising links ----

	/** A URL object for an https URL without credentials or an explicit port, else null */
	parseURL: function(text) {
		if (typeof text !== "string" || !text || typeof URL === "undefined") { return null; }
		let url;
		try { url = new URL(text.trim()); } catch (e) { return null; }
		if (url.protocol !== "https:" || url.username || url.password || url.port) { return null; }
		return url;
	},

	/** "Some Name" from a URL path segment ("Some_Name", "Some%20Name"), at most MAX_LABEL characters */
	pathName: function(segment) {
		let name = String(segment || "");
		try { name = decodeURIComponent(name); } catch (e) { /* keep it as it is */ }
		name = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
		return name.length > smartNotes.MAX_LABEL ? name.substring(0, smartNotes.MAX_LABEL - 1) + "…" : name;
	},

	/** Domain plus first path segment, e.g. "reddit.com/r/Eve…" (a very short first segment takes the next one along) */
	shortLabel: function(url) {
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		const parts = url.pathname.split("/").filter(function(p) { return p; });
		let shown = parts.slice(0, 1);
		if (parts.length > 1 && parts[0].length <= 2) { shown = parts.slice(0, 2); }
		let label = host + (shown.length ? "/" + shown.map(smartNotes.pathName).join("/") : "");
		if (parts.length > shown.length || url.search || url.hash) { label += "…"; }
		return label.length > smartNotes.MAX_LABEL ? label.substring(0, smartNotes.MAX_LABEL - 1) + "…" : label;
	},

	/**
	 * What a link is, or null when it isn't an https URL:
	 * {kind: 'kill', id, url} | {kind: 'zkill', type: character|corporation|alliance|system, id, url}
	 * | {kind: 'dotlan', label, system, url} | {kind: 'evewho', type, id, url} | {kind: 'link', label, url}
	 */
	classify: function(href) {
		const url = smartNotes.parseURL(href);
		if (!url) { return null; }
		const site = smartNotes.HOSTS[url.hostname.toLowerCase()];
		const path = url.pathname;
		let m;
		if (site === "zkill") {
			if ((m = /^\/kill\/(\d{1,12})\/?$/.exec(path)) && parseInt(m[1], 10) > 0) {
				return { kind: "kill", id: parseInt(m[1], 10), url: "https://zkillboard.com/kill/" + parseInt(m[1], 10) + "/" };
			}
			if ((m = /^\/(character|corporation|alliance|system)\/(\d{1,12})(?:\/.*)?$/.exec(path)) && smartNotes.validEntity(m[1], m[2])) {
				return { kind: "zkill", type: m[1], id: parseInt(m[2], 10), url: url.href };
			}
		} else if (site === "dotlan") {
			if ((m = /^\/system\/([^/]+)/.exec(path))) {
				const system = smartNotes.pathName(m[1]);
				if (system) { return { kind: "dotlan", label: system, system: system, url: url.href }; }
			}
			if ((m = /^\/(?:map|region)\/([^/]+)(?:\/([^/]+))?/.exec(path))) {
				const region = smartNotes.pathName(m[1]);
				const system = m[2] ? smartNotes.pathName(m[2]) : "";
				if (region) { return { kind: "dotlan", label: region + (system ? " › " + system : ""), system: system || null, url: url.href }; }
			}
		} else if (site === "evewho") {
			if ((m = /^\/(character|corporation|alliance)\/(\d{1,12})\/?$/.exec(path)) && smartNotes.validEntity(m[1], m[2])) {
				return { kind: "evewho", type: m[1], id: parseInt(m[2], 10), url: url.href };
			}
		}
		return { kind: "link", label: smartNotes.shortLabel(url), url: url.href };
	},

	/** A plausible entity ID: positive, and 32-bit for characters / corporations / alliances (the server skips others) */
	validEntity: function(type, id) {
		const n = parseInt(id, 10);
		return n > 0 && (type === "system" || n <= smartNotes.MAX_ENTITY_ID);
	},

	/** Whether a link's text is just its URL (as the editor's autolink writes it), so replacing it loses nothing */
	isURLText: function(text, href) {
		const norm = function(s) {
			let v = String(s || "").trim();
			try { v = decodeURI(v); } catch (e) { /* keep it */ }
			return v.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
		};
		return norm(text) !== "" && norm(text) === norm(href);
	},

	/** Bare https URLs in plain text: [{start, end, url}] (trailing punctuation and unbalanced brackets left out) */
	findURLs: function(text) {
		const found = [];
		const re = /https:\/\/[^\s<>"'`]+/gi;
		let m;
		while ((m = re.exec(text))) {
			let url = m[0];
			// Sentence punctuation after a URL isn't part of it; a closing bracket only when it closes one inside
			for (;;) {
				const last = url.charAt(url.length - 1);
				if (/[.,;:!?*]/.test(last)) { url = url.slice(0, -1); continue; }
				const pairs = { ")": "(", "]": "[", "}": "{" };
				if (pairs[last] && url.split(pairs[last]).length <= url.split(last).length - 1) { url = url.slice(0, -1); continue; }
				break;
			}
			if (url.length > "https://".length) { found.push({ start: m.index, end: m.index + url.length, url: url }); }
		}
		return found;
	},

	// ---- System names in text ----

	/** name -> systemID for single-word system names (J-space and k-space) from static data like appData.systems, minus everyday words */
	systemIndex: function(systems) {
		const index = {};
		Object.keys(systems || {}).forEach(function(id) {
			const name = systems[id] && systems[id].name;
			if (typeof name === "string" && /^[A-Za-z0-9-]{3,}$/.test(name) && /[A-Za-z]/.test(name) && smartNotes.NOT_SYSTEM_WORDS.indexOf(name) < 0) {
				index[name] = parseInt(id, 10);
			}
		});
		return index;
	},

	/** Whole-word system names in text: [{start, end, systemID, name}] (J-codes in any case, other names exactly) */
	findSystems: function(text, index) {
		const found = [];
		if (!index) { return found; }
		const re = /[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/g;
		let m;
		while ((m = re.exec(text))) {
			const word = m[0];
			const before = m.index > 0 ? text.charAt(m.index - 1) : "";
			const after = text.charAt(m.index + word.length);
			const afterNext = text.charAt(m.index + word.length + 1);
			// Not part of a path, domain, address or identifier ("evemaps.dotlan.net/Jita", "x@Jita", "Jita.com", "Jita_1")
			if (/[\w\/.@:#&=?%+-]/.test(before) || after === "_" || ((after === "." || after === "@" || after === "/") && /\w/.test(afterNext))) { continue; }
			let name = word;
			let id = Object.prototype.hasOwnProperty.call(index, name) ? index[name] : undefined;
			if (id === undefined && /^j\d{6}$/i.test(word)) {
				name = word.toUpperCase();
				id = Object.prototype.hasOwnProperty.call(index, name) ? index[name] : undefined;
			}
			if (id !== undefined) { found.push({ start: m.index, end: m.index + word.length, systemID: id, name: name }); }
		}
		return found;
	},

	// ---- Formatting ----

	/** "1.2b", "450m", "12.3m", "85k", "" for nothing */
	formatISK: function(value) {
		const v = Number(value);
		if (!isFinite(v) || v <= 0) { return ""; }
		const fmt = function(n, unit) {
			const text = n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
			return text + unit;
		};
		if (v >= 1e12) { return fmt(v / 1e12, "t"); }
		if (v >= 1e9) { return fmt(v / 1e9, "b"); }
		if (v >= 1e6) { return fmt(v / 1e6, "m"); }
		if (v >= 1e3) { return fmt(v / 1e3, "k"); }
		return String(Math.round(v));
	},

	/** "just now", "12 min ago", "3 h ago", "2 d ago" */
	timeAgo: function(timeMs, nowMs) {
		if (!isFinite(timeMs) || !isFinite(nowMs)) { return ""; }
		const s = Math.max(0, Math.floor((nowMs - timeMs) / 1000));
		if (s < 60) { return "just now"; }
		if (s < 3600) { return Math.floor(s / 60) + " min ago"; }
		if (s < 86400) { return Math.floor(s / 3600) + " h ago"; }
		return Math.floor(s / 86400) + " d ago";
	},

	/** EVE time (UTC): {short: "21:13", full: "2026-09-01 21:13"} */
	eveTime: function(timeMs) {
		if (!isFinite(timeMs)) { return { short: "", full: "" }; }
		const iso = new Date(timeMs).toISOString();
		return { short: iso.substring(11, 16), full: iso.substring(0, 10) + " " + iso.substring(11, 16) };
	},

	/** CCP image server URL from a numeric ID only ("" for anything else) */
	imageURL: function(kind, id, size) {
		const n = Number(id);
		if (!Number.isInteger(n) || n <= 0) { return ""; }
		const px = size === 64 ? 64 : 32;
		if (kind === "type") { return "https://images.evetech.net/types/" + n + "/icon?size=" + px; }
		if (kind === "character") { return "https://images.evetech.net/characters/" + n + "/portrait?size=" + px; }
		if (kind === "corporation") { return "https://images.evetech.net/corporations/" + n + "/logo?size=" + px; }
		if (kind === "alliance") { return "https://images.evetech.net/alliances/" + n + "/logo?size=" + px; }
		return "";
	},

	/**
	 * What a kill card shows. entry: the endpoint's answer for the kill (undefined while loading); names: id -> name.
	 * @return {state: 'loading'|'ok'|'failed', ...text fields}
	 */
	cardModel: function(killID, entry, names, systemInfo, nowMs) {
		const id = parseInt(killID, 10);
		const base = { killID: id, url: "https://zkillboard.com/kill/" + id + "/" };
		if (!entry || entry.state === "loading") { return Object.assign(base, { state: "loading", label: "Kill " + id + " · loading…" }); }
		if (entry.state !== "ok" || !entry.data) { return Object.assign(base, { state: "failed" }); }
		const k = entry.data;
		const victim = k.victim || {};
		const finalBlow = k.finalBlow || {};
		const name = function(nid) {
			return nid !== null && nid !== undefined && names && Object.prototype.hasOwnProperty.call(names, String(nid)) ? String(names[String(nid)]) : "";
		};
		const time = Date.parse(k.killTime);
		const eve = smartNotes.eveTime(time);
		const system = systemInfo ? systemInfo(k.systemID) : null;
		const shipName = name(victim.shipTypeID);
		const attackers = parseInt(k.attackers, 10) || 0;
		return Object.assign(base, {
			state: "ok",
			side: k.side === "loss" || k.side === "kill" ? k.side : null,
			shipIcon: smartNotes.imageURL("type", victim.shipTypeID, 32),
			shipName: shipName || "Unknown ship",
			// Structures and other losses without a pilot are named by their type
			victimName: victim.characterID ? (name(victim.characterID) || "Unknown pilot") : (shipName || "Unknown"),
			victimCorp: name(victim.allianceID) && name(victim.corporationID) ? name(victim.corporationID) + " / " + name(victim.allianceID) : name(victim.corporationID),
			systemName: system ? system.name : (k.systemID ? "System " + parseInt(k.systemID, 10) : ""),
			systemClass: system ? system.cls : "",
			systemType: system ? system.type : "",
			value: smartNotes.formatISK(k.value),
			time: eve.short,
			timeFull: eve.full,
			age: smartNotes.timeAgo(time, nowMs),
			attackers: attackers,
			attackersText: attackers + (attackers === 1 ? " pilot" : " involved"),
			finalBlowIcon: smartNotes.imageURL("type", finalBlow.shipTypeID, 32),
			finalBlowShip: name(finalBlow.shipTypeID)
		});
	},

	// ---- DOM building (text and attributes only) ----

	/** Element with attributes (values set with setAttribute) and children (strings become text nodes) */
	el: function(doc, tag, attrs, children) {
		const node = doc.createElement(tag);
		Object.keys(attrs || {}).forEach(function(k) {
			if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) { node.setAttribute(k, String(attrs[k])); }
		});
		(children || []).forEach(function(child) {
			if (child === null || child === undefined || child === "") { return; }
			node.appendChild(typeof child === "string" ? doc.createTextNode(child) : child);
		});
		return node;
	},

	/** Attributes of an outgoing link (new tab, no opener, no referrer) */
	linkAttrs: function(href, cls, title) {
		return { "class": cls, href: href, target: "_blank", rel: "noopener noreferrer", title: title || null };
	},

	/** A kill card in its current state (fill / refill it with renderKill) */
	buildKill: function(doc, desc, ctx) {
		const card = smartNotes.el(doc, "a", Object.assign(smartNotes.linkAttrs(desc.url, "sn sn-kill"), { "data-kill-id": desc.id }));
		smartNotes.renderKill(doc, card, smartNotes.cardModel(desc.id, ctx.killEntry(desc.id), ctx.names, ctx.systemInfo, ctx.now()));
		return card;
	},

	/** (Re)fill a kill card from its model; a failed card is left for the caller to replace with the plain link */
	renderKill: function(doc, card, model) {
		while (card.firstChild) { card.removeChild(card.firstChild); }
		const el = smartNotes.el;
		let cls = "sn sn-kill";
		if (model.state === "loading") {
			cls += " sn-loading";
			card.appendChild(el(doc, "span", { "class": "sn-kill-label" }, [model.label]));
			card.setAttribute("title", "Loading kill " + model.killID + " (zKillboard)");
		} else if (model.state === "ok") {
			if (model.side) { cls += " sn-side-" + model.side; }
			card.appendChild(model.shipIcon ? el(doc, "img", { "class": "sn-icon sn-ship-icon", src: model.shipIcon, alt: "", loading: "lazy" })
				: el(doc, "span", { "class": "sn-icon sn-ship-icon" }));
			card.appendChild(el(doc, "span", { "class": "sn-ship" }, [model.shipName]));
			card.appendChild(el(doc, "span", { "class": "sn-victim" }, [model.victimName]));
			if (model.victimCorp) { card.appendChild(el(doc, "span", { "class": "sn-corp" }, [model.victimCorp])); }
			if (model.systemName) { card.appendChild(el(doc, "span", { "class": "sn-sys " + (model.systemClass || "") }, [model.systemName])); }
			if (model.value) { card.appendChild(el(doc, "span", { "class": "sn-isk" }, [model.value])); }
			if (model.age) { card.appendChild(el(doc, "span", { "class": "sn-time" }, [model.age])); }	// EVE time is in the tooltip
			card.appendChild(el(doc, "span", { "class": "sn-att" }, [String(model.attackers)]));
			if (model.finalBlowIcon) { card.appendChild(el(doc, "img", { "class": "sn-icon sn-fb-icon", src: model.finalBlowIcon, alt: "", loading: "lazy" })); }
			const title = [
				model.shipName + " – " + model.victimName + (model.victimCorp ? " (" + model.victimCorp + ")" : ""),
				(model.systemName ? model.systemName + (model.systemType ? " (" + model.systemType + ")" : "") + " · " : "") + model.timeFull + " EVE · " + model.age,
				(model.value ? model.value + " ISK · " : "") + model.attackersText + (model.finalBlowShip ? " · final blow: " + model.finalBlowShip : ""),
				model.side === "loss" ? "Our loss" : model.side === "kill" ? "Our kill" : null,
				"Open on zKillboard"
			].filter(function(l) { return l; }).join("\n");
			card.setAttribute("title", title);
		}
		card.setAttribute("class", cls);
	},

	/** Chip for a zKillboard character / corporation / alliance or EveWho link */
	buildEntity: function(doc, desc, ctx) {
		const site = desc.kind === "evewho" ? "EveWho" : "zKillboard";
		const chip = smartNotes.el(doc, "a", Object.assign(smartNotes.linkAttrs(desc.url, "sn sn-chip sn-entity sn-" + desc.kind,
			smartNotes.ENTITY_LABELS[desc.type] + " on " + site), { "data-entity-id": desc.id, "data-entity-type": desc.type }));
		const icon = smartNotes.imageURL(desc.type, desc.id, 32);
		if (icon) { chip.appendChild(smartNotes.el(doc, "img", { "class": "sn-icon", src: icon, alt: "", loading: "lazy" })); }
		if (desc.kind === "evewho") { chip.appendChild(smartNotes.el(doc, "span", { "class": "sn-site" }, ["EveWho"])); }
		chip.appendChild(smartNotes.el(doc, "span", { "class": "sn-name" }, [smartNotes.entityName(desc, ctx.names)]));
		return chip;
	},

	entityName: function(desc, names) {
		const key = String(desc.id);
		return names && Object.prototype.hasOwnProperty.call(names, key) ? String(names[key]) : smartNotes.ENTITY_LABELS[desc.type] + " " + desc.id;
	},

	/**
	 * System chip. href: the zKillboard / Dotlan link it came from, or null for a name written in the text (then it
	 * links to the system in Tripwire). A click on a chip whose system is on the chain map views it in Tripwire.
	 */
	buildSystem: function(doc, systemID, info, href, site) {
		const name = info ? info.name : smartNotes.ENTITY_LABELS.system + " " + systemID;
		const attrs = href
			? smartNotes.linkAttrs(href, "sn sn-chip sn-system", name + (info && info.type ? " (" + info.type + ")" : "") + " – view in Tripwire if it is on the map, else open on " + site)
			// upstream's a[href^='.?system='] handler views it in Tripwire (static data names only: letters, digits, dashes)
			: { "class": "sn sn-chip sn-system", href: ".?system=" + name, title: name + (info && info.type ? " (" + info.type + ")" : "") + " – view in Tripwire" };
		attrs["data-system-id"] = systemID;
		const chip = smartNotes.el(doc, "a", attrs);
		if (info && info.type && info.type.trim()) { chip.appendChild(smartNotes.el(doc, "span", { "class": "sn-sys-type " + (info.cls || "") }, [info.type])); }
		chip.appendChild(smartNotes.el(doc, "span", { "class": "sn-name " + (info ? info.cls || "" : "") }, [name]));
		return chip;
	},

	/** Chip with a site name and a label (Dotlan); nameClass colours the label (a system's class colour) */
	buildSite: function(doc, site, label, href, nameClass) {
		return smartNotes.el(doc, "a", smartNotes.linkAttrs(href, "sn sn-chip sn-site-chip", href), [
			smartNotes.el(doc, "span", { "class": "sn-site" }, [site]),
			smartNotes.el(doc, "span", { "class": "sn-name" + (nameClass ? " " + nameClass : "") }, [label])
		]);
	},

	/** Shortened chip for a long link anywhere else (full URL in the tooltip) */
	buildShort: function(doc, desc) {
		return smartNotes.el(doc, "a", smartNotes.linkAttrs(desc.url, "sn sn-chip sn-short", desc.url), [
			smartNotes.el(doc, "span", { "class": "sn-name" }, [desc.label])
		]);
	},

	/** Plain link for a bare URL (or a kill card that could not be loaded) */
	buildPlain: function(doc, href, text) {
		return smartNotes.el(doc, "a", smartNotes.linkAttrs(href, "sn sn-plain"), [text]);
	},

	/** Node for a recognised link, or null to leave it alone. fromText: a bare URL from plain text (always becomes a link) */
	nodeFor: function(doc, desc, text, ctx, fromText) {
		if (!desc) { return null; }
		if (desc.kind === "kill") {
			const entry = ctx.killEntry(desc.id);
			if (entry && entry.state === "failed") { return smartNotes.buildPlain(doc, desc.url, text); }
			const card = smartNotes.buildKill(doc, desc, ctx);
			ctx.wantKill(desc.id);
			ctx.plainText.set(card, text);
			return card;
		}
		if (desc.kind === "zkill" && desc.type === "system") {
			const info = ctx.systemInfo(desc.id);
			return info ? smartNotes.buildSystem(doc, desc.id, info, desc.url, "zKillboard") : smartNotes.buildPlainOrShort(doc, desc.url, text, fromText);
		}
		if (desc.kind === "zkill" || desc.kind === "evewho") {
			if (!(ctx.names && Object.prototype.hasOwnProperty.call(ctx.names, String(desc.id)))) { ctx.wantName(desc.id); }
			return smartNotes.buildEntity(doc, desc, ctx);
		}
		if (desc.kind === "dotlan") {
			const systemID = desc.system && ctx.systemIndex ? ctx.systemIndex[desc.system] : undefined;
			const info = systemID !== undefined ? ctx.systemInfo(systemID) : null;
			return smartNotes.buildSite(doc, "Dotlan", desc.label, desc.url, info ? info.cls : "");
		}
		return smartNotes.buildPlainOrShort(doc, desc.url, text, fromText);
	},

	/** A long link becomes a shortened chip; a short one stays a link (a bare URL from text becomes one) */
	buildPlainOrShort: function(doc, url, text, fromText) {
		if (url.length >= smartNotes.LONG_URL) { return smartNotes.buildShort(doc, { url: url, label: smartNotes.shortLabel(smartNotes.parseURL(url)) }); }
		return fromText ? smartNotes.buildPlain(doc, url, text) : null;
	},

	// ---- Enhancing a note ----

	/**
	 * Replace recognised links, bare URLs and (ctx.systemNames) system names in a rendered note with cards and chips.
	 * Text inside links, code and earlier chips is left alone. Returns the created nodes.
	 */
	enhanceNode: function(doc, root, ctx) {
		const created = [];
		const visit = function(node) {
			Array.prototype.slice.call(node.childNodes).forEach(function(child) {
				if (child.nodeType === 3) {
					smartNotes.enhanceText(doc, child, ctx, created);
				} else if (child.nodeType === 1) {
					const tag = String(child.nodeName).toUpperCase();
					if (tag === "A") {
						smartNotes.enhanceLink(doc, child, ctx, created);
					} else if (!smartNotes.SKIP_TAGS[tag]) {
						visit(child);
					}
				}
			});
		};
		visit(root);
		created.forEach(function(n) { smartNotes.ours.add(n); });
		return created;
	},

	enhanceLink: function(doc, a, ctx, created) {
		const href = a.getAttribute("href");
		const text = a.textContent;
		if (!href || !smartNotes.isURLText(text, href)) { return; }   // a link with its own words keeps them
		const node = smartNotes.nodeFor(doc, smartNotes.classify(href), text.trim(), ctx, false);
		if (!node) { return; }
		a.parentNode.replaceChild(node, a);
		created.push(node);
	},

	enhanceText: function(doc, textNode, ctx, created) {
		const text = textNode.nodeValue || "";
		if (text.length < 3) { return; }
		const parts = [];
		smartNotes.findURLs(text).forEach(function(u) {
			const desc = smartNotes.classify(u.url);
			if (desc) { parts.push({ start: u.start, end: u.end, make: function() { return smartNotes.nodeFor(doc, desc, u.url, ctx, true); } }); }
		});
		if (ctx.systemNames && ctx.systemIndex) {
			smartNotes.findSystems(text, ctx.systemIndex).forEach(function(s) {
				if (parts.some(function(p) { return s.start < p.end && s.end > p.start; })) { return; }   // inside a URL
				const info = ctx.systemInfo(s.systemID);
				if (info) { parts.push({ start: s.start, end: s.end, make: function() { return smartNotes.buildSystem(doc, s.systemID, info, null); } }); }
			});
		}
		if (!parts.length) { return; }
		parts.sort(function(a, b) { return a.start - b.start; });
		const frag = doc.createDocumentFragment();
		let pos = 0;
		parts.forEach(function(p) {
			const node = p.make();
			if (!node) { return; }
			if (p.start > pos) { frag.appendChild(doc.createTextNode(text.substring(pos, p.start))); }
			frag.appendChild(node);
			created.push(node);
			pos = p.end;
		});
		if (pos === 0) { return; }
		if (pos < text.length) { frag.appendChild(doc.createTextNode(text.substring(pos))); }
		textNode.parentNode.replaceChild(frag, textNode);
	},

	// ---- State per note body ----

	bodies: (typeof WeakMap !== "undefined") ? new WeakMap() : null,	// body -> {backup: [nodes], nodes: [created]}
	plainText: (typeof WeakMap !== "undefined") ? new WeakMap() : null,	// kill card -> the text it replaced
	// Nodes this script created: only these are re-rendered later (a note can't dress up its own link as a card)
	ours: (typeof WeakSet !== "undefined") ? new WeakSet() : null,

	/** Whether the body still shows cards / chips from an earlier pass (upstream replaces the content on a change) */
	isEnhanced: function(body) {
		const state = smartNotes.bodies.get(body);
		return !!(state && state.nodes.some(function(n) { return body.contains(n); }));
	},

	/** Enhance one note body unless it already is; keeps a copy of the original nodes for restore() */
	enhance: function(doc, body, ctx) {
		if (smartNotes.isEnhanced(body)) { return false; }
		const backup = Array.prototype.map.call(body.childNodes, function(n) { return n.cloneNode(true); });
		const nodes = smartNotes.enhanceNode(doc, body, ctx);
		smartNotes.bodies.set(body, { backup: backup, nodes: nodes });
		return nodes.length > 0;
	},

	/** Put the note's original nodes back (before editing, or when smart notes are switched off) */
	restore: function(body) {
		const state = smartNotes.bodies.get(body);
		if (!state) { return false; }
		smartNotes.bodies.delete(body);
		if (!state.nodes.some(function(n) { return body.contains(n); })) { return false; }
		while (body.firstChild) { body.removeChild(body.firstChild); }
		state.backup.forEach(function(n) { body.appendChild(n.cloneNode(true)); });
		return true;
	},

	// ---- Kill data and names (browser) ----

	kills: {},	// killID -> {state: 'loading'|'ok'|'failed', data, tries}
	names: {},	// id -> name
	pendingKills: {},
	pendingNames: {},
	nameTries: 0,
	flushTimer: null,

	killEntry: function(killID) {
		return smartNotes.kills[killID];
	},

	/** Ask for a kill (once; a known kill is not asked again) */
	wantKill: function(killID) {
		if (!smartNotes.kills[killID]) {
			smartNotes.kills[killID] = { state: "loading", tries: 0 };
			smartNotes.pendingKills[killID] = true;
			smartNotes.scheduleFlush(0);
		}
	},

	wantName: function(id) {
		if (!Object.prototype.hasOwnProperty.call(smartNotes.names, String(id)) && !smartNotes.pendingNames[id]) {
			smartNotes.pendingNames[id] = true;
			smartNotes.scheduleFlush(0);
		}
	},

	scheduleFlush: function(delay) {
		if (smartNotes.flushTimer !== null) { return; }
		smartNotes.flushTimer = setTimeout(function() {
			smartNotes.flushTimer = null;
			smartNotes.flush();
		}, delay || 0);
	},

	/** Send what is pending (at most MAX_IDS kills and names per request; the rest goes in the next one) */
	flush: function() {
		if (!smartNotes.enabled(smartNotes.opts())) {
			// Switched off meanwhile: forget kills that never loaded, so they are asked for again when it is switched back on
			Object.keys(smartNotes.pendingKills).forEach(function(id) {
				if (smartNotes.kills[id] && smartNotes.kills[id].state === "loading") { delete smartNotes.kills[id]; }
			});
			smartNotes.pendingKills = {};
			smartNotes.pendingNames = {};
			return;
		}
		const ids = Object.keys(smartNotes.pendingKills).slice(0, smartNotes.MAX_IDS);
		const names = Object.keys(smartNotes.pendingNames).slice(0, smartNotes.MAX_IDS);
		if (!ids.length && !names.length) { return; }
		ids.forEach(function(id) { delete smartNotes.pendingKills[id]; });
		names.forEach(function(id) { delete smartNotes.pendingNames[id]; });
		$.ajax({ url: smartNotes.URL, type: "GET", dataType: "json", data: { ids: ids.join(","), names: names.join(",") } })
			.done(function(response) { smartNotes.receive(ids, names, response); })
			.fail(function() { smartNotes.receive(ids, names, null); });
		if (Object.keys(smartNotes.pendingKills).length || Object.keys(smartNotes.pendingNames).length) { smartNotes.scheduleFlush(0); }
	},

	/** Handle an answer (null: the request failed, which counts like "queued") and update the cards and chips */
	receive: function(ids, names, response) {
		const kills = response && response.kills ? response.kills : {};
		if (response && response.names) {
			Object.keys(response.names).forEach(function(id) { smartNotes.names[id] = String(response.names[id]); });
		}
		ids.forEach(function(id) {
			const entry = smartNotes.kills[id] || (smartNotes.kills[id] = { state: "loading", tries: 0 });
			const answer = kills[id];
			if (answer && answer.status === "ok") {
				entry.state = "ok";
				entry.data = answer;
			} else if (!answer || answer.status === "queued") {
				entry.tries++;
				if (entry.tries > smartNotes.RETRY_MS.length) {
					entry.state = "failed";
				} else {
					setTimeout(function() { smartNotes.pendingKills[id] = true; smartNotes.scheduleFlush(0); }, smartNotes.RETRY_MS[entry.tries - 1]);
				}
			} else {
				entry.state = "failed";	// failed / full / unavailable: the plain link
			}
		});
		// Names the worker is still resolving, or names of a request that failed: ask again (with the kills whose names
		// are missing) on the same backoff, at most RETRY_MS.length rounds in a row
		if (response && !response.namesPending) { smartNotes.nameTries = 0; }
		if ((response ? response.namesPending : names.length > 0) && smartNotes.nameTries < smartNotes.RETRY_MS.length) {
			const delay = smartNotes.RETRY_MS[smartNotes.nameTries++];
			const again = names.filter(function(id) { return !Object.prototype.hasOwnProperty.call(smartNotes.names, String(id)); });
			const okKills = ids.filter(function(id) { return smartNotes.kills[id] && smartNotes.kills[id].state === "ok"; });
			setTimeout(function() {
				again.forEach(function(id) { smartNotes.pendingNames[id] = true; });
				// a stored kill is answered from the database again, now with more names
				okKills.forEach(function(id) { smartNotes.kills[id].tries = 0; smartNotes.pendingKills[id] = true; });
				smartNotes.scheduleFlush(0);
			}, delay);
		}
		smartNotes.updateDOM();
	},

	/** Re-render the cards and entity chips on the page with what is known now */
	updateDOM: function() {
		if (typeof document === "undefined" || !document.querySelectorAll) { return; }
		const ctx = smartNotes.context();
		Array.prototype.forEach.call(document.querySelectorAll("a.sn-kill[data-kill-id]"), function(card) {
			if (!smartNotes.ours.has(card)) { return; }
			const id = parseInt(card.getAttribute("data-kill-id"), 10);
			const model = smartNotes.cardModel(id, smartNotes.kills[id], smartNotes.names, ctx.systemInfo, ctx.now());
			if (model.state === "failed") {
				// Fall back to the original link (text as the note had it)
				const plain = smartNotes.buildPlain(document, model.url, smartNotes.plainText.get(card) || model.url);
				smartNotes.swapCreated(card, plain);
			} else {
				smartNotes.renderKill(document, card, model);
			}
		});
		Array.prototype.forEach.call(document.querySelectorAll("a.sn-entity[data-entity-id]"), function(chip) {
			if (!smartNotes.ours.has(chip)) { return; }
			const name = chip.querySelector(".sn-name");
			const desc = { id: chip.getAttribute("data-entity-id"), type: chip.getAttribute("data-entity-type") };
			if (name && smartNotes.ENTITY_LABELS[desc.type]) { name.textContent = smartNotes.entityName(desc, smartNotes.names); }
		});
	},

	/** Replace a created node with another and keep the body's bookkeeping right */
	swapCreated: function(oldNode, newNode) {
		const body = oldNode.closest ? oldNode.closest(".commentBody") : null;
		oldNode.parentNode.replaceChild(newNode, oldNode);
		smartNotes.ours.add(newNode);
		const state = body ? smartNotes.bodies.get(body) : null;
		if (state) { state.nodes = state.nodes.map(function(n) { return n === oldNode ? newNode : n; }); }
	},

	// ---- Browser wiring ----

	systemIndexCache: null,

	/** Context for enhance(): settings, static data and the kill / name state */
	context: function() {
		const opts = smartNotes.opts();
		if (smartNotes.systemIndexCache === null && typeof appData !== "undefined" && appData.systems) {
			smartNotes.systemIndexCache = smartNotes.systemIndex(appData.systems);
		}
		return {
			systemNames: smartNotes.systemNames(opts),
			systemIndex: smartNotes.systemIndexCache,
			systemInfo: smartNotes.systemInfo,
			names: smartNotes.names,
			killEntry: smartNotes.killEntry,
			wantKill: smartNotes.wantKill,
			wantName: smartNotes.wantName,
			plainText: smartNotes.plainText,
			now: function() { return Date.now(); }
		};
	},

	/** {name, cls (colour class), type ("C5", "HS")} of a system in the static data, or null */
	systemInfo: function(systemID) {
		if (typeof appData === "undefined" || !appData.systems || !appData.systems[systemID]) { return null; }
		const s = typeof systemAnalysis !== "undefined" ? systemAnalysis.analyse(systemID) : appData.systems[systemID];
		return { name: String(s.name), cls: s.systemTypeClass || "", type: s.systemTypeName || "" };
	},

	/** Note bodies on the page that are displayed (not the hidden template, not open in the editor) */
	displayedBodies: function() {
		return Array.prototype.filter.call(document.querySelectorAll("#comment-container .comment .commentBody"), function(body) {
			const comment = body.closest(".comment");
			if (!comment || comment.classList.contains("hidden")) { return false; }
			return !(body.id && typeof CKEDITOR !== "undefined" && CKEDITOR.instances && CKEDITOR.instances[body.id]);
		});
	},

	/** Enhance every displayed note (smart notes on), or put every note back as stored (off) */
	scan: function() {
		const on = smartNotes.enabled(smartNotes.opts());
		const ctx = on ? smartNotes.context() : null;
		smartNotes.displayedBodies().forEach(function(body) {
			if (on) { smartNotes.enhance(document, body, ctx); } else { smartNotes.restore(body); }
		});
	},

	scanTimer: null,
	scheduleScan: function() {
		if (smartNotes.scanTimer !== null) { return; }
		smartNotes.scanTimer = setTimeout(function() { smartNotes.scanTimer = null; smartNotes.scan(); }, 30);
	},

	/** Settings changed: start over (the system names sub-toggle changes what is converted) */
	refreshAll: function() {
		Array.prototype.forEach.call(document.querySelectorAll("#comment-container .commentBody"), function(body) { smartNotes.restore(body); });
		smartNotes.scan();
	},

	/**
	 * Hooks without editing upstream: a MutationObserver on the notes list enhances notes whenever upstream renders or
	 * replaces them; CKEditor's instanceCreated (fires before the editor reads the element) puts the original note
	 * back, so the editor and the saved note only ever see the stored HTML.
	 */
	install: function() {
		const container = document.getElementById("comment-container");
		if (!container || typeof MutationObserver === "undefined" || smartNotes.installed) { return; }
		smartNotes.installed = true;
		new MutationObserver(smartNotes.scheduleScan).observe(container, { childList: true, subtree: true });
		if (typeof CKEDITOR !== "undefined" && CKEDITOR.on) {
			CKEDITOR.on("instanceCreated", function(e) {
				const element = e && e.editor && e.editor.element ? e.editor.element.$ : null;
				if (element && element.classList && element.classList.contains("commentBody")) { smartNotes.restore(element); }
			});
			CKEDITOR.on("instanceDestroyed", smartNotes.scheduleScan);
		}
		// A zKillboard system chip whose system is on the chain map views it in Tripwire instead of opening zKillboard
		$(document).on("click", "a.sn-system[target]", function(e) {
			if (!smartNotes.ours.has(this)) { return; }
			if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) { return; }
			const id = parseInt($(this).attr("data-system-id"), 10);
			if (smartNotes.onMap(id) && typeof tripwire !== "undefined" && tripwire.systemChange) {
				e.preventDefault();
				tripwire.systemChange(id);
			}
		});
		// Ages on loaded cards move on
		setInterval(function() { if (smartNotes.enabled(smartNotes.opts())) { smartNotes.updateDOM(); } }, 60000);
		smartNotes.scheduleScan();
	},

	/** Whether the system is on the current chain map (or is the viewed system) */
	onMap: function(systemID) {
		if (!systemID) { return false; }
		if (typeof viewingSystemID !== "undefined" && parseInt(viewingSystemID, 10) === systemID) { return true; }
		const data = typeof chain !== "undefined" && chain.data ? chain.data : null;
		if (data && data.systemsInChainMap && data.systemsInChainMap[systemID]) { return true; }
		// The roots of the current chain tab
		const chainOpts = typeof options !== "undefined" && options.chain ? options.chain : null;
		const tab = chainOpts && chainOpts.tabs ? chainOpts.tabs[chainOpts.active] : null;
		return !!(tab && String(tab.systemID).split(",").some(function(id) { return parseInt(id, 10) === systemID; }));
	},

	// ---- Settings ----

	setupSettings: function() {
		// Settings > Kills & Intel; takes effect on Save (options.apply() below re-renders), Reset = on
		forkSettings.register({
			section: "intel", order: 60, id: "smartNotes", type: "custom", key: "smartNotes", label: "Smart notes:",
			keywords: "comments zkillboard links",
			html: "<label><input type='checkbox' id='smartNotes-enabled' /> Kill cards and link chips in notes</label><br/>"
				+ "<label><input type='checkbox' id='smartNotes-systemNames' /> System names in notes as chips (J163701)</label>",
			load: function() {
				const opts = smartNotes.opts();
				$("#smartNotes-enabled").prop("checked", smartNotes.enabled(opts));
				$("#smartNotes-systemNames").prop("checked", smartNotes.systemNames(opts));
			},
			save: function(o) {
				o.smartNotes = { enabled: $("#smartNotes-enabled").prop("checked"), systemNames: $("#smartNotes-systemNames").prop("checked") };
			}
		});
		// options.apply() runs on Save and Reset
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.smartNotesWrapped) {
			const apply = options.apply;
			const wrappedApply = function() {
				const result = apply.apply(this, arguments);
				if (smartNotes.installed) { smartNotes.refreshAll(); }
				return result;
			};
			Object.keys(apply).forEach(function(k) { wrappedApply[k] = apply[k]; });
			wrappedApply.smartNotesWrapped = true;
			options.apply = wrappedApply;
		}
	},

	init: function() {
		smartNotes.setupSettings();
		smartNotes.install();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { smartNotes.init(); });
}
