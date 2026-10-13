const killReporting = {
	// Kill Reporting: plays a sound (and shows a pop-up) when zKillboard reports a kill in a system on the
	// chain map (fork-owned file). Server side: zkill_feed.worker.php fills the kill table once for the whole
	// instance, public/kills.php serves it to browsers. Settings: options.killReporting (missing = defaults).
	// Keep `const killReporting` on the first line: the test helper strips it to define a global.
	URL: "kills.php",
	SOUND_PATH: "sounds/kill-reporting/",
	POLL_MS: 15000,
	TOAST_MS: 20000,	// counted only while the page is visible, so a kill reported while you're in the game waits for you
	MARK_MS: 10 * 60 * 1000,	// how long the chain map marks a system after a kill
	FLASH_MS: 2500,
	MAX_TOASTS: 4,
	MAX_SYSTEMS: 1000,
	MAX_QUEUE: 8,

	/** Categories, highest priority first */
	categories: ["loss", "kill", "gank", "neutral"],

	labels: {
		loss: "Friendly loss",
		kill: "Friendly kill",
		gank: "Large gank",
		neutral: "Small gank (neutral kill)"
	},

	/** Settings-table descriptions per category ({n} = gank threshold) */
	descriptions: {
		loss: "A pilot in your corporation (or the server's friendly corps) was killed",
		kill: "A pilot in your corporation (or the server's friendly corps) got the kill",
		gank: "More than {n} pilots on the kill",
		neutral: "{n} pilots or fewer on the kill"
	},

	/** What the default voice says, also spoken by the browser voice option */
	lines: {
		neutral: "Neutral kill detected",
		gank: "Gank detected",
		kill: "Catastrophic Impact detected",
		loss: "Catastrophic Impact denial detected"
	},

	/** Wording of the c-alt.mp3 files */
	altLines: {
		neutral: "Kill reported in chain",
		gank: "Hostile fleet engagement detected",
		kill: "Friendly kill confirmed",
		loss: "Friendly loss reported"
	},

	tones: [
		{ id: "tone-blip", label: "Tone – blip" },
		{ id: "tone-double-beep", label: "Tone – double beep" },
		{ id: "tone-klaxon", label: "Tone – klaxon" },
		{ id: "tone-sonar", label: "Tone – sonar" },
		{ id: "tone-chime", label: "Tone – chime" }
	],

	defaults: {
		enabled: true,
		popup: true,
		desktop: true,
		marker: true,
		threshold: 5,
		sounds: {
			neutral: { sound: "neutral-bot", volume: 80 },
			gank: { sound: "gank-bot", volume: 80 },
			kill: { sound: "kill-bot", volume: 80 },
			loss: { sound: "loss-bot", volume: 80 }
		}
	},

	/** Sound choices for a category: [{ id, label, file }] (file is missing for 'speech' and 'none') */
	soundOptions: function(category) {
		if (killReporting.categories.indexOf(category) < 0) { return []; }
		const path = killReporting.SOUND_PATH;
		const voices = [
			{ suffix: "bot", label: "Robot (default)" },
			{ suffix: "bot-deep", label: "Robot – deep" },
			{ suffix: "bot-high", label: "Robot – high" },
			{ suffix: "radio", label: "Radio" },
			{ suffix: "alert", label: "Alarm + voice" },
			{ suffix: "alt", label: "Robot – alt: " + killReporting.altLines[category] }
		].map(function(v) {
			const id = category + "-" + v.suffix;
			return { id: id, label: v.label, file: path + id + ".mp3" };
		});
		const tones = killReporting.tones.map(function(t) {
			return { id: t.id, label: t.label, file: path + t.id + ".mp3" };
		});
		return voices.concat(tones, [
			{ id: "speech", label: "Browser voice (text-to-speech)" },
			{ id: "none", label: "No sound" }
		]);
	},

	/** Integer within [min, max], or fallback for anything that isn't a number */
	clampInt: function(value, min, max, fallback) {
		if (value === null || value === undefined || value === "" || typeof value === "boolean" || typeof value === "object") { return fallback; }
		const n = Number(value);
		if (!isFinite(n)) { return fallback; }
		return Math.min(max, Math.max(min, Math.round(n)));
	},

	/** Merged settings from the user options (options.killReporting); missing or invalid values fall back to the defaults */
	settings: function(opts) {
		const d = killReporting.defaults;
		const raw = opts && typeof opts === "object" && opts.killReporting && typeof opts.killReporting === "object" ? opts.killReporting : {};
		const rawSounds = raw.sounds && typeof raw.sounds === "object" ? raw.sounds : {};
		const result = {
			enabled: raw.enabled !== false,
			popup: raw.popup !== false,
			desktop: raw.desktop !== false,
			marker: raw.marker !== false,
			threshold: killReporting.clampInt(raw.threshold, 1, 50, d.threshold),
			sounds: {}
		};
		killReporting.categories.forEach(function(c) {
			const s = rawSounds[c] && typeof rawSounds[c] === "object" ? rawSounds[c] : {};
			const valid = killReporting.soundOptions(c).some(function(o) { return o.id === s.sound; });
			result.sounds[c] = {
				sound: valid ? s.sound : d.sounds[c].sound,
				volume: killReporting.clampInt(s.volume, 0, 100, d.sounds[c].volume)
			};
		});
		return result;
	},

	/** Whether kill sounds are switched on in the given user options (options.killReporting.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.killReporting && opts.killReporting.enabled === false);
	},

	/** Category of a kill from kills.php: victim friendly > attacker friendly > more than threshold attacker characters */
	classify: function(kill, threshold) {
		if (!kill) { return "neutral"; }
		if (kill.friendlyVictim === true) { return "loss"; }
		if (kill.friendlyAttacker === true) { return "kill"; }
		const limit = killReporting.clampInt(threshold, 1, 50, killReporting.defaults.threshold);
		const pilots = Number(kill.attackerCharacterCount) || 0;
		return pilots > limit ? "gank" : "neutral";
	},

	/** Real New Eden / J-space system ID (not unknown-system placeholders or generic system types) */
	isRealSystemID: function(id) {
		if (id === null || id === undefined || id === "" || typeof id === "boolean") { return false; }
		const n = Number(id);
		return Number.isInteger(n) && n >= 30000000 && n < 32000000;
	},

	/** Whether a chain row is a calculated gate-route node or a synthetic node added by another feature */
	isExtraNode: function(row, node) {
		const id = String(node.v);
		const html = typeof node.f === "string" ? node.f : "";
		if (row.destination || id.indexOf("dest-") === 0 || html.indexOf("destination-node") >= 0 ||
			/id=['"](node)?dest-/.test(html)) { return true; }
		if (/class=['"][^'"]*\bcalc\b/.test(html)) { return true; }
		const last = Array.isArray(row.pathHome) && row.pathHome.length ? row.pathHome[row.pathHome.length - 1] : null;
		return !!(last && last.path);
	},

	/** System IDs (numbers, unique, sorted) of the systems drawn on the chain map.
	@param rows chain rows (chain.data.map.rows); defaults to the current chain map */
	chainSystemIDs: function(rows) {
		if (rows === undefined) {
			rows = typeof chain !== "undefined" && chain && chain.data && chain.data.map ? chain.data.map.rows : [];
		}
		const seen = {};
		(Array.isArray(rows) ? rows : []).forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || typeof node !== "object" || killReporting.isExtraNode(row, node)) { return; }
			if (killReporting.isRealSystemID(node.systemID)) { seen[Number(node.systemID)] = true; }
		});
		return Object.keys(seen).map(Number).sort(function(a, b) { return a - b; });
	},

	/** Short label of the hole leading to a chain row's system: its name, else the first 3 letters of the signature */
	holeLabel: function(row) {
		const last = row && Array.isArray(row.pathHome) && row.pathHome.length ? row.pathHome[row.pathHome.length - 1] : null;
		if (!last) { return ""; }
		if (last.name) { return String(last.name).substring(0, 24); }
		return last.signatureID ? String(last.signatureID).substring(0, 3).toUpperCase() : "";
	},

	/** Hole label(s) of a system on the chain map, as the map shows them ("A6", or "A6, B2" when it's on the map twice) */
	chainLabel: function(rows, systemID) {
		const labels = [];
		(Array.isArray(rows) ? rows : []).forEach(function(row) {
			const node = row && row.c && row.c[0];
			if (!node || typeof node !== "object" || String(node.systemID) !== String(systemID) || killReporting.isExtraNode(row, node)) { return; }
			const label = killReporting.holeLabel(row);
			if (label && labels.indexOf(label) < 0) { labels.push(label); }
		});
		return labels.join(", ");
	},

	/** Where a kill happened, as shown on the chain map: { label: hole label, name: system name, type: "C3"/"HS"/... }.
	@param place a { label, name, type } object, or just the system name */
	place: function(place) {
		if (!place || typeof place !== "object") { place = { name: place }; }
		const text = function(v) { return v === undefined || v === null ? "" : String(v); };
		return { label: text(place.label), name: text(place.name), type: text(place.type) };
	},

	/** Plain-text place: "A6 · J123456 (C3)" */
	placeText: function(place) {
		const p = killReporting.place(place);
		const name = p.name + (p.type ? (p.name ? " (" + p.type + ")" : p.type) : "");
		return [p.label, name].filter(function(s) { return s; }).join(" · ");
	},

	/** Desktop notification for a kill: { title, body } (plain text) */
	notificationText: function(kill, category, place) {
		const pilots = parseInt(kill && kill.attackerCharacterCount, 10) || 0;
		const isk = killReporting.formatISK(kill && kill.totalValue);
		return {
			title: (killReporting.labels[category] || category) + " in " + (killReporting.placeText(place) || "the chain"),
			body: pilots + (pilots === 1 ? " pilot" : " pilots") + (isk ? " — " + isk + " ISK" : "")
		};
	},

	/** Remember a kill for the chain map marker: marks = { systemID: { category, until } }. A higher-priority
	 *  category replaces a lower one; every kill restarts the timer. Returns marks. */
	mark: function(marks, systemID, category, now) {
		const rank = function(c) { const i = killReporting.categories.indexOf(c); return i < 0 ? 99 : i; };
		const old = marks[systemID];
		const keep = old && old.until > now && rank(old.category) < rank(category);
		marks[systemID] = { category: keep ? old.category : category, until: now + killReporting.MARK_MS };
		return marks;
	},

	/** Drop expired marks; returns marks */
	expireMarks: function(marks, now) {
		Object.keys(marks).forEach(function(id) { if (!(marks[id].until > now)) { delete marks[id]; } });
		return marks;
	},

	/** Work out what to report for the kills of one poll.
	@return { reports: [{ kill, category }] in arrival order, sounds: [category] at most one per category, highest priority first } */
	plan: function(kills, systemIDs, threshold) {
		const inChain = {};
		(systemIDs || []).forEach(function(id) { inChain[String(id)] = true; });
		const seenKills = {};
		const reports = [];
		(Array.isArray(kills) ? kills : []).forEach(function(kill) {
			if (!kill || !inChain[String(kill.systemID)] || seenKills[kill.killID]) { return; }
			seenKills[kill.killID] = true;
			reports.push({ kill: kill, category: killReporting.classify(kill, threshold) });
		});
		const sounds = killReporting.categories.filter(function(c) {
			return reports.some(function(r) { return r.category === c; });
		});
		return { reports: reports, sounds: sounds };
	},

	/** "12.3M", "1.20B", "450K", "900" */
	formatISK: function(value) {
		const v = Number(value);
		if (!isFinite(v) || v <= 0) { return ""; }
		if (v >= 1e12) { return (v / 1e12).toFixed(2) + "T"; }
		if (v >= 1e9) { return (v / 1e9).toFixed(2) + "B"; }
		if (v >= 1e6) { return (v / 1e6).toFixed(1) + "M"; }
		if (v >= 1e3) { return (v / 1e3).toFixed(0) + "K"; }
		return String(Math.round(v));
	},

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Pop-up markup for a kill.
	@param place { label, name, type } (see place()), or just the system name */
	toastHtml: function(kill, category, place) {
		const esc = killReporting.escape;
		const p = killReporting.place(place);
		const killID = parseInt(kill && kill.killID, 10) || 0;
		const systemID = killReporting.isRealSystemID(kill && kill.systemID) ? Number(kill.systemID) : 0;
		const shipID = parseInt(kill && kill.victimShipTypeID, 10) || 0;
		const pilots = parseInt(kill && kill.attackerCharacterCount, 10) || 0;
		const isk = killReporting.formatISK(kill && kill.totalValue);
		return "<div class='kill-toast kill-toast-" + esc(category) + "' data-killid='" + killID + "'"
			+ (systemID ? " data-systemid='" + systemID + "' title='Show on the chain map'" : "") + ">"
			+ "<span class='kill-toast-close' title='Dismiss'>&#10005;</span>"
			+ (shipID ? "<img class='kill-toast-ship' src='https://image.eveonline.com/Type/" + shipID + "_32.png' alt='' />" : "")
			+ "<div class='kill-toast-text'>"
			+ "<strong>" + esc(killReporting.labels[category] || category) + "</strong>"
			+ "<span class='kill-toast-place'>"
			+ (p.label ? "<span class='kill-toast-label'>" + esc(p.label) + "</span> " : "")
			+ esc(p.name)
			+ (p.type ? " <span class='kill-toast-type'>" + esc(p.type) + "</span>" : "")
			+ "</span>"
			+ pilots + (pilots === 1 ? " pilot" : " pilots") + (isk ? " — " + esc(isk) + " ISK" : "")
			+ (killID ? " · <a href='https://zkillboard.com/kill/" + killID + "/' target='_blank' rel='noopener noreferrer'>zKillboard</a>" : "")
			+ "</div></div>";
	},

	// ---- Browser-only code below (not run under mocha) ----

	cursor: null,
	inFlight: false,
	queue: [],
	playing: false,
	audioCache: {},
	autoplayWarned: false,
	preview: null,

	current: function() {
		return killReporting.settings(typeof options !== "undefined" ? options : undefined);
	},

	systemName: function(systemID) {
		const system = (typeof tripwire !== "undefined" && tripwire.systems && tripwire.systems[systemID]) ||
			(typeof appData !== "undefined" && appData.systems && appData.systems[systemID]);
		return system && system.name ? system.name : String(systemID);
	},

	fileFor: function(soundID) {
		const option = killReporting.soundOptions(soundID.split("-")[0]).concat(killReporting.soundOptions("neutral"))
			.filter(function(o) { return o.id === soundID; })[0];
		return option ? option.file : null;
	},

	audio: function(soundID) {
		if (!killReporting.audioCache[soundID]) {
			const file = killReporting.fileFor(soundID);
			if (!file) { return null; }
			const a = new Audio(file);
			a.preload = "auto";
			killReporting.audioCache[soundID] = a;
		}
		return killReporting.audioCache[soundID];
	},

	warnAutoplay: function(e) {
		if (killReporting.autoplayWarned) { return; }
		killReporting.autoplayWarned = true;
		console.info("Kill Reporting: the browser blocked a kill sound (click anywhere on the page to allow sounds)", e);
	},

	/** Play a sound; done() is called once when it has finished or failed */
	play: function(soundID, volume, category, done) {
		let finished = false;
		const finish = function() { if (!finished) { finished = true; clearTimeout(guard); if (done) { done(); } } };
		const guard = setTimeout(finish, 8000);
		const v = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
		try {
			if (soundID === "none" || v === 0) { return finish(); }
			if (soundID === "speech") {
				if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") { return finish(); }
				const u = new SpeechSynthesisUtterance(killReporting.lines[category] || "Kill detected");
				u.volume = v;
				u.onend = finish;
				u.onerror = finish;
				speechSynthesis.speak(u);
				return;
			}
			const a = killReporting.audio(soundID);
			if (!a) { return finish(); }
			a.pause();
			a.currentTime = 0;
			a.volume = v;
			a.onended = finish;
			a.onerror = finish;
			const p = a.play();
			if (p && typeof p.catch === "function") {
				p.catch(function(e) { killReporting.warnAutoplay(e); finish(); });
			}
		} catch (e) {
			killReporting.warnAutoplay(e);
			finish();
		}
	},

	enqueue: function(category, settings) {
		if (killReporting.queue.length >= killReporting.MAX_QUEUE) { return; }
		killReporting.queue.push({ category: category, sound: settings.sounds[category].sound, volume: settings.sounds[category].volume });
		killReporting.next();
	},

	next: function() {
		if (killReporting.playing || !killReporting.queue.length) { return; }
		const item = killReporting.queue.shift();
		killReporting.playing = true;
		killReporting.play(item.sound, item.volume, item.category, function() {
			killReporting.playing = false;
			killReporting.next();
		});
	},

	chainRows: function() {
		return typeof chain !== "undefined" && chain && chain.data && chain.data.map ? chain.data.map.rows : [];
	},

	/** Where a system is, as the chain map shows it: { label, name, type } */
	placeFor: function(systemID) {
		let type = "";
		try {
			if (typeof systemAnalysis !== "undefined") { type = systemAnalysis.analyse(systemID).systemTypeName || ""; }
		} catch (e) { /* unknown system: no class */ }
		return { label: killReporting.chainLabel(killReporting.chainRows(), systemID), name: killReporting.systemName(systemID), type: type };
	},

	$nodes: function(systemID) {
		return $("#chainMap [data-nodeid='" + (parseInt(systemID, 10) || 0) + "']");
	},

	/** Scroll the system's node into view and flash it */
	focusNode: function(systemID) {
		const $node = killReporting.$nodes(systemID);
		if (!$node.length) { return; }
		$node[0].scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
		$node.removeClass("kill-reporting-flash");
		void $node[0].offsetWidth;	// restart the animation
		$node.addClass("kill-reporting-flash");
		setTimeout(function() { $node.removeClass("kill-reporting-flash"); }, killReporting.FLASH_MS);
	},

	marks: {},	// systemID => { category, until }: systems marked on the chain map after a kill

	/** Put the kill markers on the chain map's nodes (after each redraw and when marks change) */
	applyMarks: function() {
		const marks = killReporting.expireMarks(killReporting.marks, Date.now());
		const on = killReporting.current().marker;
		const classes = killReporting.categories.map(function(c) { return "kill-reporting-mark-" + c; }).join(" ");
		$("#chainMap .kill-reporting-mark").removeClass("kill-reporting-mark " + classes);
		if (!on) { return; }
		Object.keys(marks).forEach(function(id) {
			killReporting.$nodes(id).addClass("kill-reporting-mark kill-reporting-mark-" + marks[id].category);
		});
	},

	/** Ask for desktop notification permission (must run from a click) */
	requestDesktop: function() {
		if (typeof Notification === "undefined" || Notification.permission !== "default") { return; }
		try {
			const p = Notification.requestPermission();
			if (p && typeof p.then === "function") { p.then(killReporting.updateDesktopHint); }
		} catch (e) { /* old browsers */ }
	},

	/** Desktop notification, only while Tripwire isn't the page you're looking at */
	notify: function(kill, category, place) {
		if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) { return; }
		try {
			const text = killReporting.notificationText(kill, category, place);
			const shipID = parseInt(kill && kill.victimShipTypeID, 10) || 0;
			const n = new Notification(text.title, {
				body: text.body,
				tag: "tripwire-kill-" + (parseInt(kill && kill.killID, 10) || 0),
				icon: shipID ? "https://image.eveonline.com/Type/" + shipID + "_64.png" : undefined
			});
			n.onclick = function() {
				window.focus();
				killReporting.focusNode(kill.systemID);
				n.close();
			};
		} catch (e) {
			console.warn("Kill Reporting: could not show a desktop notification", e);
		}
	},

	/** Fade the pop-up out after TOAST_MS of the page being visible (not hovered) */
	armDismiss: function($toast) {
		let left = killReporting.TOAST_MS;
		let started = null;
		let timer = null;
		const stop = function() {
			if (timer) { clearTimeout(timer); timer = null; left -= Date.now() - started; }
		};
		const start = function() {
			if (timer || document.hidden || $toast.is(":hover") || !$toast.closest("body").length) { return; }
			started = Date.now();
			timer = setTimeout(function() {
				$(document).off("visibilitychange", onVisibility);
				$toast.fadeOut(400, function() { $toast.remove(); });
			}, Math.max(0, left));
		};
		const onVisibility = function() { if (document.hidden) { stop(); } else { start(); } };
		$(document).on("visibilitychange", onVisibility);
		$toast.on("mouseenter", stop).on("mouseleave", start);
		$toast.on("remove-toast", function() { stop(); $(document).off("visibilitychange", onVisibility); });
		start();
	},

	toast: function(kill, category, place) {
		let $box = $("#kill-reporting-toasts");
		if (!$box.length) {
			$box = $("<div id='kill-reporting-toasts' aria-live='polite'></div>").appendTo("body");
		}
		if (!$box.data("killReportingBound")) {
			// Also when structure-timers.js created the box first
			$box.data("killReportingBound", true);
			$box.on("click", ".kill-toast-close", function() { $(this).closest(".kill-toast").trigger("remove-toast").remove(); });
			$box.on("click", ".kill-toast[data-systemid]", function(e) {
				if ($(e.target).closest("a, .kill-toast-close, .kill-toast-desktop").length) { return; }
				killReporting.focusNode($(this).attr("data-systemid"));
			});
			$box.on("click", ".kill-toast-desktop", function(e) {
				e.preventDefault();
				killReporting.requestDesktop();
				$box.find(".kill-toast-desktop").remove();
			});
		}
		const $toast = $(killReporting.toastHtml(kill, category, place));
		$toast.find(".kill-toast-ship").on("error", function() { $(this).remove(); });
		if (killReporting.current().desktop && typeof Notification !== "undefined" && Notification.permission === "default" &&
			!$box.find(".kill-toast-desktop").length) {
			$toast.find(".kill-toast-text").append("<br/><a href='#' class='kill-toast-desktop'>Also alert me when Tripwire is in the background</a>");
		}
		$box.append($toast);
		while ($box.children(".kill-toast").length > killReporting.MAX_TOASTS) {
			$box.children(".kill-toast").first().trigger("remove-toast").remove();
		}
		killReporting.armDismiss($toast);
	},

	report: function(kills) {
		const settings = killReporting.current();
		const result = killReporting.plan(kills, killReporting.chainSystemIDs(), settings.threshold);
		const now = Date.now();
		result.reports.forEach(function(r) {
			const place = killReporting.placeFor(r.kill.systemID);
			if (settings.popup) { killReporting.toast(r.kill, r.category, place); }
			if (settings.desktop) { killReporting.notify(r.kill, r.category, place); }
			killReporting.mark(killReporting.marks, Number(r.kill.systemID), r.category, now);
		});
		if (result.reports.length) { killReporting.applyMarks(); }
		if (settings.enabled) {
			result.sounds.forEach(function(c) { killReporting.enqueue(c, settings); });
		}
	},

	poll: function() {
		if (killReporting.inFlight) { return; }	// don't stack requests
		const settings = killReporting.current();
		killReporting.applyMarks();	// expire old marks
		if (!settings.enabled && !settings.popup && !settings.desktop && !settings.marker) {
			killReporting.cursor = null;	// start fresh (no replay) when switched back on
			return;
		}
		const systems = killReporting.chainSystemIDs().slice(0, killReporting.MAX_SYSTEMS);
		const since = killReporting.cursor;
		const data = {};
		if (since !== null && systems.length) {
			data.since = since;
			data.systems = systems.join(",");
		}
		killReporting.inFlight = true;
		$.ajax({ url: killReporting.URL, type: "GET", data: data, dataType: "JSON", cache: false, timeout: 10000 })
			.done(function(response) {
				if (!response) { return; }
				if (data.since !== undefined && Array.isArray(response.kills) && response.kills.length) {
					killReporting.report(response.kills);
				}
				const cursor = Number(response.cursor);
				if (isFinite(cursor)) { killReporting.cursor = cursor; }
			})
			.fail(function(xhr, status, error) {
				console.warn("Kill Reporting: " + killReporting.URL + " failed", status, error);
			})
			.always(function() { killReporting.inFlight = false; });
	},

	// ---- Settings dialog ----

	settingsHtml: function() {
		const esc = killReporting.escape;
		const rows = ["neutral", "gank", "kill", "loss"].map(function(c) {
			const options = killReporting.soundOptions(c).map(function(o) {
				return "<option value='" + esc(o.id) + "'>" + esc(o.label) + "</option>";
			}).join("");
			return "<tr data-category='" + c + "'>"
				+ "<th><span class='kill-reporting-dot kill-reporting-dot-" + c + "'></span>" + esc(killReporting.labels[c])
				+ "<div class='kill-reporting-desc' data-desc='" + esc(killReporting.descriptions[c]) + "'></div></th>"
				+ "<td><select class='kill-reporting-sound'>" + options + "</select></td>"
				+ "<td class='kill-reporting-volume'><input type='range' min='0' max='100' step='5' class='kill-reporting-vol' /> <span class='kill-reporting-vol-label'></span></td>"
				+ "<td><button type='button' class='kill-reporting-test' title='Test this sound'>&#9654;</button></td>"
				+ "</tr>";
		}).join("");
		// Settings > Kill Reporting: the rows of its options table, and the sounds table + note shown under it
		return {
			rows: "<tr><th>Kill sounds:</th><td><label><input type='checkbox' id='killReporting-enabled' /> Play kill sounds for kills in the chain</label></td></tr>"
				+ "<tr><th>Pop-ups:</th><td><label><input type='checkbox' id='killReporting-popup' /> Show a pop-up for each kill</label></td></tr>"
				+ "<tr><th>Desktop alerts:</th><td><label><input type='checkbox' id='killReporting-desktop' /> Show a desktop notification when Tripwire is in the background</label>"
				+ "<div class='kill-reporting-hint' id='killReporting-desktop-hint'></div></td></tr>"
				+ "<tr><th>Gank size:</th><td><label>Gank = more than <input type='number' id='killReporting-threshold' min='1' max='50' step='1' /> pilots</label></td></tr>",
			sounds: "<table class='kill-reporting-sounds' width='100%' cellpadding='1' cellspacing='0'>"
				+ "<tr><th>Event</th><th>Sound</th><th>Volume</th><th></th></tr>"
				+ rows
				+ "</table>"
				+ "<p class='kill-reporting-note'>Kills come from zKillboard and can arrive a minute or more after they happen.</p>"
		};
	},

	/** What the browser allows, under the Desktop alerts checkbox */
	updateDesktopHint: function() {
		const $hint = $("#killReporting-desktop-hint");
		if (!$hint.length) { return; }
		const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
		$hint.text({
			unsupported: "This browser can't show desktop notifications.",
			denied: "Blocked by the browser: allow notifications for this site in the browser's site settings.",
			granted: "",
			"default": $("#killReporting-desktop").prop("checked") ? "The browser asks for permission when you click Save." : ""
		}[permission] || "");
	},

	updateDescriptions: function() {
		const n = killReporting.clampInt($("#killReporting-threshold").val(), 1, 50, killReporting.defaults.threshold);
		$("#killReporting-section .kill-reporting-desc").each(function() {
			$(this).text(String($(this).attr("data-desc")).replace("{n}", n));
		});
	},

	/** Fill the form from stored settings */
	fillForm: function(settings) {
		$("#killReporting-enabled").prop("checked", settings.enabled);
		$("#killReporting-popup").prop("checked", settings.popup);
		$("#killReporting-desktop").prop("checked", settings.desktop);
		$("#killReporting-threshold").val(settings.threshold);
		killReporting.updateDesktopHint();
		killReporting.categories.forEach(function(c) {
			const $row = $("#killReporting-section tr[data-category='" + c + "']");
			$row.find(".kill-reporting-sound").val(settings.sounds[c].sound);
			$row.find(".kill-reporting-vol").val(settings.sounds[c].volume);
			$row.find(".kill-reporting-vol-label").text(settings.sounds[c].volume + "%");
		});
		killReporting.updateDescriptions();
	},

	/** Settings as currently entered in the form (validated) */
	readForm: function() {
		const raw = {
			enabled: $("#killReporting-enabled").prop("checked"),
			popup: $("#killReporting-popup").prop("checked"),
			desktop: $("#killReporting-desktop").prop("checked"),
			threshold: $("#killReporting-threshold").val(),
			sounds: {}
		};
		killReporting.categories.forEach(function(c) {
			const $row = $("#killReporting-section tr[data-category='" + c + "']");
			raw.sounds[c] = { sound: $row.find(".kill-reporting-sound").val(), volume: $row.find(".kill-reporting-vol").val() };
		});
		return killReporting.settings({ killReporting: raw });
	},

	setupSettings: function() {
		if ($("#killReporting-section").length) { return; }
		// Its own Settings section after Kills & Intel. Every open re-reads the stored settings, so Close discards
		// unsaved changes; Reset deletes the key (back to the defaults).
		const html = killReporting.settingsHtml();
		const $section = forkSettings.section("killReporting", "Kill Reporting", { after: "intel", id: "killReporting-section" });
		forkSettings.register({
			section: "killReporting", id: "killReporting", type: "custom", rows: html.rows, key: "killReporting",
			keywords: "sound volume pop-up gank",
			load: function() { killReporting.fillForm(killReporting.current()); },
			save: function(o) {
				o.killReporting = killReporting.readForm();
				if (o.killReporting.desktop) { killReporting.requestDesktop(); }	// Save is a click, so the browser may ask
			}
		});
		// Drawn on the map, so Map Markers. Registered after the row above: its Save runs later and keeps this value.
		forkSettings.register({
			section: "markers", order: 70, id: "killReporting-marker", type: "checkbox", key: "killReporting",
			label: "Kill markers:", text: "Mark a chain system with a pulsing ring for 10 minutes after a reported kill (Kill Reporting)",
			keywords: "kill reporting zkillboard",
			get: function(o) { return killReporting.settings(o).marker; },
			set: function(o, on) { o.killReporting = Object.assign({}, o.killReporting || {}, { marker: on }); }
		});
		if ($section) { $section.append(html.sounds); }
		$(document).on("change", "#killReporting-desktop", killReporting.updateDesktopHint);

		$(document).on("input change", "#killReporting-section .kill-reporting-vol", function() {
			$(this).siblings(".kill-reporting-vol-label").text($(this).val() + "%");
		});
		$(document).on("input change", "#killReporting-threshold", killReporting.updateDescriptions);
		$(document).on("click", "#killReporting-section .kill-reporting-test", function(e) {
			e.preventDefault();
			const $row = $(this).closest("tr");
			const category = $row.attr("data-category");
			const sound = $row.find(".kill-reporting-sound").val();
			const volume = $row.find(".kill-reporting-vol").val();
			if (typeof speechSynthesis !== "undefined") { speechSynthesis.cancel(); }
			if (killReporting.preview) { killReporting.preview.pause(); }
			killReporting.preview = null;
			const file = killReporting.fileFor(sound);
			if (file) {
				// Separate element so a test never cuts off a queued kill sound
				const a = new Audio(file);
				a.volume = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
				killReporting.preview = a;
				const p = a.play();
				if (p && typeof p.catch === "function") { p.catch(function(err) { console.warn("Kill Reporting: could not play " + file, err); }); }
			} else {
				killReporting.play(sound, volume, category);
			}
		});

		$(document).on("dialogclose", "#dialog-options", function() {
			if (killReporting.preview) { killReporting.preview.pause(); killReporting.preview = null; }
		});
	},

	init: function() {
		killReporting.setupSettings();
		// Preload the selected sounds so the first kill plays without a delay
		const settings = killReporting.current();
		killReporting.categories.forEach(function(c) {
			const id = settings.sounds[c].sound;
			if (id !== "speech" && id !== "none") { killReporting.audio(id); }
		});
		// Redraws replace the nodes: put the kill markers back
		if (typeof chain !== "undefined" && chain && typeof chain.draw === "function" && !chain.draw.killReportingWrapped) {
			const draw = chain.draw;
			chain.draw = function() {
				const result = draw.apply(this, arguments);
				try { killReporting.applyMarks(); } catch (e) { console.warn("Kill Reporting: could not mark the chain", e); }
				return result;
			};
			chain.draw.killReportingWrapped = true;
		}
		killReporting.poll();
		setInterval(killReporting.poll, killReporting.POLL_MS);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { killReporting.init(); });
}
