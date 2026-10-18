const forkHintsUI = {
	// Fork-owned: what a feature tip looks like (the rules of when are in hints.js, styles in app/css/fork/hints.css).
	// One pop-up tip at a time: a callout pointing at its anchor (follows it, goes when it goes) or a toast in the bottom left
	// corner; plus up to 3 beacons (a dot that pulses a few times; a click opens its callout). Non-modal: it never takes the
	// focus, Esc closes it, screen readers hear it through a polite live region, it hides itself after 20 s untouched
	// ("ignored") and gives way to the app's own pop-ups. Keep `const forkHintsUI` on the first line (test helper).

	AUTO_HIDE_MS: 20000,
	TICK_MS: 200,
	MARGIN: 8,			// from the window edge
	GAP: 10,			// between the anchor and the callout (room for the arrow)
	ARROW_PAD: 14,		// the arrow stays this far from the callout's corners
	// The app's own pop-ups: a tip waits while one is open and steps aside when one appears
	POPUPS: ["#jump-return-panel", "#jump-sig-panel", "#autoMass-prompt", "#kill-reporting-toasts .kill-toast", "#cp-overlay:not(.cp-hidden)"],

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	// ---- Pure logic (tested under mocha) ----

	/** Where a box goes next to an anchor: {left, top, placement, arrow} in viewport pixels. Takes the preferred side when
	 *  the box fits there, else the opposite side, else whichever side has the most room; then keeps it on screen. arrow:
	 *  offset of the arrow along the callout's edge, pointing at the anchor's centre. */
	place: function(a, box, view, placement) {
		const m = forkHintsUI.MARGIN, g = forkHintsUI.GAP;
		const room = {
			top: a.top - g - m,
			bottom: view.height - (a.top + a.height) - g - m,
			left: a.left - g - m,
			right: view.width - (a.left + a.width) - g - m
		};
		const need = function(side) { return side === "top" || side === "bottom" ? box.height : box.width; };
		const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" };
		let side = placement in room ? placement : "bottom";
		if (room[side] < need(side)) {
			if (room[opposite[side]] >= need(opposite[side])) { side = opposite[side]; }
			else { side = Object.keys(room).sort(function(x, y) { return (room[y] - need(y)) - (room[x] - need(x)); })[0]; }
		}
		let left, top;
		if (side === "top" || side === "bottom") {
			left = a.left + a.width / 2 - box.width / 2;
			top = side === "top" ? a.top - g - box.height : a.top + a.height + g;
		} else {
			top = a.top + a.height / 2 - box.height / 2;
			left = side === "left" ? a.left - g - box.width : a.left + a.width + g;
		}
		const clamp = function(v, lo, hi) { return Math.max(lo, Math.min(v, Math.max(lo, hi))); };
		left = clamp(left, m, view.width - m - box.width);
		top = clamp(top, m, view.height - m - box.height);
		const p = forkHintsUI.ARROW_PAD;
		const arrow = side === "top" || side === "bottom"
			? clamp(a.left + a.width / 2 - left, p, box.width - p)
			: clamp(a.top + a.height / 2 - top, p, box.height - p);
		return { left: Math.round(left), top: Math.round(top), placement: side, arrow: Math.round(arrow) };
	},

	/** A rectangle has a size and overlaps the viewport (and the clip rectangle, when given) */
	onScreen: function(r, view, clip) {
		if (!r || r.width <= 0 || r.height <= 0) { return false; }
		const overlaps = function(b) { return r.left < b.left + b.width && r.left + r.width > b.left && r.top < b.top + b.height && r.top + r.height > b.top; };
		return overlaps({ left: 0, top: 0, width: view.width, height: view.height }) && (!clip || overlaps(clip));
	},

	/** Markup of a callout or toast. view: {title, body, actionLabel}; plain text, escaped here */
	html: function(view, kind) {
		const esc = forkHintsUI.escape;
		const paragraphs = String(view.body || "").split(/\n\s*\n/).filter(function(p) { return p.trim(); });
		return "<div class='fh-tip fh-" + (kind === "toast" ? "toast" : "callout") + "' role='note' aria-label='Tip'>"
			+ (kind === "toast" ? "" : "<div class='fh-arrow' aria-hidden='true'></div>")
			+ "<button type='button' class='fh-close' aria-label='Close tip' title='Close'>&times;</button>"
			+ "<div class='fh-title'>" + esc(view.title) + "</div>"
			+ paragraphs.map(function(p) { return "<p class='fh-body'>" + esc(p.trim()) + "</p>"; }).join("")
			+ "<div class='fh-buttons'>"
			+ (view.actionLabel ? "<button type='button' class='fh-act'>" + esc(view.actionLabel) + "</button>" : "")
			+ "<button type='button' class='fh-ok'>Got it</button>"
			+ "<a href='#' class='fh-off'>Don't show tips like this</a>"
			+ "</div></div>";
	},

	// ---- DOM (browser only) ----

	tip: null,				// {hint, data, kind, $el, anchor: element|null, remaining, hovered, lastTick}
	beacons: [],			// [{hint, data, view, $el, anchor}]
	timer: null,
	bound: false,

	viewport: function() {
		return { width: window.innerWidth || document.documentElement.clientWidth, height: window.innerHeight || document.documentElement.clientHeight };
	},

	/** Nearest ancestor that clips its content (a scrolling table wrapper), as a rectangle; null for none */
	clipOf: function(el) {
		let p = el.parentElement;
		for (let i = 0; p && i < 12; i++, p = p.parentElement) {
			const s = getComputedStyle(p);
			if (/(auto|scroll|hidden)/.test(s.overflow + s.overflowY + s.overflowX)) { return p.getBoundingClientRect(); }
		}
		return null;
	},

	visible: function(el) {
		if (!el || !el.isConnected || !el.getClientRects().length) { return false; }
		const s = getComputedStyle(el);
		if (s.visibility === "hidden" || s.display === "none") { return false; }
		return forkHintsUI.onScreen(el.getBoundingClientRect(), forkHintsUI.viewport(), forkHintsUI.clipOf(el));
	},

	/** The tip's anchor element when it is on screen, else null. A toast needs none (returns body). */
	anchorFor: function(hint, ctx, data) {
		let el = null;
		try {
			el = typeof hint.anchor === "function" ? hint.anchor(ctx, data) : (hint.anchor ? document.querySelector(hint.anchor) : null);
		} catch (e) { el = null; }
		if (el && el.jquery) { el = el[0] || null; }
		if (hint.kind === "toast") { return el && forkHintsUI.visible(el) ? el : document.body; }
		return forkHintsUI.visible(el) ? el : null;
	},

	popupOpen: function() {
		return forkHintsUI.POPUPS.some(function(sel) { return $(sel).filter(":visible").length > 0; });
	},

	dialogOpen: function() {
		return $(".ui-dialog:visible").not(".dialog-floating").length > 0;
	},

	/** What hints.js' quietReason needs */
	quietSignals: function(now) {
		const a = document.activeElement;
		const s = forkHints.signals;
		let fight = false;
		try { fight = typeof rally !== "undefined" && rally.state && rally.isRealSystemID(rally.state.systemID); } catch (e) { fight = false; }
		return {
			now: now,
			visible: document.visibilityState !== "hidden",
			focused: typeof document.hasFocus === "function" ? document.hasFocus() : true,
			lastInput: s.lastInput,
			lastKill: s.lastKill,
			lastPaste: s.lastPaste,
			dialogOpen: forkHintsUI.dialogOpen(),
			inputFocused: !!(a && a !== document.body && a.id !== "clipboard" && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))),
			dragging: s.dragging,
			popupOpen: forkHintsUI.popupOpen(),
			fightHere: fight
		};
	},

	busy: function() {
		return !!forkHintsUI.tip;
	},

	beaconCount: function() {
		return forkHintsUI.beacons.length;
	},

	announce: function(view) {
		let live = document.getElementById("fh-live");
		if (!live) {
			live = document.createElement("div");
			live.id = "fh-live";
			live.className = "fh-sr";
			live.setAttribute("aria-live", "polite");
			document.body.appendChild(live);
		}
		live.textContent = "";
		setTimeout(function() { live.textContent = "Tip: " + view.title + ". " + view.body; }, 50);
	},

	/** Put a tip on screen: a beacon, or a callout / toast. Returns whether it is shown. */
	render: function(hint, view, data, ctx) {
		forkHintsUI.bind();
		const anchor = forkHintsUI.anchorFor(hint, ctx, data);
		if (!anchor) { return false; }
		if (hint.kind === "beacon") {
			const $b = $("<button type='button' class='fh-beacon' aria-label='Tip: " + forkHintsUI.escape(view.title) + "'><span></span></button>")
				.attr("title", view.title).appendTo("body");
			const beacon = { hint: hint, data: data, view: view, $el: $b, anchor: anchor };
			$b.on("click", function(e) {
				e.preventDefault();
				e.stopPropagation();
				forkHintsUI.removeBeacons(function(h) { return h.id === hint.id; });
				if (forkHintsUI.tip) { forkHintsUI.hide("closed"); }
				forkHintsUI.open(hint, view, data, beacon.anchor, "callout");
			});
			forkHintsUI.beacons.push(beacon);
			forkHintsUI.position();
			forkHintsUI.start();
			return true;
		}
		forkHintsUI.open(hint, view, data, hint.kind === "toast" ? null : anchor, hint.kind);
		return true;
	},

	/** The callout or toast element and its buttons */
	open: function(hint, view, data, anchor, kind) {
		const $el = $(forkHintsUI.html(view, kind)).appendTo("body");
		const tip = { hint: hint, data: data, kind: kind, $el: $el, anchor: anchor, remaining: forkHintsUI.AUTO_HIDE_MS, hovered: false, lastTick: Date.now() };
		forkHintsUI.tip = tip;
		$el.on("mouseenter focusin", function() { tip.hovered = true; }).on("mouseleave focusout", function() { tip.hovered = false; });
		$el.on("click", ".fh-close", function(e) { e.preventDefault(); forkHintsUI.hide("closed"); });
		$el.on("click", ".fh-ok", function(e) { e.preventDefault(); forkHintsUI.hide("got_it"); });
		$el.on("click", ".fh-act", function(e) { e.preventDefault(); forkHintsUI.hide("acted"); });
		$el.on("click", ".fh-off", function(e) { e.preventDefault(); forkHintsUI.hide("section_off"); });
		$el.on("mousedown pointerdown click", function(e) { e.stopPropagation(); });	// upstream's document click handlers (unselect sigs)
		forkHintsUI.announce(view);
		forkHintsUI.position();
		forkHintsUI.start();
	},

	/** Take the callout / toast away; outcome (acted, got_it, closed, ignored, section_off) goes to hints.js, null = none */
	hide: function(outcome) {
		const tip = forkHintsUI.tip;
		if (!tip) { return; }
		forkHintsUI.tip = null;
		tip.$el.remove();
		if (outcome && typeof forkHints !== "undefined") { forkHints.outcome(tip.hint.id, outcome, tip.data); }
		else if (typeof forkHints !== "undefined" && forkHints.current && forkHints.current.hint.id === tip.hint.id) { forkHints.current = null; }
	},

	removeBeacons: function(pred) {
		forkHintsUI.beacons = forkHintsUI.beacons.filter(function(b) {
			if (!pred(b.hint)) { return true; }
			b.$el.remove();
			return false;
		});
	},

	position: function() {
		const view = forkHintsUI.viewport();
		const tip = forkHintsUI.tip;
		if (tip && tip.kind !== "toast" && tip.anchor) {
			const el = tip.$el[0];
			const r = tip.anchor.getBoundingClientRect();
			const p = forkHintsUI.place(r, { width: el.offsetWidth, height: el.offsetHeight }, view, tip.hint.placement);
			el.style.left = p.left + "px";
			el.style.top = p.top + "px";
			el.className = el.className.replace(/\bfh-place-\w+/g, "").trim() + " fh-place-" + p.placement;
			const arrow = el.querySelector(".fh-arrow");
			if (arrow) {
				const horizontal = p.placement === "top" || p.placement === "bottom";
				arrow.style.left = horizontal ? p.arrow + "px" : "";
				arrow.style.top = horizontal ? "" : p.arrow + "px";
			}
		}
		forkHintsUI.beacons.forEach(function(b) {
			const r = b.anchor.getBoundingClientRect();
			b.$el.css({ left: Math.round(r.left + r.width - 6) + "px", top: Math.round(r.top - 6) + "px" });
		});
	},

	start: function() {
		if (!forkHintsUI.timer) { forkHintsUI.timer = setInterval(forkHintsUI.tick, forkHintsUI.TICK_MS); }
	},

	/** Follow the anchors; go when the anchor goes or another pop-up / dialog appears; count down while untouched */
	tick: function() {
		const now = Date.now();
		forkHintsUI.removeBeacons(function(h) {
			const b = forkHintsUI.beacons.filter(function(x) { return x.hint === h; })[0];
			return !b || !forkHintsUI.visible(b.anchor);
		});
		const tip = forkHintsUI.tip;
		if (tip) {
			if (tip.anchor && !forkHintsUI.visible(tip.anchor)) { forkHintsUI.hide("ignored"); }
			else if (forkHintsUI.popupOpen() || forkHintsUI.dialogOpen()) { forkHintsUI.hide("ignored"); }
			else {
				if (document.visibilityState !== "hidden" && !tip.hovered) { tip.remaining -= now - tip.lastTick; }
				tip.lastTick = now;
				if (tip.remaining <= 0) { forkHintsUI.hide("ignored"); }
			}
		}
		if (!forkHintsUI.tip && !forkHintsUI.beacons.length) {
			clearInterval(forkHintsUI.timer);
			forkHintsUI.timer = null;
			return;
		}
		forkHintsUI.position();
	},

	bind: function() {
		if (forkHintsUI.bound) { return; }
		forkHintsUI.bound = true;
		document.addEventListener("keydown", function(e) {
			if (e.key !== "Escape" || !forkHintsUI.tip || e.defaultPrevented) { return; }
			if (forkHintsUI.dialogOpen() || $("#cp-overlay:not(.cp-hidden)").length) { return; }	// Esc is theirs
			forkHintsUI.hide("closed");
		});
		window.addEventListener("resize", function() { if (forkHintsUI.tip || forkHintsUI.beacons.length) { forkHintsUI.position(); } });
	}
};
