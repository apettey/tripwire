const forkNotifications = {
	// Fork-owned: one dock for every pop-up (jBox notices, kill, timer and Watchlist pop-ups, the jump panels), so they
	// stack instead of overlapping. Settings > General chooses its corner, how long pop-ups stay and whether they are
	// see-through; every pop-up can be closed, and Close all / Esc clear the lot.
	CORNERS: [["top-right", "Top right"], ["top-left", "Top left"], ["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"]],
	DEFAULT_CORNER: "top-right",
	SHORT_MS: 5000,		// "Close pop-ups sooner"
	RESUME_MS: 1500,	// the least time left after the mouse moves off a pop-up
	DOCK_ID: "fn-dock",
	ITEMS: ".jBox-Notice, .kill-toast, .watchlist-toast, #jump-return-panel, #jump-sig-panel",

	/** The corner to use (options.notifications.corner); missing or unknown = the default */
	corner: function(opts) {
		const c = opts && opts.notifications && opts.notifications.corner;
		return forkNotifications.CORNERS.some(function(x) { return x[0] === c; }) ? c : forkNotifications.DEFAULT_CORNER;
	},

	short: function(opts) { return !!(opts && opts.notifications && opts.notifications.short); },

	seeThrough: function(opts) { return !!(opts && opts.notifications && opts.notifications.seeThrough); },

	/** How long a pop-up stays, in ms; a pop-up with no time limit (false, 0) keeps none */
	duration: function(ms, opts) {
		if (typeof ms !== "number" || ms <= 0) { return null; }
		return forkNotifications.short(opts) ? Math.min(ms, forkNotifications.SHORT_MS) : ms;
	},

	/** jBox options for a notice: in the dock, with a close button; its timer is ours (it holds while hovered) */
	noticeOptions: function(given, dock) {
		return Object.assign({}, given, { appendTo: dock, closeButton: "box", autoClose: false });
	},

	/** Time left once the mouse moves off a pop-up */
	resumeMs: function(left) {
		return Math.max(left, forkNotifications.RESUME_MS);
	},

	opts: function() {
		return typeof options !== "undefined" ? options : null;
	},

	/** Where pop-ups go: the dock, created on first use */
	dock: function() {
		let $dock = $("#" + forkNotifications.DOCK_ID);
		if (!$dock.length) {
			$dock = $("<div aria-live='polite'></div>").attr("id", forkNotifications.DOCK_ID).appendTo("body");
			$("<button type='button' class='fn-close-all'></button>").appendTo($dock).on("click", function() {
				forkNotifications.closeAll();
				if (typeof forkUsage !== "undefined") { forkUsage.track("notifications", "closed_all"); }
			});
			new MutationObserver(forkNotifications.refresh).observe($dock[0], { childList: true, subtree: true });
			forkNotifications.applyLook($dock);
		}
		return $dock;
	},

	applyLook: function($dock) {
		const opts = forkNotifications.opts();
		$dock.removeClass(forkNotifications.CORNERS.map(function(c) { return "fn-" + c[0]; }).join(" "))
			.addClass("fn-" + forkNotifications.corner(opts))
			.toggleClass("fn-see-through", forkNotifications.seeThrough(opts));
		// Settings > UI Scale zooms the body, and the dock's height with it
		$dock[0].style.setProperty("--fn-zoom", parseFloat(document.body.style.zoom) || 1);
	},

	/** Show Close all from two pop-ups up (a pop-up on its way out no longer counts) */
	refresh: function() {
		const $dock = $("#" + forkNotifications.DOCK_ID);
		const count = $dock.find(forkNotifications.ITEMS).not(".fn-closing").length;
		const $button = $dock.children(".fn-close-all");
		const text = "Close all (" + count + ")";
		if ($button.text() !== text) { $button.text(text); }
		$button.toggleClass("fn-reserved", count > 0).toggleClass("fn-shown", count > 1);
	},

	/** Close one pop-up the way its own close button does, so its feature tidies up after itself */
	close: function($item) {
		const box = $item.data("jBox");
		if (box) {
			$item.addClass("fn-closing");
			box.close({ ignoreDelay: true });
		} else if ($item.is("#jump-return-panel")) {
			$item.find(".jump-return-close").trigger("click");
		} else if ($item.is("#jump-sig-panel")) {
			$item.find(".jump-sig-close").trigger("click");
		} else {
			$item.remove();
		}
	},

	closeAll: function() {
		$("#" + forkNotifications.DOCK_ID).find(forkNotifications.ITEMS).not(".fn-closing").each(function() {
			forkNotifications.close($(this));
		});
		forkNotifications.refresh();
	},

	/** Close $item after ms; the time stops while the mouse is on it */
	arm: function($item, ms) {
		let timer = null, left = ms, startedAt = 0;
		const start = function() {
			startedAt = Date.now();
			timer = setTimeout(function() { forkNotifications.close($item); }, left);
		};
		const stop = function() {
			clearTimeout(timer);
			left = forkNotifications.resumeMs(left - (Date.now() - startedAt));
		};
		$item.on("mouseenter.fnTimer", stop).on("mouseleave.fnTimer", start);
		start();
	},

	/** Route every jBox notice through the dock. Wrapped here so that upstream's Notify needs no edit. */
	wrapNotices: function() {
		const Original = window.jBox;
		if (!Original || Original.forkNotificationsWrapped) { return; }
		const Wrapped = function(type, given) {
			if (type !== "Notice") { return new Original(type, given); }
			const ms = forkNotifications.duration(given && given.autoClose !== undefined ? given.autoClose : 6000, forkNotifications.opts());
			const box = new Original(type, forkNotifications.noticeOptions(given, forkNotifications.dock()));
			if (ms && box.wrapper) { forkNotifications.arm(box.wrapper, ms); }
			return box;
		};
		Object.assign(Wrapped, Original);
		Wrapped.prototype = Original.prototype;
		Wrapped.forkNotificationsWrapped = true;
		window.jBox = Wrapped;
	},

	/** "Close pop-ups sooner" for the pop-ups that keep their own timers; jump panels ask a question, so they keep theirs */
	armToast: function(node) {
		if (node.nodeType !== 1 || !$(node).is(".kill-toast, .watchlist-toast")) { return; }
		if (forkNotifications.short(forkNotifications.opts())) { forkNotifications.arm($(node), forkNotifications.SHORT_MS); }
	},

	init: function() {
		const $dock = forkNotifications.dock();
		new MutationObserver(function(records) {
			records.forEach(function(r) { r.addedNodes.forEach(forkNotifications.armToast); });
		}).observe($dock[0], { childList: true, subtree: true });

		$(document).on("keydown.forkNotifications", function(e) {
			if (e.key !== "Escape" || e.isDefaultPrevented()) { return; }
			if ($(e.target).closest("input, textarea, select, [contenteditable='true'], .ui-dialog").length) { return; }
			if ($(".ui-widget-overlay:visible, #cp-overlay:not(.cp-hidden), #ph-menu:visible").length) { return; }
			if (typeof forkHintsUI !== "undefined" && forkHintsUI.tip) { return; }	// Esc closes the tip first
			if (!$("#" + forkNotifications.DOCK_ID).find(forkNotifications.ITEMS).not(".fn-closing").length) { return; }
			forkNotifications.closeAll();
			if (typeof forkUsage !== "undefined") { forkUsage.track("notifications", "closed_all"); }
		});

		forkSettings.register({
			section: "general", order: 40, id: "notifications-corner", type: "select", key: "notifications",
			label: "Pop-ups appear:", choices: forkNotifications.CORNERS, keywords: "notification notice toast corner position move",
			get: function(o) { return forkNotifications.corner(o); },
			set: function(o, v) { o.notifications = Object.assign({}, o.notifications, { corner: v }); }
		});
		forkSettings.register({
			section: "general", order: 41, id: "notifications-short", type: "checkbox", key: "notifications",
			label: "Pop-up time:", text: "Close pop-ups sooner (after 5 seconds; hovering holds them)",
			keywords: "notification notice toast close quick",
			get: function(o) { return forkNotifications.short(o); },
			set: function(o, on) { o.notifications = Object.assign({}, o.notifications, { short: on }); }
		});
		forkSettings.register({
			section: "general", order: 42, id: "notifications-seeThrough", type: "checkbox", key: "notifications",
			label: "See-through pop-ups:", text: "See what's underneath until you hover a pop-up",
			keywords: "notification notice toast transparent opacity",
			get: function(o) { return forkNotifications.seeThrough(o); },
			set: function(o, on) { o.notifications = Object.assign({}, o.notifications, { seeThrough: on }); }
		});

		// options.apply() runs on page load, Save and Reset
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.forkNotificationsWrapped) {
			const apply = options.apply;
			let shownCorner = forkNotifications.corner(options);
			options.apply = function() {
				const result = apply.apply(this, arguments);
				forkNotifications.applyLook(forkNotifications.dock());
				const corner = forkNotifications.corner(options);
				if (corner !== shownCorner) {
					shownCorner = corner;
					if (typeof forkUsage !== "undefined") { forkUsage.track("notifications", "moved"); }
					Notify.trigger("Pop-ups now appear here", "blue", 4000);
				}
				return result;
			};
			options.apply.forkNotificationsWrapped = true;
		}
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined") {
	forkNotifications.wrapNotices();
	jQuery(forkNotifications.init);
}
