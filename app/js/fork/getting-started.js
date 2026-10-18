const gettingStarted = {
	// Fork-owned: the Getting started card for new accounts (created less than 14 days ago, from fork_events.php mode=get's
	// accountAgeDays via forkUsage.serverInfo). A small non-modal card in the bottom left corner with 5 first steps that tick
	// themselves off from what the user really does; each has a "How" button that shows where. Never shown to older
	// accounts, nor when the server's answer fails. "–" folds it to one line ("Getting started 2/5", remembered), "Hide"
	// removes it for good. State: options.gettingStarted = {hidden, collapsed, done: [item ids]} (missing = shown, open).
	// No Settings toggle: the card has its own Hide and goes away by itself after 14 days.
	// While the card is up and Ctrl+K isn't ticked yet, the Ctrl+K tip is held back (forkHints.hold): the card teaches it.
	// Statistics: gettingStarted.shown (on screen, once a day, catalog `exposed`), .how (a How button: use), .done_<item>,
	// .all_done, .collapsed, .expanded, .hidden.
	// Keep `const gettingStarted` on the first line: the test helper strips it to define a global. Pure logic first.

	NEW_DAYS: 14,
	POLL_MS: 5000,
	ITEMS: [
		{ id: "mask", title: "Pick or create a mask", how: "Masks decide whose chain you see: yours, your corp's or a shared one." },
		{ id: "tab", title: "Add a chain tab for your home", how: "A tab keeps the chain from your home system one click away." },
		{ id: "paste", title: "Paste your signatures", how: "In EVE, select the probe scanner rows (Ctrl+A), copy them (Ctrl+C) and press Ctrl+V in Tripwire." },
		{ id: "tracking", title: "Track a character and turn on the auto-mapper", how: "Tripwire follows your jumps and maps the holes you take." },
		{ id: "palette", title: "Open the command palette with Ctrl+K", how: "Find any system, signature, setting or action from the keyboard." }
	],

	// ---- Pure logic (tested under mocha) ----

	/** options.gettingStarted, completed (not stored): {hidden, collapsed, done: []} */
	stateOf: function(opts) {
		const g = opts && opts.gettingStarted && typeof opts.gettingStarted === "object" ? opts.gettingStarted : {};
		return { hidden: g.hidden === true, collapsed: g.collapsed === true, done: Array.isArray(g.done) ? g.done.filter(function(d) { return typeof d === "string"; }) : [] };
	},

	/** Show the card: a new account (age known, under NEW_DAYS) that hasn't hidden it */
	shouldShow: function(opts, accountAgeDays) {
		const age = typeof accountAgeDays === "number" && isFinite(accountAgeDays) ? accountAgeDays : null;
		return age !== null && age >= 0 && age < gettingStarted.NEW_DAYS && !gettingStarted.stateOf(opts).hidden;
	},

	/**
	 * Which items are done now, from the page's state: {mask, tab, paste, tracking, palette} booleans.
	 * s: {done: [ids already ticked: they stay ticked], activeMask, defaultMask, masks: [the user's mask ids], tabs: options.chain.tabs, trackedCount,
	 *     autoMapper, paletteUsed}
	 */
	detect: function(s) {
		const had = function(id) { return (s.done || []).indexOf(id) >= 0; };
		const tabs = Array.isArray(s.tabs) ? s.tabs : [];
		return {
			// Another of the user's masks than the corp mask every account starts on (or the user saved a choice in Masks).
			// Only a mask in the list counts: a new account's options can say "undefined.2" before anything is saved.
			mask: had("mask") || (!!s.activeMask && !!s.defaultMask && String(s.activeMask) !== String(s.defaultMask)
				&& (s.masks || []).indexOf(String(s.activeMask)) >= 0),
			// A tab with a home system ("0" / empty is a tab of the whole chain)
			tab: had("tab") || tabs.some(function(t) { return !!t && !!t.systemID && String(t.systemID) !== "0"; }),
			paste: had("paste"),
			tracking: had("tracking") || ((s.trackedCount || 0) > 0 && s.autoMapper === true),
			palette: had("palette") || s.paletteUsed === true
		};
	},

	/** The corp mask every account starts on ("<corporationID>.2", login.php), from the page's init.masks; null if unknown */
	corpMask: function(masks) {
		const m = (Array.isArray(masks) ? masks : []).filter(function(x) { return x && x.type === "default" && x.ownerType === "corporate" && /\.2$/.test(String(x.mask)); })[0];
		return m ? String(m.mask) : null;
	},

	/** Item ids done in `now` that `before` didn't have, in item order */
	newlyDone: function(before, now) {
		return gettingStarted.ITEMS.map(function(i) { return i.id; }).filter(function(id) { return now[id] && (before || []).indexOf(id) < 0; });
	},

	count: function(done) {
		return gettingStarted.ITEMS.filter(function(i) { return (done || []).indexOf(i.id) >= 0; }).length;
	},

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** The card's markup for the state {collapsed, done} */
	html: function(st) {
		const esc = gettingStarted.escape;
		const n = gettingStarted.count(st.done), total = gettingStarted.ITEMS.length;
		const head = "<div class='gs-head'>"
			+ "<button type='button' class='gs-toggle' aria-expanded='" + (st.collapsed ? "false" : "true") + "' title='" + (st.collapsed ? "Show the steps" : "Fold away") + "'>"
			+ "<span class='gs-title'>Getting started</span> <span class='gs-count'>" + n + "/" + total + "</span>"
			+ "<span class='gs-fold' aria-hidden='true'>" + (st.collapsed ? "&#9650;" : "&#8211;") + "</span></button>"
			+ "<button type='button' class='gs-hide' title='Hide Getting started for good'>Hide</button></div>";
		if (st.collapsed) { return head; }
		const rows = gettingStarted.ITEMS.map(function(item) {
			const done = st.done.indexOf(item.id) >= 0;
			return "<li class='gs-item" + (done ? " gs-done" : "") + "' data-item='" + esc(item.id) + "'>"
				+ "<span class='gs-check' aria-hidden='true'>" + (done ? "&#10003;" : "") + "</span>"
				+ "<span class='gs-text' title='" + esc(item.how) + "'>" + esc(item.title) + (done ? "<span class='gs-sr'> (done)</span>" : "") + "</span>"
				+ (done ? "" : "<button type='button' class='gs-how' data-item='" + esc(item.id) + "'>How</button>")
				+ "</li>";
		}).join("");
		const foot = n === total ? "<div class='gs-foot'>All set. Hide this card whenever you like.</div>" : "";
		return head + "<ul class='gs-list'>" + rows + "</ul>" + foot;
	},

	// ---- State ----

	shown: false,
	pollTimer: null,

	opts: function() {
		return typeof options !== "undefined" && options ? options : null;
	},

	/** Store state changes in options.gettingStarted and save */
	store: function(patch) {
		const opts = gettingStarted.opts();
		if (!opts) { return; }
		opts.gettingStarted = Object.assign(gettingStarted.stateOf(opts), patch);
		if (typeof opts.save === "function") { opts.save(); }
	},

	track: function(action) {
		if (typeof forkUsage !== "undefined") { forkUsage.track("gettingStarted", action); }
	},

	// ---- Browser-only code below (not run under mocha) ----

	pageState: function() {
		const opts = gettingStarted.opts() || {};
		const st = gettingStarted.stateOf(opts);
		let tracked = 0;
		try { tracked = typeof tripwire !== "undefined" && tripwire.esi && tripwire.esi.characters ? Object.keys(tripwire.esi.characters).length : 0; } catch (e) { tracked = 0; }
		return {
			done: st.done,
			activeMask: opts.masks && opts.masks.active,
			defaultMask: gettingStarted.corpMask(typeof init !== "undefined" && init ? init.masks : null),
			masks: (typeof init !== "undefined" && init && Array.isArray(init.masks) ? init.masks : []).map(function(m) { return m && String(m.mask); }),
			tabs: opts.chain && opts.chain.tabs,
			trackedCount: tracked,
			autoMapper: !!(opts.buttons && opts.buttons.signaturesWidget && opts.buttons.signaturesWidget.autoMapper),
			paletteUsed: typeof forkUsage !== "undefined" && forkUsage.used("commandPalette")
		};
	},

	/** Tick what the user did (extra: an item id seen happening, e.g. a paste); re-render when something changed */
	update: function(extra) {
		if (!gettingStarted.shown) { return; }
		const opts = gettingStarted.opts();
		if (!opts) { return; }
		const st = gettingStarted.stateOf(opts);
		const now = gettingStarted.detect(gettingStarted.pageState());
		if (extra) { now[extra] = true; }
		const fresh = gettingStarted.newlyDone(st.done, now);
		if (fresh.length) {
			const done = st.done.concat(fresh);
			gettingStarted.store({ done: done });
			fresh.forEach(function(id) { gettingStarted.track("done_" + id); });
			if (gettingStarted.count(done) === gettingStarted.ITEMS.length) { gettingStarted.track("all_done"); }
		}
		gettingStarted.holdTips();
		if (fresh.length) { gettingStarted.render(); }
	},

	/** Hold the Ctrl+K tip back while the card shows that step (it teaches the same thing) */
	holdTips: function() {
		if (typeof forkHints === "undefined" || typeof forkHints.hold !== "function") { return; }
		const st = gettingStarted.stateOf(gettingStarted.opts());
		const teaching = gettingStarted.shown && st.done.indexOf("palette") < 0;
		forkHints.hold("commandPalette", teaching ? "Getting started" : "");
	},

	render: function() {
		let el = document.getElementById("gettingStarted");
		if (!gettingStarted.shown) { if (el) { el.parentNode.removeChild(el); } return; }
		if (!el) {
			el = document.createElement("div");
			el.id = "gettingStarted";
			el.setAttribute("role", "region");
			el.setAttribute("aria-label", "Getting started");
			document.body.appendChild(el);
		}
		const st = gettingStarted.stateOf(gettingStarted.opts());
		el.className = st.collapsed ? "gs-collapsed" : "";
		el.innerHTML = gettingStarted.html(st);
	},

	show: function() {
		gettingStarted.shown = true;
		gettingStarted.render();
		gettingStarted.update();
		gettingStarted.holdTips();
		clearInterval(gettingStarted.pollTimer);
		gettingStarted.pollTimer = setInterval(function() {
			if (document.visibilityState !== "hidden") { gettingStarted.update(); }
		}, gettingStarted.POLL_MS);
	},

	hide: function() {
		gettingStarted.shown = false;
		clearInterval(gettingStarted.pollTimer);
		gettingStarted.render();
		gettingStarted.holdTips();
	},

	flash: function(selector) {
		const $el = $(selector).filter(":visible").first();
		if (!$el.length) { return false; }
		if ($el[0].scrollIntoView) { $el[0].scrollIntoView({ block: "nearest" }); }
		$el.addClass("ffa-flash");
		setTimeout(function() { $el.removeClass("ffa-flash"); }, 1500);
		return true;
	},

	notify: function(text) {
		if (typeof Notify !== "undefined") { Notify.trigger(gettingStarted.escape(text), "green"); }
	},

	/** "How" of an item: open the place where it is done */
	how: function(id) {
		if (typeof forkUsage !== "undefined") { forkUsage.track("gettingStarted", "how"); }
		const item = gettingStarted.ITEMS.filter(function(i) { return i.id === id; })[0];
		if (id === "mask") {
			$("#mask-link").trigger("click");
		} else if (id === "tab") {
			$("#newTab").trigger("click");
			gettingStarted.notify("Give the tab a name and your home system, then press OK." + item.how);
		} else if (id === "paste") {
			gettingStarted.flash("#signaturesWidget");
			gettingStarted.notify(item.how);
		} else if (id === "tracking") {
			const s = gettingStarted.pageState();
			if (s.trackedCount > 0) {
				gettingStarted.flash("#toggle-automapper");
				gettingStarted.notify("Turn on the auto-mapper: the flashing button in the Signatures panel. " + item.how);
			} else {
				// A native click: upstream's panel handlers read the event's originalEvent
				const user = document.getElementById("user");
				if (user && !$("#login > #panel").is(":visible")) { user.click(); }
				gettingStarted.notify("Press Add to log in a character with EVE, then turn on the auto-mapper in the Signatures panel. " + item.how);
			}
		} else if (id === "palette") {
			const did = typeof forkFeatureActions !== "undefined" ? forkFeatureActions.tryIt("commandPalette") : null;
			if (!did) { gettingStarted.notify("Press Ctrl+K (Cmd+K on Mac) anywhere outside a text box. " + item.how); }
		}
	},

	installHooks: function() {
		$(document).on("click", "#gettingStarted .gs-toggle", function(e) {
			e.preventDefault();
			const collapsed = !gettingStarted.stateOf(gettingStarted.opts()).collapsed;
			gettingStarted.store({ collapsed: collapsed });
			gettingStarted.track(collapsed ? "collapsed" : "expanded");
			gettingStarted.render();
			const t = document.querySelector("#gettingStarted .gs-toggle");
			if (t) { t.focus(); }
		});
		$(document).on("click", "#gettingStarted .gs-hide", function(e) {
			e.preventDefault();
			gettingStarted.store({ hidden: true });
			gettingStarted.track("hidden");
			gettingStarted.hide();
		});
		$(document).on("click", "#gettingStarted .gs-how", function(e) {
			e.preventDefault();
			gettingStarted.how($(this).attr("data-item"));
		});
		// A paste of probe scanner rows (feature tips' paste.sigs event)
		if (typeof forkHints !== "undefined" && typeof forkHints.listen === "function") {
			forkHints.listen(function(event, data) {
				if (event === "paste.sigs" && data && data.rows > 0) { gettingStarted.update("paste"); }
			});
		}
		// The palette, at once (not only on the next poll)
		if (typeof forkUsage !== "undefined") {
			forkUsage.on(function(feature) { if (feature === "commandPalette") { setTimeout(gettingStarted.update, 0); } });
		}
		// A mask chosen in Masks (Save) or from the palette, even the one it already was
		if (typeof maskFunctions !== "undefined" && typeof maskFunctions.updateActiveMask === "function" && !maskFunctions.updateActiveMask.gettingStartedWrapped) {
			const orig = maskFunctions.updateActiveMask;
			const wrapped = function() {
				const result = orig.apply(this, arguments);
				try { gettingStarted.update("mask"); } catch (e) { console.error("gettingStarted: mask", e); }
				return result;
			};
			wrapped.gettingStartedWrapped = true;
			maskFunctions.updateActiveMask = wrapped;
		}
	},

	init: function() {
		const opts = gettingStarted.opts();
		if (!opts || gettingStarted.stateOf(opts).hidden) { return; }
		if (typeof forkUsage === "undefined" || !forkUsage.serverInfo) { return; }
		forkUsage.serverInfo.then(function(data) {
			if (!gettingStarted.shouldShow(gettingStarted.opts(), data ? data.accountAgeDays : null)) { return; }
			gettingStarted.installHooks();
			gettingStarted.show();
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	// After forkUsage.init (feature-usage.js sorts after this file): it makes forkUsage.serverInfo
	jQuery(function() { setTimeout(gettingStarted.init, 0); });
}
