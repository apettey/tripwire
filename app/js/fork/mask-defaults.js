const maskDefaults = {
	// Fork-owned: mask-wide default settings. A mask admin saves some of the fork's settings (Mask Admin > Admins & members)
	// as the mask's defaults; a member who has not set that setting themselves gets the mask default instead of the
	// built-in one: own choice -> mask default -> built-in default. Server side: public/mask_admins.php.
	// Keep `const maskDefaults` on the first line: the test helper strips it to define a global.
	//
	// How: a default is put into the in-memory `options` (under the setting's top-level options key) when the member
	// has no value for that key, and remembered as "inherited". options.get() - what is saved to the server and to
	// localStorage - leaves out inherited keys the member has not changed, so a default is never turned into a personal
	// choice just by saving something else, and a changed mask default reaches everyone who did not choose.
	// A member who picks a value that is exactly the default is not told apart from one who never chose (their value
	// is then not saved), so it follows later changes of the default.
	URL: "mask_admins.php",
	// The only options a mask default may carry: the keys of the fork's Settings rows. The same list as the server's
	// MASKADMIN_DEFAULTS_ALLOW (maskadmin/maskadmin.inc.php); app/js-test/fork/mask-defaults.test.js checks both against
	// the keys the forkSettings.register() calls use, so a new setting with a key has to be added to both.
	ALLOWED: ["autoMass", "chainKillFeed", "commandPalette", "environmentTags", "favouritesRouteStrip", "highsecRegion", "holeNaming", "homeRegion", "intelScans", "jumpReturn", "jumpSigPrompt",
		"killReporting", "lifeStates", "lootBuyers", "mapTargets", "preserveMass", "regionMap", "rollPlan", "rolling", "rollingCalc", "routeHoleFilters", "sigAge", "sigInline", "sigAnomalies", "sigExpiry", "sizeTags", "skyhooksPanel", "smartNotes",
		"soundMute", "stagingScan", "structures", "systemKillFeed", "systemResidents", "systemThreat", "theraRoute", "watchlist"],

	defaults: {},	// the active mask's defaults {optionsKey: value}
	updatedBy: "",
	updatedAt: null,
	inherited: {},	// optionsKey -> copy of the default that was put into options
	installedOn: null,	// the options object install() wrapped

	clone: function(value) {
		return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
	},

	equal: function(a, b) {
		return JSON.stringify(maskDefaults.canonical(a)) === JSON.stringify(maskDefaults.canonical(b));
	},

	/** Same value whatever the order of object keys */
	canonical: function(v) {
		if (Array.isArray(v)) { return v.map(maskDefaults.canonical); }
		if (v && typeof v === "object") {
			const out = {};
			Object.keys(v).sort().forEach(function(k) { out[k] = maskDefaults.canonical(v[k]); });
			return out;
		}
		return v;
	},

	/** Is this an options key a mask default may be set for */
	allowedKey: function(key) {
		return typeof key === "string" && maskDefaults.ALLOWED.indexOf(key) >= 0;	// "__proto__", "constructor" etc. are not in the list
	},

	/** The defaults object from the server, cleaned to allowed keys (a bad answer = no defaults) */
	normalise: function(raw) {
		const out = {};
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) { return out; }
		Object.keys(raw).forEach(function(k) {
			if (maskDefaults.allowedKey(k) && raw[k] !== undefined) { out[k] = maskDefaults.clone(raw[k]); }
		});
		return out;
	},

	/**
	 * What a setting is, in order: the member's own value, the mask default, else undefined (= the built-in default).
	 * `user` is the member's stored options object.
	 */
	resolve: function(user, defaults, key) {
		if (user && Object.prototype.hasOwnProperty.call(user, key) && user[key] !== undefined) { return user[key]; }
		if (defaults && maskDefaults.allowedKey(key) && Object.prototype.hasOwnProperty.call(defaults, key)) { return defaults[key]; }
		return undefined;
	},

	/**
	 * Put the defaults into `opts` where the member has no value of their own. `inherited` (key -> default applied) is
	 * updated: a key that still holds the default applied earlier follows a changed or removed default; one the member
	 * changed is left alone. Returns the keys that changed in opts.
	 */
	overlay: function(opts, defaults, inherited) {
		const changed = [];
		const clean = maskDefaults.normalise(defaults);
		Object.keys(inherited).forEach(function(k) {
			if (Object.prototype.hasOwnProperty.call(opts, k) && !maskDefaults.equal(opts[k], inherited[k])) {
				delete inherited[k];	// the member's own value now
			} else if (!Object.prototype.hasOwnProperty.call(clean, k)) {
				delete opts[k];		// the default is gone and the member never chose
				delete inherited[k];
				changed.push(k);
			}
		});
		Object.keys(clean).forEach(function(k) {
			const has = Object.prototype.hasOwnProperty.call(opts, k) && opts[k] !== undefined;
			if (!has) {
				opts[k] = maskDefaults.clone(clean[k]);
				inherited[k] = maskDefaults.clone(clean[k]);
				changed.push(k);
			} else if (Object.prototype.hasOwnProperty.call(inherited, k) && !maskDefaults.equal(inherited[k], clean[k])) {
				opts[k] = maskDefaults.clone(clean[k]);
				inherited[k] = maskDefaults.clone(clean[k]);
				changed.push(k);
			}
		});
		return changed;
	},

	/** A copy of the options to save: inherited keys the member did not change are left out */
	strip: function(data, inherited) {
		const out = {};
		Object.keys(data).forEach(function(k) {
			if (Object.prototype.hasOwnProperty.call(inherited, k) && maskDefaults.equal(data[k], inherited[k])) { return; }
			out[k] = data[k];
		});
		return out;
	},

	/** Does the member get this setting from the mask default */
	isInherited: function(opts, inherited, key) {
		return Object.prototype.hasOwnProperty.call(inherited, key) && maskDefaults.equal(opts[key], inherited[key]);
	},

	/** The settings an admin can pick: [{key, label}] from the forkSettings rows that store an options key, once per key */
	pickable: function(items) {
		const seen = {};
		const out = [];
		(items || []).forEach(function(item) {
			if (!item || !maskDefaults.allowedKey(item.key) || seen[item.key]) { return; }
			seen[item.key] = true;
			const label = String(item.label || item.text || item.id || item.key).replace(/\s*:\s*$/, "");
			out.push({ key: item.key, label: label });
		});
		return out.sort(function(a, b) { return a.label.localeCompare(b.label); });
	},

	/** The defaults to save: the member's current value of each picked key (keys without a value are skipped) */
	collect: function(opts, keys) {
		const out = {};
		(keys || []).forEach(function(k) {
			if (maskDefaults.allowedKey(k) && opts && opts[k] !== undefined) { out[k] = maskDefaults.clone(opts[k]); }
		});
		return out;
	},

	// ---- browser wiring ----

	/** Make options.get() leave out inherited keys, and options.apply() fill the defaults in first */
	install: function(opts) {
		// The flag is kept here, not on opts: options.get() saves every own field of options, so a flag on it was
		// stored and loaded back on the next page load, and install() then skipped and no default ever applied
		if (!opts || maskDefaults.installedOn === opts) { return; }
		maskDefaults.installedOn = opts;
		const get = opts.get;
		const apply = opts.apply;
		opts.get = function() {
			const out = maskDefaults.strip(get.apply(this, arguments), maskDefaults.inherited);
			delete out.maskDefaultsWrapped;	// stored by older versions
			return out;
		};
		opts.apply = function() {
			maskDefaults.overlay(this, maskDefaults.defaults, maskDefaults.inherited);
			return apply.apply(this, arguments);
		};
		Object.keys(apply).forEach(function(k) { opts.apply[k] = apply[k]; });
		Object.defineProperty(opts, "maskDefaultsWrapped", { value: true, writable: true, configurable: true, enumerable: false });
	},

	/** A new defaults answer (page load, or after an admin saved): use it and redraw with it */
	use: function(data) {
		maskDefaults.defaults = maskDefaults.normalise(data && data.defaults);
		maskDefaults.updatedBy = data && data.updatedBy ? String(data.updatedBy) : "";
		maskDefaults.updatedAt = data && data.updatedAt ? String(data.updatedAt) : null;
		if (typeof options !== "undefined" && maskDefaults.installedOn === options && typeof options.apply === "function") {
			options.apply();
		}
	},

	/** "mask default" next to the settings that come from it (Settings dialog) */
	markRows: function() {
		if (typeof forkSettings === "undefined" || typeof $ === "undefined") { return; }
		$("#optionsAccordion .md-badge").remove();
		forkSettings.items.forEach(function(item) {
			if (!item.key || !Object.prototype.hasOwnProperty.call(maskDefaults.defaults, item.key)) { return; }
			const $th = $("#optionsAccordion tbody.fs-item[data-fs-id='" + item.id + "'] th").first();
			if (!$th.length) { return; }
			const inherited = maskDefaults.isInherited(options, maskDefaults.inherited, item.key);
			$("<span class='md-badge'></span>")
				.text(inherited ? "mask default" : "own choice")
				.attr("title", inherited ? "Set by the mask admins (" + (maskDefaults.updatedBy || "unknown") + "); change it here to use your own"
					: "You chose this; the mask has a different default")
				.toggleClass("md-own", !inherited)
				.appendTo($th);
		});
	},

	init: function() {
		if (typeof options === "undefined" || typeof $ === "undefined") { return; }
		maskDefaults.install(options);
		$(document).on("dialogopen", "#dialog-options", function() { maskDefaults.markRows(); });
		$.ajax({ url: maskDefaults.URL, type: "GET", data: { mode: "defaults" }, dataType: "JSON", cache: false })
			.done(function(data) { maskDefaults.use(data); })
			.fail(function() { /* no defaults: the built-in ones */ });
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { maskDefaults.init(); });
}
