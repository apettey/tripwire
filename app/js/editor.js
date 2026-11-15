// Minimal rich-text editor for system notes.
//
// Replaces CKEditor 4, which reached end of life in June 2023 -- its security
// fixes are commercial-only now -- and shipped 1.3MB for a toolbar of eight
// buttons.
//
// The API deliberately mirrors the three CKEditor calls comments.js actually
// used (replace, getData, destroy), so the integration barely changes.
//
// Output is constrained to the tags app/js/sanitise-html.js allows, so what an
// author writes is what survives rendering. Nothing here trusts that by
// itself: content is still sanitised on the way back out.

tripwire.editor = (function() {
	var instances = {};

	// execCommand is formally deprecated but is the only broadly supported way
	// to do this without a large dependency, which is the thing being removed.
	// Every command below is one of the stable, universally implemented set.
	var TOOLS = [
		{cmd: "bold",              label: "B",  title: "Bold",          style: "font-weight:700"},
		{cmd: "italic",            label: "I",  title: "Italic",        style: "font-style:italic"},
		{cmd: "underline",         label: "U",  title: "Underline",     style: "text-decoration:underline"},
		{cmd: "strikeThrough",     label: "S",  title: "Strikethrough", style: "text-decoration:line-through"},
		{sep: true},
		{cmd: "fontSize", args: 1, label: "A", title: "Smallest text", style: "font-size: 80%"},
		{cmd: "fontSize", args: 2, label: "-", title: "X-Small text", style: "min-width: auto; padding: 0 1px"},
		{cmd: "fontSize", args: 3, label: "-", title: "Small text", style: "min-width: auto; padding: 0 1px"},
		{cmd: "fontSize", args: 4, label: "A", title: "Normal text", style: "font-size: 100%"},
		{cmd: "fontSize", args: 5, label: "-", title: "Large text", style: "min-width: auto; padding: 0 1px"},
		{cmd: "fontSize", args: 6, label: "-", title: "X-Large text", style: "min-width: auto; padding: 0 1px"},
		{cmd: "fontSize", args: 7, label: "A", title: "Largest text", style: "font-size: 125%"},
		{sep: true},
		{cmd: "insertUnorderedList", label: "•", title: "Bulleted list"},
		{cmd: "insertOrderedList",   label: "1.", title: "Numbered list"},
		{sep: true},
		{cmd: "createLink",        label: "🔗", title: "Link"},
		{cmd: "unlink",            label: "⛓", title: "Remove link"}
	];

	// The colours notes actually use: the brand accent and the data semantics,
	// so a note can mark something critical in the same red the map uses.
	var COLOURS = ["--foreground", "--primary", "--data-critical", "--data-warn", "--data-good", "--data-info"];

	function resolve(token) {
		return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
	}

	function build($host, id) {
		var $wrap = $('<div class="rte"></div>');
		var $bar = $('<div class="rte-bar" role="toolbar"></div>').appendTo($wrap);

		TOOLS.forEach(function(t) {
			if (t.sep) { $('<span class="rte-sep"></span>').appendTo($bar); return; }
			$('<button type="button" class="rte-btn"></button>')
				.attr("title", t.title)
				.attr("data-cmd", t.cmd)
				.attr("style", t.style || "")
				.text(t.label)
				// mousedown, not click: the selection is still live before focus moves.
				.on("mousedown", function(e) {
					e.preventDefault();
					if (t.cmd === "createLink") {
						var url = window.prompt("Link URL");
						if (!url) { return; }
						if (!/^(https?:|mailto:|\/|#)/i.test(url)) { url = "https://" + url; }
						document.execCommand("createLink", false, url);
					} else {
						document.execCommand(t.cmd, false, t.args);
					}
				})
				.appendTo($bar);
		});

		$('<span class="rte-sep"></span>').appendTo($bar);
		COLOURS.forEach(function(token) {
			var colour = resolve(token) || "#ccc";
			$('<button type="button" class="rte-swatch"></button>')
				.attr("title", "Text colour")
				.css("background", colour)
				.on("mousedown", function(e) {
					e.preventDefault();
					document.execCommand("foreColor", false, colour);
				})
				.appendTo($bar);
		});

		var $area = $('<div class="rte-area" contenteditable="true"></div>')
			.attr("id", id + "-rte")
			.html($host.html());

		// Sanitise the node after pasting, so the user sees what will actually end up in the comment
		$area.on("paste", function(e) {
			setTimeout(function() {
				$area.html(sanitiseHtml($area.html()));
			}, 0);
		});

		$wrap.append($area);
		$host.after($wrap).hide();
		return {$wrap: $wrap, $area: $area};
	}

	return {
		// CKEDITOR.replace(id, config) -> tripwire.editor.replace(id)
		replace: function(id, onReady) {
			var $host = $("#" + id);
			if (!$host.length) { return null; }
			var parts = build($host, id);
			instances[id] = {
				host: $host,
				wrap: parts.$wrap,
				area: parts.$area,
				getData: function() { return parts.$area.html(); },
				focus: function() { parts.$area.trigger("focus"); }
			};
			if (typeof onReady === "function") { setTimeout(function() { onReady(instances[id]); }, 0); }
			return instances[id];
		},

		instances: instances,

		get: function(id) { return instances[id]; },

		// CKEditor's destroy(true) discards edits; destroy(false) keeps them.
		destroy: function(id, discard) {
			var inst = instances[id];
			if (!inst) { return; }
			if (!discard) { inst.host.html(inst.getData()); }
			inst.wrap.remove();
			inst.host.show();
			delete instances[id];
		}
	};
})();
