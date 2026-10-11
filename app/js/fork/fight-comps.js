const fightComps = {
	// Fork-owned: fleet comps of "Fight here" (the chain map's rally point, app/js/fork/rally.js). Pure helpers used by
	// rally.js (submenu, banner, node colour) and Mask Admin > Fight here, where the corporation's Tripwire admins add,
	// edit, reorder and remove the mask's comps (server side: public/fight.php, fight/fight.inc.php).
	// Keep `const fightComps` on the first line: the test helper strips it to define a global.
	URL: "fight.php",
	// Same keys and colours as the server (fight_palette); the key is what is stored
	PALETTE: {
		green: "#39ff14", red: "#ff4747", orange: "#ff9f1a", yellow: "#ffe14d", blue: "#4da6ff",
		purple: "#b57cff", pink: "#ff6ec7", cyan: "#2ee6d6", white: "#e6e6e6"
	},
	MAX_COMPS: 20,
	NAME_MAX: 40,
	NOTE_MAX: 140,
	SET_COMMAND: "fightSet",	// menu commands: "fightSet:" + comp id ("fightSet:" alone = no comp)
	CLEAR_COMMAND: "fightClear",

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** One line of text: control characters and runs of spaces become one space, trimmed */
	cleanText: function(text) {
		return String(text === undefined || text === null ? "" : text).replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
	},

	/** A palette key, "green" for anything else */
	colourKey: function(key) {
		return Object.prototype.hasOwnProperty.call(fightComps.PALETTE, key) ? key : "green";
	},

	colourOf: function(key) {
		return fightComps.PALETTE[fightComps.colourKey(key)];
	},

	/** A comp from the server, safe to use: {id, name, colour, note}, or null when it has no id or name */
	normaliseComp: function(comp) {
		if (!comp || typeof comp !== "object") { return null; }
		const id = typeof comp.id === "string" ? comp.id : "";
		const name = fightComps.cleanText(comp.name).slice(0, fightComps.NAME_MAX);
		if (!name) { return null; }
		return { id: id, name: name, colour: fightComps.colourKey(comp.colour), note: fightComps.cleanText(comp.note).slice(0, fightComps.NOTE_MAX) };
	},

	/** The mask's comps from the server (public/rally.php, public/fight.php): valid ones with an id, each id once, at most MAX_COMPS */
	normaliseComps: function(list) {
		const out = [];
		const seen = {};
		(Array.isArray(list) ? list : []).forEach(function(entry) {
			const comp = fightComps.normaliseComp(entry);
			if (!comp || !/^c[0-9a-f]{10}$/.test(comp.id) || seen[comp.id] || out.length >= fightComps.MAX_COMPS) { return; }
			seen[comp.id] = true;
			out.push(comp);
		});
		return out;
	},

	/** The comp id of a menu command ("fightSet:c0123456789" -> "c0123456789", "fightSet:" -> ""), null for other commands */
	compOfCommand: function(cmd) {
		const prefix = fightComps.SET_COMMAND + ":";
		if (typeof cmd !== "string" || cmd.indexOf(prefix) !== 0) { return null; }
		const id = cmd.slice(prefix.length);
		return id === "" || /^c[0-9a-f]{10}$/.test(id) ? id : null;
	},

	/**
	 * The "Fight here" submenu for a right-clicked system: [{cmd, text, colour?, current?, title?} | "-"]. "Fight here (no comp)",
	 * one entry per comp, and "Clear fight" when a fight point is set (anywhere: it names the system when it is another one).
	 * @param comps normalised comps
	 * @param fight the current fight point {systemID, comp: {id}|null} or null
	 * @param systemID the right-clicked system
	 * @param systemName name of a system ID (for "Clear fight (J123456)")
	 */
	menuEntries: function(comps, fight, systemID, systemName) {
		const here = !!(fight && fight.systemID && String(fight.systemID) === String(systemID));
		const currentComp = here ? (fight.comp && fight.comp.id ? fight.comp.id : "") : null;
		const entries = [{ cmd: fightComps.SET_COMMAND + ":", text: "Fight here (no comp)", current: currentComp === "" }];
		if (comps && comps.length) {
			entries.push("-");
			comps.forEach(function(c) {
				entries.push({ cmd: fightComps.SET_COMMAND + ":" + c.id, text: c.name, colour: c.colour, title: c.note || "", current: currentComp === c.id });
			});
		}
		if (fight && fight.systemID) {
			entries.push("-");
			entries.push({ cmd: fightComps.CLEAR_COMMAND, text: here ? "Clear fight" : "Clear fight (" + (systemName ? systemName(fight.systemID) : fight.systemID) + ")" });
		}
		return entries;
	},

	/** The one-click entry of a mask without comps (the old rally entry): "Clear fight" on the fight's system, else
	"Fight here" (sets or moves it, no comp). @return {text, clear} */
	flatEntry: function(fight, systemID) {
		const here = !!(fight && fight.systemID && String(fight.systemID) === String(systemID));
		return { text: here ? "Clear fight" : "Fight here", clear: here };
	},

	/** The submenu's <li>s (escaped) */
	menuHtml: function(entries) {
		const esc = fightComps.escape;
		return (entries || []).map(function(e) {
			if (e === "-") { return "<li>-</li>"; }
			const dot = e.colour ? "<span class='fight-dot' style='background-color: " + fightComps.colourOf(e.colour) + "'></span>" : "";
			return "<li data-command='" + esc(e.cmd) + "'" + (e.title ? " title='" + esc(e.title) + "'" : "") + "><a class='fight-entry" + (e.current ? " fight-current" : "") + "'>"
				+ dot + esc(e.text) + (e.current ? " <span class='fight-check'>&#10003;</span>" : "") + "</a></li>";
		}).join("");
	},

	/** "4 min ago" from seconds; "just now" under a minute */
	ageText: function(seconds) {
		const s = Math.max(0, Math.floor(Number(seconds) || 0));
		if (s < 60) { return "just now"; }
		if (s < 3600) { return Math.floor(s / 60) + " min ago"; }
		if (s < 86400) { return Math.floor(s / 3600) + " h ago"; }
		return Math.floor(s / 86400) + " d ago";
	},

	/** Short class of a system as the Discord messages show it: C1-C6, C13, Thera, Drifter, Pochven, HS / LS / NS */
	systemClass: function(system) {
		if (!system) { return ""; }
		if (system.class !== undefined && system.class !== null && system.class !== "") {
			const c = Number(system.class);
			if (c === 12) { return "Thera"; }
			if (c >= 14 && c <= 18) { return "Drifter"; }
			return "C" + system.class;
		}
		if (Number(system.regionID) === 10000070) { return "Pochven"; }
		const sec = Math.round(Number(system.security) * 10) / 10;
		if (isNaN(sec)) { return ""; }
		return sec >= 0.5 ? "HS" : sec > 0 ? "LS" : "NS";
	},

	/** "AB · J163701" from a chain label and a system name; only the name without a label */
	labelSystem: function(label, name) {
		label = fightComps.cleanText(label);
		return label ? label + " · " + name : String(name);
	},

	/**
	 * The parts of the fight banner: {where: "AB · J163701", details: "C5, 2 jumps", comp: {name, colour, note}|null,
	 * who: "set by Chribba", age: "4 min ago"}, and text: everything on one line (for the tooltip and tests).
	 * @param fight {systemID, label, setBy, comp} @param system tripwire.systems entry @param route text after the system
	 * ("2 jumps", "not on this map"...) @param seconds since it was set (null = unknown)
	 */
	bannerParts: function(fight, system, route, seconds) {
		const name = system && system.name ? system.name : String(fight && fight.systemID);
		const parts = {
			where: fightComps.labelSystem(fight && fight.label, name),
			details: [fightComps.systemClass(system), route].filter(function(x) { return x; }).join(", "),
			comp: fight && fight.comp ? fightComps.normaliseComp(fight.comp) : null,
			who: fight && fight.setBy ? "set by " + fightComps.cleanText(fight.setBy) : "",
			age: seconds === null || seconds === undefined ? "" : fightComps.ageText(seconds)
		};
		parts.text = "Fight here: " + parts.where + (parts.details ? " (" + parts.details + ")" : "")
			+ [parts.comp ? parts.comp.name : "", parts.who, parts.age].filter(function(x) { return x; }).map(function(x) { return " · " + x; }).join("");
		return parts;
	},

	/** Tooltip of the banner: the line, then the comp's note */
	bannerTitle: function(parts) {
		return parts.text + (parts.comp && parts.comp.note ? "\n" + parts.comp.name + ": " + parts.comp.note : "");
	},

	/** Mask Admin form values -> a comp for the server, or {errors} (the server checks again) */
	formComp: function(values, comps, editingID) {
		const errors = [];
		const name = fightComps.cleanText(values.name);
		const note = fightComps.cleanText(values.note);
		const mention = String(values.mention || "").trim().replace(/\s+/g, " ");
		if (!name) { errors.push("Give the comp a name"); }
		if (name.length > fightComps.NAME_MAX) { errors.push("The name can be at most " + fightComps.NAME_MAX + " characters"); }
		if (note.length > fightComps.NOTE_MAX) { errors.push("The note can be at most " + fightComps.NOTE_MAX + " characters"); }
		if (!Object.prototype.hasOwnProperty.call(fightComps.PALETTE, values.colour)) { errors.push("Pick one of the colours"); }
		if (mention && !mention.split(" ").every(function(t) { return /^(<@[&!]?\d{17,21}>|@here|@everyone)$/.test(t); })) {
			errors.push("The Discord mention may only contain <@&roleID>, <@userID>, @here or @everyone");
		}
		(comps || []).forEach(function(c) {
			if (c.id !== editingID && name && c.name.toLowerCase() === name.toLowerCase()) { errors.push("There is already a comp called \"" + c.name + "\""); }
		});
		if (!editingID && (comps || []).length >= fightComps.MAX_COMPS) { errors.push("At most " + fightComps.MAX_COMPS + " fleet comps per mask"); }
		const comp = { name: name, colour: values.colour, note: note, mention: mention };
		if (editingID) { comp.id = editingID; }
		return { comp: comp, errors: errors };
	},

	/** The comp ids with one moved up (-1) or down (+1) */
	moved: function(ids, id, direction) {
		const out = (ids || []).slice();
		const i = out.indexOf(id);
		const j = i + direction;
		if (i < 0 || j < 0 || j >= out.length) { return out; }
		out[i] = out[j];
		out[j] = id;
		return out;
	},

	/** Mask Admin > Fight here (state: public/fight.php's answer; editing: the comp in the form, or null for a new one) */
	pageHtml: function(state, editing) {
		const fc = fightComps;
		const esc = fc.escape;
		const comps = (state && state.comps) || [];
		const rows = comps.map(function(c, i) {
			return "<tr class='fight-row' data-id='" + esc(c.id) + "'>"
				+ "<td class='fight-order'><button type='button' class='fight-up' title='Move up'" + (i === 0 ? " disabled" : "") + ">&#9650;</button>"
				+ "<button type='button' class='fight-down' title='Move down'" + (i === comps.length - 1 ? " disabled" : "") + ">&#9660;</button></td>"
				+ "<td><span class='fight-dot' style='background-color: " + fc.colourOf(c.colour) + "'></span><b>" + esc(c.name) + "</b>"
				+ (c.note ? "<div class='fight-small'>" + esc(c.note) + "</div>" : "") + "</td>"
				+ "<td class='fight-mention'>" + (c.mention ? esc(c.mention) : "<span class='fight-small'>nobody</span>") + "</td>"
				+ "<td class='fight-actions'><button type='button' class='fight-edit'>Edit</button><button type='button' class='fight-delete'>Remove</button></td>"
				+ "</tr>";
		}).join("") || "<tr><td colspan='4' class='fight-small'>No fleet comps yet: add the first one below.</td></tr>";
		const e = editing || { name: "", colour: "green", note: "", mention: "" };
		const swatches = Object.keys(fc.PALETTE).map(function(key) {
			return "<label class='fight-swatch' title='" + esc(key) + "'><input type='radio' name='fight-colour' value='" + esc(key) + "'" + (fc.colourKey(e.colour) === key ? " checked" : "") + " />"
				+ "<span class='fight-dot' style='background-color: " + fc.PALETTE[key] + "'></span></label>";
		}).join("");
		return "<div class='fight-admin'>"
			+ "<h2>Fight here: fleet comps of the " + esc(state && state.mask ? state.mask.name : "") + " mask</h2>"
			+ "<p class='fight-small'>Members pick one of these when they right-click a system on the chain map &gt; Fight here. Everyone on the mask sees the fight point in the comp's colour, with its name and note, and the Discord message (Mask Admin &gt; Discord &gt; Fight here) names the comp and pings its mention. Only your corporation's Tripwire admins change the list.</p>"
			+ "<table class='fight-comps'><thead><tr><th></th><th>Comp</th><th>Discord mention</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>"
			+ "<p class='fight-small'>" + comps.length + " of " + fc.MAX_COMPS + ". Removing a comp doesn't change a fight point already set with it: it shows the comp as it was until the fight is cleared or moved.</p>"
			+ "<h3>" + (editing && editing.id ? "Edit " + esc(editing.name) : "Add a comp") + "</h3>"
			+ "<form class='fight-form' autocomplete='off'><table class='fight-form-table'>"
			+ "<tr><th>Name:</th><td><input type='text' class='fight-name' maxlength='" + fc.NAME_MAX + "' size='30' value='" + esc(e.name) + "' placeholder='e.g. Armor HACs' /></td></tr>"
			+ "<tr><th>Colour:</th><td class='fight-swatches'>" + swatches + "</td></tr>"
			+ "<tr><th>Note:</th><td><input type='text' class='fight-note' maxlength='" + fc.NOTE_MAX + "' size='60' value='" + esc(e.note) + "' placeholder='optional, e.g. Zealots + Sacrileges, links in fleet' />"
			+ "<div class='fight-small'>Shown when people point at the fight banner, and as {compNote} in the Discord message.</div></td></tr>"
			+ "<tr><th>Discord mention:</th><td><input type='text' class='fight-mention-input' size='40' value='" + esc(e.mention) + "' placeholder='optional, e.g. <@&123456789012345678> or @here' />"
			+ "<div class='fight-small'>Pinged with the Fight here message (with that type's own ping), only when a fight with this comp is posted. Roles: &lt;@&amp;roleID&gt;, users: &lt;@userID&gt;, or @here / @everyone.</div></td></tr>"
			+ "<tr><th></th><td><input type='submit' class='fight-save' value='" + (editing && editing.id ? "Save comp" : "Add comp") + "' />"
			+ (editing && editing.id ? " <a href='#' class='fight-cancel'>cancel</a>" : "")
			+ " <span class='fight-message fight-small'></span></td></tr>"
			+ "</table></form></div>";
	},

	// ---- Browser-only code below (not run under mocha) ----

	state: null,
	editingID: null,
	csrf: "",

	load: function() {
		return $.ajax({ url: fightComps.URL, type: "GET", data: { mode: "get" }, dataType: "JSON", cache: false });
	},

	request: function(mode, data) {
		return $.ajax({
			url: fightComps.URL, type: "POST", contentType: "application/json", dataType: "JSON",
			data: JSON.stringify(Object.assign({ mode: mode }, data || {})),
			headers: { "X-CSRF-Token": fightComps.csrf, "X-Requested-With": "XMLHttpRequest" }
		});
	},

	errorText: function(xhr) {
		return (xhr && xhr.responseJSON && xhr.responseJSON.error) || "Request failed" + (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : "");
	},

	$window: function() {
		return $("#dialog-admin .window [data-window='fight']");
	},

	render: function(message, bad) {
		const fc = fightComps;
		if (!fc.state) { return; }
		const editing = fc.editingID ? (fc.state.comps || []).filter(function(c) { return c.id === fc.editingID; })[0] || null : null;
		if (fc.editingID && !editing) { fc.editingID = null; }
		fc.$window().html(fc.pageHtml(fc.state, editing));
		if (message) { fc.$window().find(".fight-message").addClass(bad ? "fight-bad" : "fight-good").text(message); }
	},

	/** A new answer of fight.php: show it, and let the chain map's menu know the new list */
	use: function(data, message) {
		fightComps.state = data;
		fightComps.csrf = data.csrf || fightComps.csrf;
		if (typeof rally !== "undefined" && rally.setComps) { rally.setComps(data.comps); }
		fightComps.render(message);
	},

	refresh: function() {
		const fc = fightComps;
		if (!fc.state) { fc.$window().html("<p class='fight-small'>Loading...</p>"); }
		return fc.load().done(function(data) { fc.use(data); }).fail(function(xhr) {
			fc.state = null;
			fc.$window().html("<p class='fight-bad'>" + fc.escape(fc.errorText(xhr)) + "</p>");
		});
	},

	bind: function() {
		const fc = fightComps;
		const sel = "#dialog-admin .window [data-window='fight']";
		const $doc = $(document);
		const fail = function(xhr) { fc.$window().find(".fight-message").removeClass("fight-good").addClass("fight-bad").text(fc.errorText(xhr)); };
		$doc.on("submit", sel + " .fight-form", function(e) {
			e.preventDefault();
			const $form = $(this);
			const result = fc.formComp({
				name: $form.find(".fight-name").val(), colour: $form.find("input[name='fight-colour']:checked").val(),
				note: $form.find(".fight-note").val(), mention: $form.find(".fight-mention-input").val()
			}, fc.state.comps || [], fc.editingID);
			if (result.errors.length) { $form.find(".fight-message").removeClass("fight-good").addClass("fight-bad").text(result.errors.join(" ")); return; }
			const editing = !!fc.editingID;
			fc.request("comp-save", { comp: result.comp }).done(function(data) {
				fc.editingID = null;
				fc.use(data, editing ? "Comp saved." : "Comp added.");
			}).fail(fail);
		});
		$doc.on("click", sel + " .fight-edit", function(e) {
			e.preventDefault();
			fc.editingID = String($(this).closest(".fight-row").attr("data-id"));
			fc.render();
			fc.$window().find(".fight-name").focus();
		});
		$doc.on("click", sel + " .fight-cancel", function(e) {
			e.preventDefault();
			fc.editingID = null;
			fc.render();
		});
		$doc.on("click", sel + " .fight-delete", function(e) {
			e.preventDefault();
			const id = String($(this).closest(".fight-row").attr("data-id"));
			const comp = (fc.state.comps || []).filter(function(c) { return c.id === id; })[0];
			if (!comp || !window.confirm("Remove the fleet comp \"" + comp.name + "\" for everyone on the mask?")) { return; }
			fc.request("comp-delete", { id: id }).done(function(data) {
				if (fc.editingID === id) { fc.editingID = null; }
				fc.use(data, "Comp removed.");
			}).fail(fail);
		});
		$doc.on("click", sel + " .fight-up, " + sel + " .fight-down", function(e) {
			e.preventDefault();
			const id = String($(this).closest(".fight-row").attr("data-id"));
			const ids = (fc.state.comps || []).map(function(c) { return c.id; });
			fc.request("comp-order", { ids: fc.moved(ids, id, $(this).hasClass("fight-up") ? -1 : 1) }).done(function(data) { fc.use(data); }).fail(fail);
		});
	},

	init: function() {
		const fc = fightComps;
		const $dialog = $("#dialog-admin");
		// Where Mask Admin is offered, for the masks Discord notifications are for (the server checks again on every change)
		if (!$dialog.length || !$("#admin").length || $("#admin").css("display") === "none") { return; }
		const active = typeof init !== "undefined" && init && Array.isArray(init.masks) ? init.masks.filter(function(m) { return m.active; })[0] : null;
		const allowed = typeof discordNotifications !== "undefined" && discordNotifications.maskAllowed ? discordNotifications.maskAllowed(active) : false;
		if (!allowed) { return; }
		if (!$dialog.find(".menu li[data-window='fight']").length) {
			$dialog.find(".menu ul").append("<li data-window='fight'><a href='#'>Fight here</a></li>");
			$dialog.find(".window").append("<div data-window='fight' class='hidden'></div>");
		}
		fc.bind();
		$(document).on("click", "#dialog-admin .menu li", function() {
			const mine = $(this).attr("data-window") === "fight";
			const $d = $("#dialog-admin");
			if (!$d.hasClass("ui-dialog-content")) { return; }
			$d.closest(".ui-dialog").toggleClass("fight-admin-active", mine);	// hides the "Total: n" tray
			if (mine) {
				$d.dialog("option", "height", Math.min(620, Math.max(350, $(window).height() - 40)));
				fc.editingID = null;
				fc.refresh();
			}
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { fightComps.init(); });
}
