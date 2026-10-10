const discordNotifications = {
	// Fork-owned: Discord notifications settings page in Mask Admin (see docker/README.md#discord-notifications).
	// Only for admins/owners of the current mask: the menu entry is added only when the Mask Admin link is shown, and
	// public/discord.php checks the mask admin rights on every request (403 otherwise). Webhook URLs never come back
	// from the server; the page shows a name, '…/1234' and the webhook's status instead.
	URL: "discord.php",
	KINDS: ["kspace", "chainKill", "corpKill", "corpLoss", "rally"],
	LABELS: {
		kspace: "New k-space near a ping system",
		chainKill: "Any kill in our chain",
		corpKill: "Kills by our corporation",
		corpLoss: "Losses of our corporation",
		rally: "Rally point"
	},
	HELP: {
		kspace: "A wormhole to a k-space system (high, low or null-sec) that was not on the chain yet, within the safe jump range of a ping system.",
		chainKill: "A kill in a wormhole, low-sec or null-sec system on this mask's chain map (high-sec systems only if you tick them below).",
		corpKill: "One of the corporations/alliances below is on the attackers' side.",
		corpLoss: "The victim is in one of the corporations/alliances below.",
		rally: "Someone sets, moves or clears the chain map's rally point (right-click a system > Rally here). Changes within 30 seconds edit the last message instead of posting a new one. Members can keep their own changes out of Discord (\"Also post to Discord\" in the chain map's right-click menu, or Settings > Chain Map Settings)."
	},
	LEGACY_RALLY: "While this is off, rally changes still go to the webhook this server's operator configured for the mask (DISCORD_WEB_HOOK). Turn it on to choose the channel here instead.",
	SAFE_RULE: "Safe route: every system between the ping system and the new system is high-sec (0.5 and up, not Pochven), never through Zarzakh. The two ends may be any security.",
	WEBHOOK_PATTERN: /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{17,21}\/[A-Za-z0-9_-]{30,120}\/?(?:\?thread_id=\d{17,21})?$/,
	MAX_PING_SYSTEMS: 20,

	state: null,	// last answer of discord.php (webhooks, settings, ...)
	draft: null,	// settings as edited but not saved yet (kept across webhook changes)
	csrf: "",

	// ---- Pure helpers ----

	escape: function(text) {
		return String(text === undefined || text === null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
	},

	/** Same format check as the server (discord_webhook_parse) */
	isWebhookUrl: function(url) {
		return discordNotifications.WEBHOOK_PATTERN.test(String(url || "").trim());
	},

	/** A ping field: empty, or only <@&role>, <@user>, @here, @everyone separated by spaces */
	isValidPing: function(text) {
		const value = String(text || "").trim();
		if (!value) { return true; }
		return value.split(/\s+/).every(function(t) { return /^(<@[&!]?\d{17,21}>|@here|@everyone)$/.test(t); });
	},

	/** "98000001, 99000001" -> {ids: [98000001, 99000001], invalid: []} */
	parseIdList: function(text) {
		const ids = [];
		const invalid = [];
		String(text || "").split(/[\s,;]+/).forEach(function(part) {
			if (!part) { return; }
			const id = /^\d{7,10}$/.test(part) ? Number(part) : NaN;
			if (!isFinite(id) || id < 1000000) { invalid.push(part); } else if (ids.indexOf(id) < 0) { ids.push(id); }
		});
		return { ids: ids, invalid: invalid };
	},

	/** K-space as the server sees it: no wormhole class, outside the wormhole regions */
	isKSpace: function(system) {
		return !!system && !system.class && (Number(system.regionID) || 0) < 11000000;
	},

	/** Add a ping system by ID or name. @return {list, error} */
	addPingSystem: function(list, value, systems, findByName) {
		list = (list || []).slice();
		const text = String(value === undefined || value === null ? "" : value).trim();
		if (!text) { return { list: list, error: "Type a system name" }; }
		let id = /^\d+$/.test(text) ? Number(text) : (findByName ? findByName(text) : null);
		const system = id ? (systems || {})[id] : null;
		if (!system) { return { list: list, error: "Unknown system \"" + text + "\"" }; }
		if (!discordNotifications.isKSpace(system)) { return { list: list, error: system.name + " is not k-space" }; }
		id = Number(id);
		if (list.indexOf(id) >= 0) { return { list: list, error: system.name + " is already in the list" }; }
		if (list.length >= discordNotifications.MAX_PING_SYSTEMS) { return { list: list, error: "At most " + discordNotifications.MAX_PING_SYSTEMS + " ping systems" }; }
		list.push(id);
		return { list: list, error: null };
	},

	removePingSystem: function(list, id) {
		return (list || []).filter(function(x) { return Number(x) !== Number(id); });
	},

	/** "3 min ago" style age of an ISO time */
	ago: function(iso, now) {
		if (!iso) { return ""; }
		const seconds = Math.max(0, Math.round(((now || Date.now()) - Date.parse(iso)) / 1000));
		if (seconds < 90) { return seconds + " s ago"; }
		if (seconds < 5400) { return Math.round(seconds / 60) + " min ago"; }
		if (seconds < 129600) { return Math.round(seconds / 3600) + " h ago"; }
		return Math.round(seconds / 86400) + " days ago";
	},

	/** Status of a webhook for the table: {text, cls, title} */
	webhookStatus: function(webhook, now) {
		if (webhook.status === "broken") {
			return { text: "Broken", cls: "dn-bad", title: (webhook.statusMessage || "Discord refused this webhook") + ". Replace the URL to use it again." };
		}
		if (webhook.status === "pending") {
			return { text: "Not verified yet", cls: "", title: "New or replaced URL: it counts as working once Discord accepts a message. Send a test message to check it." };
		}
		if (webhook.lastSentAt) {
			return { text: "OK", cls: "dn-good", title: "Last message " + discordNotifications.ago(webhook.lastSentAt, now) };
		}
		return { text: "OK", cls: "dn-good", title: "Discord accepted a message" };
	},

	/**
	 * Whether the page is offered for a mask entry of init.masks (same rule as the server, which checks again): the
	 * corporation mask or a corporation-owned custom mask, and the user is a Tripwire admin of the corporation.
	 * Personal custom masks, Private, Public and alliance masks never.
	 */
	maskAllowed: function(mask) {
		if (!mask || !mask.admin) { return false; }
		const id = String(mask.mask === undefined || mask.mask === null ? "" : mask.mask);
		if (/^[1-9]\d*\.2$/.test(id)) { return true; }
		return /^[1-9]\d*\.0$/.test(id) && mask.ownerType === "corporation";
	},

	/** Banner text for open circuit breakers of this mask: [{scope: 'mask'|'webhook', webhookID, until}] */
	pausedText: function(paused, webhooks, now) {
		return (paused || []).map(function(p) {
			const minutes = Math.max(1, Math.round((Date.parse(p.until) - (now || Date.now())) / 60000));
			const w = (webhooks || []).filter(function(x) { return x.id === p.webhookID; })[0];
			const what = p.scope === "mask" ? "All Discord messages of this mask are"
				: p.scope === "corp" ? "All Discord messages of your corporation's masks are"
				: "Messages to " + (w ? w.name : "a webhook") + " are";
			return what + " paused for about " + minutes + " min: Discord refused too many requests. Check the webhooks below.";
		});
	},

	/** <option>s of the webhook pickers */
	webhookOptionsHtml: function(webhooks, selected) {
		const esc = discordNotifications.escape;
		return "<option value='0'>(choose a webhook)</option>" + (webhooks || []).map(function(w) {
			return "<option value='" + Number(w.id) + "'" + (Number(selected) === Number(w.id) ? " selected" : "") + ">"
				+ esc(w.name) + (w.status === "broken" ? " (broken)" : "") + "</option>";
		}).join("");
	},

	/**
	 * Settings for the server from what the form holds. values: {types: {<kind>: {enabled, webhookID, template,
	 * ping, ...}}, corporations: "text", alliances: "text"}. @return {settings, errors}
	 */
	collectSettings: function(values) {
		const dn = discordNotifications;
		const errors = [];
		const settings = { types: {} };
		dn.KINDS.forEach(function(kind) {
			const v = (values.types || {})[kind] || {};
			const type = {
				enabled: !!v.enabled,
				webhookID: Number(v.webhookID) || 0,
				template: String(v.template || "").trim(),
				ping: String(v.ping || "").trim().replace(/\s+/g, " ")
			};
			if (!dn.isValidPing(type.ping)) { errors.push(dn.LABELS[kind] + ": the ping field takes only <@&roleID>, <@userID>, @here or @everyone"); }
			if (type.enabled && !type.webhookID) { errors.push(dn.LABELS[kind] + ": choose a webhook to turn it on"); }
			if (kind === "rally") {
				type.templateClear = String(v.templateClear || "").trim();
			} else if (kind === "kspace") {
				type.pingSystems = (v.pingSystems || []).map(Number);
				type.maxJumps = Math.max(1, Math.min(50, parseInt(v.maxJumps, 10) || 10));
				type.cooldownHours = Math.max(1, Math.min(48, parseInt(v.cooldownHours, 10) || 6));
				if (type.enabled && !type.pingSystems.length) { errors.push(dn.LABELS[kind] + ": add at least one ping system"); }
			} else {
				const isk = Number(String(v.minIsk === undefined ? "" : v.minIsk).replace(/[\s,]/g, "")) || 0;
				type.minIsk = Math.max(0, isk);
				type.includeNpc = !!v.includeNpc;
				type.excludePods = !!v.excludePods;
				if (kind === "chainKill") { type.includeHighsec = !!v.includeHighsec; }
			}
			settings.types[kind] = type;
		});
		const corps = dn.parseIdList(values.corporations);
		const alliances = dn.parseIdList(values.alliances);
		if (corps.invalid.length || alliances.invalid.length) { errors.push("Corporation/alliance IDs must be numbers: " + corps.invalid.concat(alliances.invalid).join(", ")); }
		settings.corporations = corps.ids;
		settings.alliances = alliances.ids;
		if ((settings.types.corpKill.enabled || settings.types.corpLoss.enabled) && !corps.ids.length && !alliances.ids.length) {
			errors.push("Corporation kills/losses need at least one corporation or alliance ID");
		}
		return { settings: settings, errors: errors };
	},

	/** The server's preview (a webhook payload) as safe HTML, roughly how Discord shows it */
	previewHtml: function(payload) {
		// Discord markdown, roughly: **bold** and backslash escapes; everything HTML-escaped first
		const esc = function(text) {
			return discordNotifications.escape(text)
				.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
				.replace(/\\([^A-Za-z0-9\s])/g, "$1");
		};
		if (!payload) { return ""; }
		const embed = (payload.embeds || [])[0] || null;
		const colour = "#" + ("000000" + (Number(embed && embed.color) || 0).toString(16)).slice(-6);
		const mentions = payload.allowed_mentions || {};
		const pings = [].concat((mentions.parse || []).indexOf("everyone") >= 0 ? ["@here/@everyone"] : [],
			(mentions.roles || []).map(function(r) { return "role " + r; }), (mentions.users || []).map(function(u) { return "user " + u; }));
		return "<div class='dn-preview-msg'>"
			+ "<div class='dn-preview-content'>" + esc(payload.content || "").replace(/\n/g, "<br/>") + "</div>"
			+ (embed ? "<div class='dn-preview-embed' style='border-left-color: " + colour + "'>"
			+ (embed.title ? "<div class='dn-preview-title'>" + esc(embed.title) + "</div>" : "")
			+ (embed.description ? "<div>" + esc(embed.description) + "</div>" : "")
			+ (embed.fields || []).map(function(f) {
				return "<div class='dn-preview-field" + (f.inline ? " inline" : "") + "'><b>" + esc(f.name) + "</b><br/>" + esc(f.value).replace(/\n/g, "<br/>") + "</div>";
			}).join("")
			+ (embed.footer ? "<div class='dn-preview-footer'>" + esc(embed.footer.text) + "</div>" : "")
			+ "</div>" : "")
			+ "<div class='dn-preview-pings'>Pings: " + (pings.length ? esc(pings.join(", ")) : "nobody") + "</div>"
			+ "</div>";
	},

	// ---- Server ----

	load: function() {
		return $.ajax({ url: discordNotifications.URL, type: "GET", data: { mode: "get" }, dataType: "JSON", cache: false });
	},

	request: function(mode, data) {
		return $.ajax({
			url: discordNotifications.URL,
			type: "POST",
			contentType: "application/json",
			dataType: "JSON",
			data: JSON.stringify(Object.assign({ mode: mode }, data || {})),
			headers: { "X-CSRF-Token": discordNotifications.csrf, "X-Requested-With": "XMLHttpRequest" }
		});
	},

	errorText: function(xhr) {
		if (xhr && xhr.status === 403) { return (xhr.responseJSON && xhr.responseJSON.error) || "Only your corporation's Tripwire admins can change Discord notifications."; }
		return (xhr && xhr.responseJSON && xhr.responseJSON.error) || "Request failed" + (xhr && xhr.status ? " (HTTP " + xhr.status + ")" : "");
	},

	// ---- Page ----

	systemName: function(id) {
		const systems = (typeof appData !== "undefined" && appData.systems) || {};
		return systems[id] ? systems[id].name : String(id);
	},

	pageHtml: function(state, settings) {
		const dn = discordNotifications;
		const esc = dn.escape;
		const now = Date.now();
		const webhooks = state.webhooks || [];
		const names = state.names || {};
		const placeholders = state.placeholders || {};

		const webhookRows = webhooks.map(function(w) {
			const status = dn.webhookStatus(w, now);
			return "<tr data-webhook='" + Number(w.id) + "'>"
				+ "<td class='dn-name'>" + esc(w.name) + "</td>"
				+ "<td class='dn-hint' title='The URL is stored on the server and never shown again'>" + esc(w.hint) + "</td>"
				+ "<td><span class='dn-status " + status.cls + "' title='" + esc(status.title) + "'>" + esc(status.text) + "</span>"
				+ (w.status === "broken" && w.statusMessage ? "<div class='dn-small dn-bad'>" + esc(w.statusMessage) + "</div>" : "") + "</td>"
				+ "<td class='dn-actions'><button type='button' class='dn-test'" + (w.status === "broken" ? " disabled" : "") + ">Send test</button>"
				+ "<button type='button' class='dn-edit'>Replace</button><button type='button' class='dn-delete'>Delete</button>"
				+ "<span class='dn-test-result dn-small'></span></td>"
				+ "</tr>";
		}).join("") || "<tr><td colspan='4' class='dn-small'>No webhooks yet. In Discord: channel settings &gt; Integrations &gt; Webhooks &gt; New Webhook &gt; Copy Webhook URL.</td></tr>";

		const typeHtml = dn.KINDS.map(function(kind) {
			const t = settings.types[kind];
			const help = Object.keys(placeholders[kind] || {}).map(function(p) {
				return "<code title='" + esc(placeholders[kind][p]) + "'>{" + esc(p) + "}</code>";
			}).join(" ");
			let extra = "";
			let templateLabel = "Message:";
			let after = "";
			if (kind === "rally") {
				templateLabel = "Set or moved:";
				after = "<tr><th>Cleared:</th><td><textarea class='dn-templateClear' rows='1'>" + esc(t.templateClear) + "</textarea>"
						+ "<div class='dn-small'>The system placeholders (<code>{system}</code>, <code>{label}</code>, <code>{labelSystem}</code>, <code>{was}</code>...) are the system the rally was on, when it is known; otherwise only <code>{pings}</code> <code>{mask}</code> <code>{who}</code> are filled.</div></td></tr>";
				if (state.legacyRally && !t.enabled) { extra = "<tr><th></th><td><div class='dn-small dn-legacy'>" + esc(dn.LEGACY_RALLY) + "</div></td></tr>"; }
			} else if (kind === "kspace") {
				const chips = (t.pingSystems || []).map(function(id) {
					return "<span class='dn-chip' data-system='" + Number(id) + "'>" + esc(dn.systemName(id))
						+ " <a href='#' class='dn-chip-remove' title='Remove'>&times;</a></span>";
				}).join("") || "<span class='dn-small dn-bad'>No ping systems</span>";
				extra = "<tr><th>Ping systems:</th><td><div class='dn-chips'>" + chips + "</div>"
					+ "<form class='dn-add-system' autocomplete='off'><input type='text' class='dn-system-search' placeholder='Add a system, e.g. Dodixie' /> <input type='submit' value='Add' /></form></td></tr>"
					+ "<tr><th>Range:</th><td>fewer than <input type='number' class='dn-maxJumps' min='1' max='50' value='" + Number(t.maxJumps) + "' /> safe gate jumps"
					+ "<div class='dn-small'>" + esc(dn.SAFE_RULE) + "</div></td></tr>"
					+ "<tr><th>Repeat:</th><td>at most once per system every <input type='number' class='dn-cooldownHours' min='1' max='48' value='" + Number(t.cooldownHours) + "' /> hours</td></tr>";
			} else {
				extra = "<tr><th>Filters:</th><td>at least <input type='text' class='dn-minIsk' size='12' value='" + esc(t.minIsk || 0) + "' /> ISK"
					+ " <label><input type='checkbox' class='dn-includeNpc'" + (t.includeNpc ? " checked" : "") + " /> include NPC kills</label>"
					+ " <label><input type='checkbox' class='dn-excludePods'" + (t.excludePods ? " checked" : "") + " /> skip pods</label>"
					+ (kind === "chainKill" ? " <label title='Off: kills in high-sec systems on the chain (e.g. ganks in a trade hub) are not posted'><input type='checkbox' class='dn-includeHighsec'"
						+ (t.includeHighsec ? " checked" : "") + " /> include high-sec systems</label>" : "")
					+ "</td></tr>";
			}
			return "<fieldset class='dn-type' data-kind='" + kind + "'>"
				+ "<legend><label><input type='checkbox' class='dn-enabled'" + (t.enabled ? " checked" : "") + " /> " + esc(dn.LABELS[kind]) + "</label></legend>"
				+ "<div class='dn-small'>" + esc(dn.HELP[kind]) + "</div>"
				+ "<table class='dn-form'>"
				+ "<tr><th>Channel:</th><td><select class='dn-webhook'>" + dn.webhookOptionsHtml(webhooks, t.webhookID) + "</select></td></tr>"
				+ "<tr><th>Ping:</th><td><input type='text' class='dn-ping' size='40' value='" + esc(t.ping) + "' placeholder='e.g. <@&123456789012345678> or @here (empty = nobody)' /></td></tr>"
				+ extra
				+ "<tr><th>" + templateLabel + "</th><td><textarea class='dn-template' rows='2'>" + esc(t.template) + "</textarea>"
				+ (after ? "</td></tr>" + after + "<tr><th></th><td>" : "")
				+ "<div class='dn-small'>Placeholders: " + help + " &middot; <a href='#' class='dn-reset-template'>default text</a> &middot; <a href='#' class='dn-preview-button'>preview</a></div>"
				+ "<div class='dn-preview'></div></td></tr>"
				+ "</table></fieldset>";
		}).join("");

		const entityNames = function(ids) {
			return (ids || []).map(function(id) { return names[id] ? esc(names[id]) + " (" + Number(id) + ")" : String(Number(id)); }).join(", ");
		};
		const outbox = state.outbox || {};
		const failures = (outbox.failures || []).map(function(f) {
			return "<li>" + esc(dn.LABELS[f.kind] || f.kind) + (f.webhook ? " to " + esc(f.webhook) : "") + ", " + esc(dn.ago(f.createdAt, now)) + ": " + esc(f.error) + "</li>";
		}).join("");

		return "<div class='dn-page'>"
			+ "<h2>Discord notifications for the " + esc(state.mask ? state.mask.name : "") + " mask</h2>"
			+ "<p class='dn-small'>Only your corporation's Tripwire admins see this page. Nothing is posted until you add a webhook, pick it for a notification and turn the notification on.</p>"
			+ dn.pausedText(outbox.paused, webhooks, now).map(function(t) { return "<p class='dn-bad'>" + esc(t) + "</p>"; }).join("")
			+ (state.encrypted ? "" : "<p class='dn-small dn-bad'>Webhook URLs are stored unencrypted on this server (DISCORD_SECRET_KEY is not set). They are still never shown again.</p>")
			+ "<h3>Webhooks (one per channel)</h3>"
			+ "<table class='dn-webhooks'><thead><tr><th>Name</th><th>URL</th><th>Status</th><th></th></tr></thead><tbody>" + webhookRows + "</tbody></table>"
			+ "<form class='dn-webhook-form' autocomplete='off'><input type='hidden' class='dn-webhook-id' value='' />"
			+ "<input type='text' class='dn-webhook-name' placeholder='Channel name, e.g. #intel' size='18' maxlength='60' /> "
			+ "<input type='password' class='dn-webhook-url' placeholder='https://discord.com/api/webhooks/...' size='42' autocomplete='new-password' /> "
			+ "<input type='submit' class='dn-webhook-save' value='Add webhook' /> <a href='#' class='dn-webhook-cancel' style='display:none'>cancel</a>"
			+ "<div class='dn-small dn-webhook-message'></div></form>"
			+ "<h3>Notifications</h3>"
			+ typeHtml
			+ "<fieldset class='dn-entities'><legend>Our side (for corporation kills and losses)</legend>"
			+ "<table class='dn-form'><tr><th>Corporation IDs:</th><td><input type='text' class='dn-corporations' size='40' value='" + esc((settings.corporations || []).join(", ")) + "' />"
			+ "<div class='dn-small'>" + entityNames(settings.corporations) + "</div></td></tr>"
			+ "<tr><th>Alliance IDs:</th><td><input type='text' class='dn-alliances' size='40' value='" + esc((settings.alliances || []).join(", ")) + "' />"
			+ "<div class='dn-small'>" + entityNames(settings.alliances) + "</div></td></tr></table></fieldset>"
			+ "<div class='dn-save-row'><button type='button' class='dn-save'>Save notifications</button> <span class='dn-save-message dn-small'></span></div>"
			+ "<h3>Delivery</h3>"
			+ "<p class='dn-small'>Waiting: " + Number(outbox.queued || 0) + " &middot; sent in the last 24 h: " + Number(outbox.sent24h || 0)
			+ " &middot; failed in the last 24 h: " + Number(outbox.failed24h || 0) + "</p>"
			+ (failures ? "<ul class='dn-failures dn-small'>" + failures + "</ul>" : "")
			+ "</div>";
	},

	/** Everything the notification part of the form holds */
	readForm: function() {
		const $page = $("#dialog-admin .dn-page");
		const values = { types: {}, corporations: $page.find(".dn-corporations").val(), alliances: $page.find(".dn-alliances").val() };
		$page.find(".dn-type").each(function() {
			const $t = $(this);
			const kind = $t.attr("data-kind");
			values.types[kind] = {
				enabled: $t.find(".dn-enabled").prop("checked"),
				webhookID: $t.find(".dn-webhook").val(),
				template: $t.find(".dn-template").val(),
				templateClear: $t.find(".dn-templateClear").val(),
				ping: $t.find(".dn-ping").val(),
				pingSystems: $t.find(".dn-chip").map(function() { return Number($(this).attr("data-system")); }).get(),
				maxJumps: $t.find(".dn-maxJumps").val(),
				cooldownHours: $t.find(".dn-cooldownHours").val(),
				minIsk: $t.find(".dn-minIsk").val(),
				includeNpc: $t.find(".dn-includeNpc").prop("checked"),
				excludePods: $t.find(".dn-excludePods").prop("checked"),
				includeHighsec: $t.find(".dn-includeHighsec").prop("checked")
			};
		});
		return values;
	},

	/** Keep unsaved edits when the page is redrawn (after a webhook change) */
	keepDraft: function() {
		if (!$("#dialog-admin .dn-page").length) { return; }
		discordNotifications.draft = discordNotifications.collectSettings(discordNotifications.readForm()).settings;
	},

	render: function() {
		const dn = discordNotifications;
		const $window = $("#dialog-admin .window [data-window='discord']");
		if (!dn.state) { return; }
		$window.html(dn.pageHtml(dn.state, dn.draft || dn.state.settings));
		if ($.fn.inlinecomplete) {
			const source = {};
			const systems = (typeof appData !== "undefined" && appData.systems) || {};
			for (const id in systems) { if (dn.isKSpace(systems[id])) { source[id] = systems[id]; } }
			$window.find(".dn-system-search").inlinecomplete({ source: source, renderer: "system", maxSize: 10, delay: 0 });
		}
	},

	refresh: function(keepDraft) {
		const dn = discordNotifications;
		const $window = $("#dialog-admin .window [data-window='discord']");
		if (keepDraft) { dn.keepDraft(); } else { dn.draft = null; }
		if (!dn.state) { $window.html("<p class='dn-small'>Loading...</p>"); }
		return dn.load().done(function(data) {
			dn.state = data;
			dn.csrf = data.csrf || "";
			dn.render();
		}).fail(function(xhr) {
			dn.state = null;
			$window.html("<p class='dn-bad'>" + dn.escape(dn.errorText(xhr)) + "</p>");
		});
	},

	/** Follow a test message until it is sent or failed, then redraw (webhook status) and say how it went */
	pollTest: function(webhookID, messageID, tries) {
		const dn = discordNotifications;
		const result = function() { return $("#dialog-admin .dn-webhooks tr[data-webhook='" + Number(webhookID) + "'] .dn-test-result"); };
		$.ajax({ url: dn.URL, type: "GET", data: { mode: "status", id: messageID }, dataType: "JSON", cache: false }).done(function(data) {
			const m = data.message || {};
			if (m.status === "sent" || m.status === "failed") {
				dn.refresh(true).always(function() {
					if (m.status === "sent") { result().addClass("dn-good").text("Sent: check the channel"); } else { result().addClass("dn-bad").text("Failed: " + (m.error || "")); }
				});
				return;
			}
			result().text(m.error ? "Waiting: " + m.error : "Sending...");
			if (tries < 60) { setTimeout(function() { dn.pollTest(webhookID, messageID, tries + 1); }, 1000); }
		});
	},

	bind: function() {
		const dn = discordNotifications;
		const sel = "#dialog-admin .window [data-window='discord']";
		const $doc = $(document);
		const fail = function($target) { return function(xhr) { $target.addClass("dn-bad").text(dn.errorText(xhr)); }; };

		$doc.on("submit", sel + " .dn-webhook-form", function(e) {
			e.preventDefault();
			const $form = $(this);
			const $msg = $form.find(".dn-webhook-message").removeClass("dn-bad dn-good").text("");
			const id = Number($form.find(".dn-webhook-id").val()) || 0;
			const name = $.trim($form.find(".dn-webhook-name").val());
			const url = $.trim($form.find(".dn-webhook-url").val());
			if (!name) { $msg.addClass("dn-bad").text("Give the webhook a name, e.g. the channel"); return; }
			if ((!id || url) && !dn.isWebhookUrl(url)) { $msg.addClass("dn-bad").text("Paste a Discord webhook URL: https://discord.com/api/webhooks/<id>/<token>"); return; }
			dn.request(id ? "webhook-update" : "webhook-add", { id: id, name: name, url: url }).done(function(data) {
				dn.keepDraft();
				dn.state = data;
				dn.csrf = data.csrf || dn.csrf;
				dn.render();
				$(sel + " .dn-webhook-message").addClass("dn-good").text(id ? "Webhook updated." : "Webhook added. The URL is stored and won't be shown again; send a test message to check it.");
			}).fail(fail($msg));
		});
		$doc.on("click", sel + " .dn-edit", function(e) {
			e.preventDefault();
			const id = Number($(this).closest("tr").attr("data-webhook"));
			const w = (dn.state.webhooks || []).filter(function(x) { return x.id === id; })[0];
			if (!w) { return; }
			const $form = $(sel + " .dn-webhook-form");
			$form.find(".dn-webhook-id").val(id);
			$form.find(".dn-webhook-name").val(w.name);
			$form.find(".dn-webhook-url").val("").attr("placeholder", "New URL (empty = keep " + w.hint + ")");
			$form.find(".dn-webhook-save").val("Save webhook");
			$form.find(".dn-webhook-cancel").show();
		});
		$doc.on("click", sel + " .dn-webhook-cancel", function(e) { e.preventDefault(); dn.refresh(true); });
		$doc.on("click", sel + " .dn-delete", function(e) {
			e.preventDefault();
			const $row = $(this).closest("tr");
			const id = Number($row.attr("data-webhook"));
			if (!window.confirm("Delete the webhook \"" + $row.find(".dn-name").text() + "\"? Notifications that post to it are turned off.")) { return; }
			dn.request("webhook-delete", { id: id }).done(function(data) {
				dn.keepDraft();
				if (dn.draft) { dn.KINDS.forEach(function(k) { if (dn.draft.types[k].webhookID === id) { dn.draft.types[k].webhookID = 0; dn.draft.types[k].enabled = false; } }); }
				dn.state = data;
				dn.render();
			}).fail(fail($row.find(".dn-test-result")));
		});
		$doc.on("click", sel + " .dn-test", function(e) {
			e.preventDefault();
			const $row = $(this).closest("tr");
			const $result = $row.find(".dn-test-result").removeClass("dn-bad dn-good").text("Queued...");
			dn.request("webhook-test", { id: Number($row.attr("data-webhook")) }).done(function(data) {
				dn.pollTest(Number($row.attr("data-webhook")), data.messageID, 0);
			}).fail(fail($result));
		});
		$doc.on("submit", sel + " .dn-add-system", function(e) {
			e.preventDefault();
			const $form = $(this);
			const $input = $form.find(".dn-system-search");
			const $chips = $form.closest("td").find(".dn-chips");
			const current = $chips.find(".dn-chip").map(function() { return Number($(this).attr("data-system")); }).get();
			const find = typeof routeDestinations !== "undefined" ? routeDestinations.findByName : null;
			const result = dn.addPingSystem(current, $input.val(), (typeof appData !== "undefined" && appData.systems) || {}, find);
			if (result.error) {
				$form.find(".dn-add-error").remove();
				$form.append("<span class='dn-add-error dn-small dn-bad'> " + dn.escape(result.error) + "</span>");
				return;
			}
			$input.val("");
			$form.find(".dn-add-error").remove();
			dn.keepDraft();
			dn.draft.types.kspace.pingSystems = result.list;
			dn.render();
		});
		$doc.on("click", sel + " .dn-chip-remove", function(e) {
			e.preventDefault();
			const id = Number($(this).closest(".dn-chip").attr("data-system"));
			dn.keepDraft();
			dn.draft.types.kspace.pingSystems = dn.removePingSystem(dn.draft.types.kspace.pingSystems, id);
			dn.render();
		});
		$doc.on("click", sel + " .dn-reset-template", function(e) {
			e.preventDefault();
			const kind = $(this).closest(".dn-type").attr("data-kind");
			const templates = (dn.state.defaults || {}).templates || {};
			$(this).closest(".dn-type").find(".dn-template").val(templates[kind] || "");
			$(this).closest(".dn-type").find(".dn-templateClear").val(templates[kind + "Clear"] || "");
		});
		$doc.on("click", sel + " .dn-preview-button", function(e) {
			e.preventDefault();
			const $type = $(this).closest(".dn-type");
			const $preview = $type.find(".dn-preview").removeClass("dn-bad").text("...");
			dn.request("preview", { kind: $type.attr("data-kind"), template: $type.find(".dn-template").val(), templateClear: $type.find(".dn-templateClear").val(), ping: $type.find(".dn-ping").val() })
				.done(function(data) { $preview.html(dn.previewHtml(data.preview) + (data.previewClear ? dn.previewHtml(data.previewClear) : "")); })
				.fail(fail($preview));
		});
		$doc.on("click", sel + " .dn-save", function(e) {
			e.preventDefault();
			const $msg = $(sel + " .dn-save-message").removeClass("dn-bad dn-good").text("");
			const result = dn.collectSettings(dn.readForm());
			if (result.errors.length) { $msg.addClass("dn-bad").text(result.errors.join(" ")); return; }
			dn.request("settings-save", { settings: result.settings }).done(function(data) {
				dn.draft = null;
				dn.state = data;
				dn.render();
				$(sel + " .dn-save-message").addClass("dn-good").text("Saved.");
			}).fail(fail($msg));
		});
	},

	init: function() {
		const dn = discordNotifications;
		const $dialog = $("#dialog-admin");
		// Only where Mask Admin is offered (admins/owners of the current mask); the server checks again anyway
		if (!$dialog.length || !$("#admin").length || $("#admin").css("display") === "none") { return; }
		// Not for the Public and Private masks (the server refuses them too)
		const active = (typeof init !== "undefined" && init && Array.isArray(init.masks) ? init.masks.filter(function(m) { return m.active; })[0] : null);
		if (!dn.maskAllowed(active)) { return; }
		if (!$dialog.find(".menu li[data-window='discord']").length) {
			$dialog.find(".menu ul").append("<li data-window='discord'><a href='#'>Discord</a></li>");
			$dialog.find(".window").append("<div data-window='discord' class='hidden'></div>");
		}
		dn.bind();
		// Upstream's menu handler shows the window (and asks admin.php, which has nothing for it); load the page
		$(document).on("click", "#dialog-admin .menu li", function() {
			const discord = $(this).attr("data-window") === "discord";
			const $d = $("#dialog-admin");
			if (!$d.hasClass("ui-dialog-content")) { return; }
			$d.closest(".ui-dialog").toggleClass("dn-active", discord);	// hides the "Total: n" tray
			if (discord) {
				$d.dialog("option", "height", Math.min(720, Math.max(350, $(window).height() - 40)));
				dn.refresh(false);
			} else if ($d.dialog("option", "height") !== 350) {
				$d.dialog("option", "height", 350);
			}
		});
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { discordNotifications.init(); });
}
