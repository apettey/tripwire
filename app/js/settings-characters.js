// Characters, on the Account tab.
//
// An account can hold several EVE characters -- a main and a scout alt --
// and the one marked active drives the map. Adding and removing them lived
// only in the dropdown under the header portrait, which is not where anyone
// looks for account management. This lists them where Settings > Account
// is, with the same three actions the dropdown has, wired to the same code:
// add goes through SSO with login=esi; remove queues the id on
// tripwire.data.esiDelete for the next refresh, exactly as tracking.js does;
// set-active triggers the dropdown row's own click handler so the two views
// cannot disagree.

tripwire.settingsCharacters = (function() {
	function ownerID() {
		return options.character && options.character.id || null;
	}

	function render() {
		var $list = $("#dialog-options #characters");
		if (!$list.length) { return; }
		var chars = tripwire.esi && tripwire.esi.characters || {};
		var ids = Object.keys(chars);
		var active = String(options.tracking && options.tracking.active || "");
		$list.empty();

		if (!ids.length) {
			var owner = ownerID();
			$list.append(
				$('<div class="char-row is-owner"></div>')
					.append(owner ? $('<img class="char-portrait" alt="" />').attr("src", "https://images.evetech.net/characters/" + owner + "/portrait?size=128") : "")
					.append($('<div class="char-meta"></div>')
						.append($('<div class="char-name"></div>').text($("#user-no-track").text() || "Signed in"))
						.append($('<div class="char-note"></div>').text("No characters tracked yet. Add one to follow it on the map.")))
			);
			return;
		}

		ids.forEach(function(id) {
			var c = chars[id];
			var isActive = String(id) === active;
			var $row = $('<div class="char-row tracking-clone"></div>').attr("data-characterid", id).toggleClass("active", isActive);
			$row.append($('<img class="char-portrait" alt="" />').attr("src", "https://images.evetech.net/characters/" + id + "/portrait?size=128"));
			var $meta = $('<div class="char-meta"></div>')
				.append($('<div class="char-name"></div>').text(c.characterName || id))
				.append($('<div class="char-note"></div>').text(isActive ? "Active. The map follows this character." : "Tracked"));
			$row.append($meta);
			var $acts = $('<div class="char-actions"></div>');
			if (!isActive) {
				$('<button type="button" class="char-btn ui-button ui-widget"></button>').text("Set active")
					.on("click", function() {
						// The dropdown row's own handler does the work.
						$("#tracking .tracking-clone[data-characterid='" + id + "']").trigger("click");
						render();
					}).appendTo($acts);
			}
			$('<button type="button" class="char-btn is-destructive ui-button ui-widget"></button>').text("Remove")
				.on("click", function() { remove(id); })
				.appendTo($acts);
			$row.append($acts);
			$list.append($row);
		});
	}

	function remove(id) {
		if (String(options.tracking.active) === String(id)) {
			options.tracking.active = null;
			tripwire.EVE(false, true);
			options.save();
			$("#removeESI").attr("disabled", "disabled");
		}
		if (typeof tracking !== "undefined" && tracking.remove) { tracking.remove(id); }
		// tracking.js tests `esi.delete` but pushes to `esiDelete`; the
		// refresh reads `esiDelete`. Guard the one that is read.
		if ($.isArray(tripwire.data.esiDelete)) { tripwire.data.esiDelete.push(id); } else { tripwire.data.esiDelete = [id]; }
		if (typeof set_tracking_text === "function") { set_tracking_text(); }
		$("#dialog-options #characters .char-row[data-characterid='" + id + "']").remove();
		if (!$("#dialog-options #characters .char-row").length) { render(); }
	}

	$(function() {
		$(document).on("click", "#addESI", function(e) {
			e.preventDefault();
			window.location.href = "login.php?mode=sso&login=esi";
		});
	});

	return {render: render, remove: remove};
})();
