const forkSettings = {
	// Fork-owned: the Settings dialog's sections and the one way fork features add a setting to it.
	// A feature calls forkSettings.register({...}) from its own file; this file builds the row, fills it when
	// Settings opens, writes it on Save (before upstream's Save handler applies and persists the options) and
	// undoes it on Settings > Reset. Which section a setting belongs in: AGENTS.md, section 2.

	// Display order of the built-in sections. `upstream` sections already exist in tripwire.php (found by an
	// element inside them); the others are created when their first row arrives, so none is ever empty.
	SECTIONS: [
		{ key: "account", upstream: "#usernameChange" },
		{ key: "chain", title: "Chain Map", upstream: "#renderer" },
		{ key: "markers", title: "Map Markers" },
		{ key: "jumps", title: "Wormhole Jumps & Mass" },
		{ key: "signatures", title: "Signatures" },
		{ key: "routes", title: "Routes & Navigation" },
		{ key: "intel", title: "Kills & Intel" },
		{ key: "general", title: "General", upstream: "#background-image" },
		{ key: "stats", upstream: "#signatures_added" }
	],

	// Upstream rows shown in a fork section. Moved as DOM nodes: upstream reads and writes them by id, so its
	// Save and open handlers keep working.
	UPSTREAM_ROWS: [
		{ selector: "#chainRoutingLimit", section: "routes", order: 10 },
		{ selector: "#chainRouteSecurity", section: "routes", order: 20 },
		{ selector: "#editType", section: "signatures", order: 10 },
		{ selector: "#pasteLife", section: "signatures", order: 20 },
		{ selector: "#copySeparator", section: "signatures", order: 30 }
	],

	TYPES: ["checkbox", "select", "custom"],
	FOOTNOTE_ORDER: 1e9,	// an upstream section's footnote row sorts after every registered row

	extraSections: [],	// [{key, title, after, id, tableClass}] from forkSettings.section()
	items: [],			// registered settings, in registration order
	seq: 0,

	escape: function(s) {
		return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function(c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
		});
	},

	/** Definition of a section by key (built-in or added by a feature), or null */
	sectionDef: function(key) {
		return forkSettings.SECTIONS.concat(forkSettings.extraSections).filter(function(s) { return s.key === key; })[0] || null;
	},

	/** Every section key in display order. A feature's section goes right after its `after` section (after
	 *  earlier sections placed there too); without a known `after` it goes just before General. */
	order: function() {
		const keys = forkSettings.SECTIONS.map(function(s) { return s.key; });
		const placed = {};
		forkSettings.extraSections.forEach(function(s) {
			let i = s.after ? keys.indexOf(s.after) : -1;
			if (i < 0) {
				i = keys.indexOf("general") - 1;
				if (i < -1) { i = keys.length - 1; }
			}
			while (i + 1 < keys.length && placed[keys[i + 1]] === (s.after || null)) { i++; }
			keys.splice(i + 1, 0, s.key);
			placed[s.key] = s.after || null;
		});
		return keys;
	},

	/**
	 * Add a section (once) for a feature with its own cluster of settings (3 or more) that fits no existing
	 * section. opts: {after: <section key>, id: <id of its content div>, tableClass: <extra class on its table>}.
	 * Returns the section's content div (jQuery) once the page is ready, else null.
	 */
	section: function(key, title, opts) {
		opts = opts || {};
		if (!key || !title) { throw new Error("forkSettings.section: key and title are required"); }
		if (!forkSettings.sectionDef(key)) {
			forkSettings.extraSections.push({ key: key, title: title, after: opts.after || null, id: opts.id || null, tableClass: opts.tableClass || "" });
		}
		return forkSettings.hasDOM() ? forkSettings.ensureSection(key) : null;
	},

	/** Check and complete a setting's definition; throws on a mistake so it shows up in development */
	normalize: function(def) {
		if (!def || typeof def !== "object") { throw new Error("forkSettings.register: definition object required"); }
		const name = "forkSettings.register(" + (def.id || "?") + "): ";
		if (!def.section || !def.id) { throw new Error(name + "section and id are required"); }
		if (forkSettings.TYPES.indexOf(def.type) < 0) { throw new Error(name + "type must be checkbox, select or custom"); }
		if (def.type !== "custom" && (typeof def.get !== "function" || typeof def.set !== "function")) {
			throw new Error(name + "get(options) and set(options, value) are required");
		}
		if (def.type === "select" && !Array.isArray(def.choices)) { throw new Error(name + "choices [[value, text], ...] are required"); }
		if (def.type === "custom" && !def.html && !def.rows) { throw new Error(name + "html (cell) or rows (<tr>s) is required"); }
		if (def.reset !== undefined && typeof def.reset !== "function") { throw new Error(name + "reset must be a function"); }
		// A row that stores something but has neither would keep its value through Settings > Reset
		// (a button-only custom row, without save, stores nothing)
		const stores = def.type !== "custom" || typeof def.save === "function";
		if (stores && !def.key && typeof def.reset !== "function") {
			console.warn(name + "no key or reset(options): Settings > Reset won't restore its default");
		}
		const item = Object.assign({}, def);
		item.order = typeof def.order === "number" ? def.order : 1000;
		item.seq = forkSettings.seq++;
		item.rendered = false;
		return item;
	},

	/**
	 * Register a setting. def:
	 *   section   section key (see SECTIONS / forkSettings.section)
	 *   id        id of the checkbox/select (type checkbox/select), or of the setting (custom)
	 *   type      "checkbox" | "select" | "custom"
	 *   label     row heading (plain text, e.g. "Hole size tags:"); text: the checkbox's text (plain text)
	 *   choices   select only: [[value, text], ...]
	 *   hint      optional small plain-text note under the control
	 *   get(options) -> value; set(options, value)   checkbox/select: read/write options.<feature>
	 *   html      custom: markup of the value cell; or rows: markup of whole <tr>s (several rows)
	 *   load(options), save(options)   custom: fill the controls on open / write options on Save
	 *   key       options key the setting lives in; Settings > Reset deletes it (a missing key = the default)
	 *   reset(options)   optional, instead of deleting `key` (e.g. to reset state of its own too)
	 *   order     position within the section (lower first; upstream rows of a section come first)
	 *   keywords  optional extra words the Settings filter matches
	 */
	register: function(def) {
		const item = forkSettings.normalize(def);
		const existing = forkSettings.items.filter(function(i) { return i.id === item.id; })[0];
		if (existing) {
			console.warn("forkSettings.register(" + item.id + "): already registered, ignored");
			return existing;
		}
		forkSettings.items.push(item);
		forkSettings.ready(function() { forkSettings.render(item); });
		return item;
	},

	/** Items in a section, sorted by order then registration */
	sorted: function(items) {
		return items.slice().sort(function(a, b) { return a.order - b.order || a.seq - b.seq; });
	},

	/** Run a feature's hook without letting one broken feature stop the others (or upstream's Save) */
	call: function(item, hook, args) {
		try { return item[hook].apply(item, args); }
		catch (e) { console.error("Settings: " + item.id + "." + hook + " failed", e); }
	},

	/** Fill the controls from options. io = {present(item), read(item), write(item, value)} */
	fillAll: function(opts, io) {
		forkSettings.items.forEach(function(item) {
			if (!io.present(item)) { return; }
			if (item.type === "custom") {
				if (typeof item.load === "function") { forkSettings.call(item, "load", [opts]); }
			} else {
				io.write(item, forkSettings.call(item, "get", [opts]));
			}
		});
	},

	/** Write the controls into options (Save) */
	saveAll: function(opts, io) {
		forkSettings.items.forEach(function(item) {
			if (!io.present(item)) { return; }
			if (item.type === "custom") {
				if (typeof item.save === "function") { forkSettings.call(item, "save", [opts]); }
			} else {
				forkSettings.call(item, "set", [opts, io.read(item)]);
			}
		});
	},

	/** Back to the defaults (Settings > Reset): a missing key means the default */
	resetAll: function(opts) {
		forkSettings.items.forEach(function(item) {
			if (typeof item.reset === "function") { forkSettings.call(item, "reset", [opts]); }
			else if (item.key) { delete opts[item.key]; }
		});
	},

	/**
	 * Settings > Reset: wrap opts.reset so it ends by removing the fork's keys (resetAll). Must be the outermost
	 * wrapper: What's New's wrapper keeps every key without an upstream default and puts them back after the
	 * inner reset, which would undo resetAll if it wrapped us. Called at start-up and again on every Reset click,
	 * so a wrapper added later (whatever the script order) ends up inside ours.
	 */
	wrapReset: function(opts) {
		if (!opts || typeof opts.reset !== "function" || opts.reset === forkSettings.resetWrapper) { return; }
		const inner = opts.reset;
		const wrapped = function() {
			const result = inner.apply(this, arguments);
			forkSettings.resetAll(this);
			return result;
		};
		Object.keys(inner).forEach(function(k) { wrapped[k] = inner[k]; });
		forkSettings.resetWrapper = wrapped;
		opts.reset = wrapped;
	},

	/** Index of the first of `orders` greater than `order` (a row goes before it), or -1 (append) */
	insertIndex: function(orders, order) {
		for (let i = 0; i < orders.length; i++) { if (orders[i] > order) { return i; } }
		return -1;
	},

	/** Nearest section before `key` in display order that is on the page (present(key) is true), or null */
	previousSection: function(keys, key, present) {
		for (let i = keys.indexOf(key) - 1; i >= 0; i--) { if (present(keys[i])) { return keys[i]; } }
		return null;
	},

	/**
	 * What the filter shows. sections = [{title, rows: [text], extra: text outside the rows (buttons, notes)}].
	 * A title match shows the whole section; otherwise only matching rows, and the section if any row or its
	 * extra text matches. Returns {found, sections: [{show, rows: [bool]}]}.
	 */
	filterPlan: function(sections, query) {
		let found = false;
		const plan = sections.map(function(s) {
			const all = forkSettings.matches(s.title, query);
			const rows = s.rows.map(function(text) { return all || forkSettings.matches(text, query); });
			const show = all || rows.indexOf(true) >= 0 || forkSettings.matches(s.extra, query);
			found = found || show;
			return { show: show, rows: rows };
		});
		return { found: found, sections: plan };
	},

	/** Settings filter: every word of the query appears in the text (case-insensitive) */
	matches: function(text, query) {
		const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
		const haystack = String(text || "").toLowerCase();
		return words.every(function(w) { return haystack.indexOf(w) >= 0; });
	},

	/** Markup of a setting's row(s), wrapped in its own tbody (sorted by data-fs-order) */
	rowHtml: function(item) {
		const esc = forkSettings.escape;
		const hint = item.hint ? "<div class='fs-hint'>" + esc(item.hint) + "</div>" : "";
		let rows;
		if (item.type === "custom" && item.rows) {
			rows = item.rows;
		} else {
			let cell;
			if (item.type === "checkbox") {
				cell = "<label><input type='checkbox' id='" + esc(item.id) + "' /> " + esc(item.text) + "</label>";
			} else if (item.type === "select") {
				cell = "<select id='" + esc(item.id) + "'>" + item.choices.map(function(c) {
					return "<option value='" + esc(c[0]) + "'>" + esc(c[1]) + "</option>";
				}).join("") + "</select>";
			} else {
				cell = item.html;
			}
			rows = "<tr><th>" + esc(item.label) + "</th><td>" + cell + hint + "</td></tr>";
		}
		return "<tbody class='fs-item' data-fs-id='" + esc(item.id) + "' data-fs-order='" + item.order + "'"
			+ (item.keywords ? " data-fs-keywords='" + esc(item.keywords) + "'" : "") + ">" + rows + "</tbody>";
	},

	// ---- DOM (browser only) ----

	hasDOM: function() {
		// Only once the page is ready: by then What's New has wrapped options.reset (see installHooks)
		return typeof window !== "undefined" && typeof document !== "undefined" && typeof jQuery !== "undefined"
			&& jQuery.isReady === true && !!document.getElementById && !!document.getElementById("optionsAccordion");
	},

	ready: function(fn) {
		if (typeof window === "undefined" || typeof jQuery === "undefined") { return; }
		if (jQuery.isReady) { fn(); } else { jQuery(fn); }
	},

	/** Content div of a section, creating the section (and its header) the first time */
	ensureSection: function(key) {
		if (!forkSettings.init()) { return null; }
		const $acc = $("#optionsAccordion");
		const $existing = $acc.children("div[data-fs-section='" + key + "']");
		if ($existing.length) { return $existing; }
		const def = forkSettings.sectionDef(key);
		if (!def || def.upstream) { return null; }
		const id = def.id || ("fs-section-" + key);
		const $h3 = $("<h3><a href='#'></a></h3>").attr("id", id.replace(/-section$/, "") + "-header");
		$h3.find("a").text(def.title);
		const $div = $("<div></div>").attr({ id: id, "data-fs-section": key })
			.append($("<table class='optionsTable' width='100%' cellpadding='1' cellspacing='0'></table>").addClass(def.tableClass || ""));
		// After the nearest section before it (in display order) that is on the page
		const sectionDiv = function(k) { return $acc.children("div[data-fs-section='" + k + "']"); };
		const prev = forkSettings.previousSection(forkSettings.order(), key, function(k) { return sectionDiv(k).length > 0; });
		if (prev) { sectionDiv(prev).after($h3, $div); } else { $acc.prepend($h3, $div); }
		forkSettings.refresh();
		// Rows registered for this section before it existed
		forkSettings.items.forEach(function(item) { if (item.section === key && !item.rendered) { forkSettings.render(item); } });
		return $div;
	},

	render: function(item) {
		if (item.rendered) { return; }
		const $section = forkSettings.ensureSection(item.section);
		if (!$section || !$section.length) { return; }	// its section isn't declared yet: rendered when it is
		if (item.rendered) { return; }	// creating the section just rendered it (with the others waiting for it)
		item.rendered = true;
		forkSettings.place($section, $(forkSettings.rowHtml(item)), item.order);
		forkSettings.refresh();
	},

	/** Put a tbody into a section's table by its order (upstream's own rows stay first) */
	place: function($section, $tbody, order) {
		const $table = $section.find("table.optionsTable").first();
		const $items = $table.children("tbody.fs-item");
		const i = forkSettings.insertIndex($items.map(function() { return Number($(this).attr("data-fs-order")); }).get(), order);
		if (i >= 0) { $items.eq(i).before($tbody); } else { $table.append($tbody); }
	},

	refresh: function() {
		const $acc = $("#optionsAccordion");
		if ($acc.hasClass("ui-accordion")) { $acc.accordion("refresh"); }
	},

	/** Once: tag and rename upstream sections, move upstream rows, hook Save/open/Reset, add the filter box */
	init: function() {
		if (forkSettings.initialized) { return true; }
		if (!forkSettings.hasDOM()) { return false; }
		forkSettings.initialized = true;
		const $acc = $("#optionsAccordion");

		forkSettings.SECTIONS.forEach(function(s) {
			if (!s.upstream) { return; }
			const $div = $acc.children("div").filter(function() { return $(this).find(s.upstream).length > 0; }).first();
			if (!$div.length) { return; }
			$div.attr("data-fs-section", s.key);
			if (s.title) { $div.prev("h3").find("a").text(s.title); }
			// A footnote row (e.g. Chain Map's "*: No effect in old org chart renderer") stays last, under fork rows
			const $last = $div.find("table.optionsTable").first().find("tr").last();
			if ($last.children("td[colspan]").length && !$last.find("input, select").length) {
				const $tbody = $("<tbody class='fs-item fs-footnote'></tbody>").attr("data-fs-order", forkSettings.FOOTNOTE_ORDER);
				$last.closest("table").append($tbody.append($last));
			}
		});

		forkSettings.UPSTREAM_ROWS.forEach(function(r) {
			const $tr = $acc.find(r.selector).first().closest("tr");
			const $section = $tr.length ? forkSettings.ensureSection(r.section) : null;
			if (!$section) { return; }
			const $tbody = $("<tbody class='fs-item'></tbody>").attr({ "data-fs-id": r.selector.replace(/^#/, ""), "data-fs-order": r.order });
			forkSettings.place($section, $tbody.append($tr), r.order);
		});

		forkSettings.installHooks();
		forkSettings.installFilter();
		return true;
	},

	domIO: {
		present: function(item) { return item.rendered && (item.type === "custom" || !!document.getElementById(item.id)); },
		read: function(item) {
			const $el = $(document.getElementById(item.id));
			return item.type === "checkbox" ? $el.prop("checked") : $el.val();
		},
		write: function(item, value) {
			const $el = $(document.getElementById(item.id));
			if (item.type === "checkbox") { $el.prop("checked", !!value); } else { $el.val(String(value)); }
		}
	},

	installHooks: function() {
		// Every open re-reads the stored values, so Close discards unsaved changes
		$(document).on("dialogopen", "#dialog-options", function() {
			forkSettings.fillAll(options, forkSettings.domIO);
			forkSettings.filter("");
		});
		// Capture phase: the values are in options before upstream's Save handler runs options.apply() and saves
		document.addEventListener("click", function(e) {
			const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
			if (!button || $.trim($(button).text()) !== "Save") { return; }
			if (!$(button).closest(".ui-dialog").find("#dialog-options").length || typeof options === "undefined") { return; }
			forkSettings.saveAll(options, forkSettings.domIO);
		}, true);
		// Settings > Reset removes the fork's keys: wrap now, and again (capture phase) on a click on either Reset
		// button (Settings' and its confirmation's), so our wrapper is outermost whatever wrapped reset since
		if (typeof options !== "undefined") { forkSettings.wrapReset(options); }
		document.addEventListener("click", function(e) {
			const button = e.target && e.target.closest ? e.target.closest(".ui-dialog-buttonpane button") : null;
			if (button && $.trim($(button).text()) === "Reset" && typeof options !== "undefined") { forkSettings.wrapReset(options); }
		}, true);
	},

	// ---- "Find a setting" filter ----

	installFilter: function() {
		if ($("#fs-filter").length) { return; }
		const $box = $("<div id='fs-filter'><input type='search' id='fs-filter-input' placeholder='Find a setting…' autocomplete='off' />"
			+ "<span class='fs-filter-none hidden'>No setting matches</span></div>");
		$("#optionsAccordion").before($box);
		$(document).on("input", "#fs-filter-input", function() { forkSettings.filter($(this).val()); });
		// While filtering every matching section is shown open: a header click would only change the accordion's
		// hidden state (and so which section is open once the filter is cleared), so ignore it
		$("#optionsAccordion").on("accordionbeforeactivate", function() { return !$(this).hasClass("fs-filtering"); });
	},

	/** Text of a section outside its rows, found by the filter too: buttons, notes, other tables */
	extraText: function(div) {
		const $clone = $(div).clone();
		$clone.find("table.optionsTable").first().remove();
		$clone.find("select, option, script, style").remove();
		const values = $clone.find("input[type='button'], input[type='submit'], button").map(function() { return $(this).val(); }).get();
		return $clone.text() + " " + values.join(" ");
	},

	/** Text a row is found by: its heading, labels and notes (not the choices of its selects) */
	rowText: function(tr) {
		const $clone = $(tr).clone();
		$clone.find("select, option, script, style").remove();
		return $clone.text() + " " + ($(tr).closest("tbody").attr("data-fs-keywords") || "");
	},

	/** Show only the rows matching the query, with their sections open; empty query = back to normal */
	filter: function(query) {
		const $acc = $("#optionsAccordion");
		const q = $.trim(query || "");
		$("#fs-filter-input").val(q);
		$acc.find(".fs-hidden").removeClass("fs-hidden");
		$acc.children(".fs-match").removeClass("fs-match");
		$acc.toggleClass("fs-filtering", q !== "");
		let found = true;
		if (q) {
			const sections = $acc.children("h3").map(function() {
				const $div = $(this).next("div");
				return { $h3: $(this), $div: $div, $rows: $div.find("table.optionsTable").first().children("tbody").children("tr") };
			}).get();
			const plan = forkSettings.filterPlan(sections.map(function(s) {
				return { title: s.$h3.text(), rows: s.$rows.map(function() { return forkSettings.rowText(this); }).get(), extra: forkSettings.extraText(s.$div) };
			}), q);
			sections.forEach(function(s, i) {
				const p = plan.sections[i];
				s.$rows.each(function(r) { $(this).toggleClass("fs-hidden", !p.rows[r]); });
				s.$h3.toggleClass("fs-hidden", !p.show);
				s.$div.toggleClass("fs-hidden", !p.show).toggleClass("fs-match", p.show);
			});
			found = plan.found;
		}
		$("#fs-filter .fs-filter-none").toggleClass("hidden", found);
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined") {
	jQuery(function() { forkSettings.init(); });
}
