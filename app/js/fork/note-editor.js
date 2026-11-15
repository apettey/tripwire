const noteEditor = (function() {
	// Fork-owned: the system note editor, replacing CKEditor 4 (changes/2026-11-15-note-security).
	// Ported from upstream Tripwire 2.0's app/js/editor.js (bitbucket daimian/tripwire a9c49177): CKEditor 4's open-source
	// line ended in June 2023 (4.22.1 was its last release; later security fixes are commercial-only) and the fork ran it
	// with its content filter off (allowedContent: true) and a Source button. This editor is a contenteditable box whose
	// content always comes from, and goes back through, the note sanitiser (app/js/fork/sanitise-html.js):
	//   - the note it opens with is sanitised first,
	//   - paste and drop never insert raw clipboard HTML: it is sanitised before it reaches the page,
	//   - getData() and destroy(id, false) hand back sanitised HTML (upstream put the raw editor HTML back into the page).
	// The server sanitises again on save and on every read (note-html.inc.php).
	//
	// API (as upstream's, which mirrored the three CKEditor calls comments.js used):
	//   noteEditor.replace(id, onReady) / .get(id) / .destroy(id, discard) / .instances; also tripwire.editor.
	//   noteEditor.onOpen(fn(element)) runs before the editor reads the note element (smart notes puts the stored note
	//   back), noteEditor.onClose(fn(element)) after it is gone.

	const instances = {};
	const openHooks = [];
	const closeHooks = [];

	// The toolbar CKEditor had here (B I U S, lists, indent, link, colours, size), minus Source / Font / Maximize
	const TOOLS = [
		{cmd: "bold", label: "B", title: "Bold (Ctrl+B)", cls: "rte-b"},
		{cmd: "italic", label: "I", title: "Italic (Ctrl+I)", cls: "rte-i"},
		{cmd: "underline", label: "U", title: "Underline (Ctrl+U)", cls: "rte-u"},
		{cmd: "strikeThrough", label: "S", title: "Strikethrough", cls: "rte-s"},
		{sep: true},
		{cmd: "insertUnorderedList", label: "•", title: "Bulleted list"},
		{cmd: "insertOrderedList", label: "1.", title: "Numbered list"},
		{cmd: "outdent", label: "⇤", title: "Decrease indent"},
		{cmd: "indent", label: "⇥", title: "Increase indent"},
		{sep: true},
		{cmd: "createLink", icon: "link", title: "Link (http, https or mailto)"},
		{cmd: "unlink", icon: "unlink", title: "Remove link"},
		{sep: true},
		{cmd: "fontSize", args: "2", label: "A", title: "Small text", cls: "rte-size-s"},
		{cmd: "fontSize", args: "3", label: "A", title: "Normal text", cls: "rte-size-m"},
		{cmd: "fontSize", args: "5", label: "A", title: "Large text", cls: "rte-size-l"},
		{cmd: "removeFormat", label: "×", title: "Clear formatting"}
	];
	// Text colours (red, orange, yellow, green, blue) and highlights; Clear formatting (x) takes them off again
	const COLOURS = [
		{value: "#ff4d4d", title: "Red text"}, {value: "#ff9900", title: "Orange text"}, {value: "#ffd700", title: "Yellow text"},
		{value: "#4cd964", title: "Green text"}, {value: "#4fa3ff", title: "Blue text"}
	];
	const HIGHLIGHTS = [
		{value: "#6b1d1d", title: "Red highlight"}, {value: "#6b5200", title: "Yellow highlight"}, {value: "#1d5b2a", title: "Green highlight"}
	];

	function clean(html) {
		return typeof sanitiseHtml === "function" ? sanitiseHtml(html == null ? "" : String(html)) : "";
	}

	/** A link typed into the Link prompt: https:// added when no scheme is given; null for anything unsafe */
	function safeLinkUrl(raw) {
		let url = String(raw == null ? "" : raw).replace(/[\x00-\x20\x7f]/g, "");
		if (!url) { return null; }
		if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[\/#]/.test(url)) { url = "https://" + url; }
		if (!/^(?:https?:\/\/[^\/\\]|mailto:[^\/])/i.test(url) && !/^\/(?![\/\\])|^#/.test(url)) { return null; }
		// The sanitiser has the last word (it also drops links to .php endpoints)
		const out = clean('<a href="' + url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") + '">x</a>');
		const m = /href="([^"]*)"/.exec(out);
		return m ? m[1].replace(/&amp;/g, "&") : null;
	}

	/** What a paste or drop puts into the note: sanitised HTML when the data has HTML, else the text escaped */
	function transferHtml(data) {
		if (!data || typeof data.getData !== "function") { return ""; }
		const html = data.getData("text/html");
		if (html) { return clean(html); }
		const text = data.getData("text/plain") || "";
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
	}

	function exec(cmd, args) {
		try { document.execCommand("styleWithCSS", false, cmd === "hiliteColor" || cmd === "backColor"); } catch (e) { /* older browsers */ }
		document.execCommand(cmd, false, args);
	}

	// Chain-link icons (fixed markup of our own, not note content)
	const CHAIN = '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>';
	const ICONS = {
		link: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' + CHAIN + '</svg>',
		unlink: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' + CHAIN + '<line x1="3" y1="3" x2="21" y2="21"/></svg>'
	};

	function button($bar, label, title, cls, onPress) {
		return $('<button type="button" class="rte-btn"></button>')
			.addClass(cls || "")
			.attr({title: title, "aria-label": title})
			.text(label)
			// mousedown, not click: the selection in the note is still there before focus moves
			.on("mousedown", function(e) { e.preventDefault(); onPress(); })
			.appendTo($bar);
	}

	function build($host, id) {
		const $wrap = $('<div class="rte"></div>');
		const $bar = $('<div class="rte-bar" role="toolbar" aria-label="Note formatting"></div>').appendTo($wrap);
		const $area = $('<div class="rte-area" contenteditable="true" role="textbox" aria-multiline="true"></div>').attr("id", id + "-rte");

		TOOLS.forEach(function(t) {
			if (t.sep) { $('<span class="rte-sep"></span>').appendTo($bar); return; }
			const $btn = button($bar, t.label || "", t.title, t.cls, function() {
				if (t.cmd === "createLink") {
					const url = safeLinkUrl(window.prompt("Link URL (http, https or mailto)"));
					if (url) { exec("createLink", url); }
					return;
				}
				exec(t.cmd, t.args);
			});
			if (t.icon) { $btn.html(ICONS[t.icon]); }
		});
		$('<span class="rte-sep"></span>').appendTo($bar);
		// Text colour and highlight: a button each that opens a row of swatches (as CKEditor's colour menus did)
		[{label: "A", title: "Text colour", cls: "rte-colour", cmd: "foreColor", swatches: COLOURS},
			{label: "A", title: "Highlight", cls: "rte-highlight", cmd: "hiliteColor", swatches: HIGHLIGHTS}].forEach(function(menu) {
			const $menu = $('<span class="rte-menu"></span>').appendTo($bar);
			const $pop = $('<span class="rte-pop" role="menu"></span>').attr("aria-label", menu.title).hide();
			button($menu, menu.label, menu.title, menu.cls, function() {
				const open = $pop.is(":visible");
				$bar.find(".rte-pop").hide();
				$pop.toggle(!open);
			});
			menu.swatches.forEach(function(c) {
				button($pop, "", c.title, "rte-swatch", function() { exec(menu.cmd, c.value); $pop.hide(); }).css("background", c.value);
			});
			$pop.appendTo($menu);
		});
		$area.on("mousedown keydown", function() { $bar.find(".rte-pop").hide(); });

		$area.html(clean($host.html()));

		// Clipboard and drag-and-drop HTML is sanitised before it touches the page (an <img onerror> in copied HTML would
		// otherwise run as soon as the browser inserted it)
		$area.on("paste", function(e) {
			const data = e.originalEvent && e.originalEvent.clipboardData;
			if (!data) { return; }
			e.preventDefault();
			const html = transferHtml(data);
			if (html) { exec("insertHTML", html); }
		});
		// A drag that starts in the note moves text within it: the browser does that itself (the content is already the
		// sanitised note), and inserting here as well would leave a copy behind
		let draggingInside = false;
		$area.on("dragstart", function() { draggingInside = true; });
		$area.on("dragend", function() { draggingInside = false; });
		$area.on("drop", function(e) {
			if (draggingInside) { draggingInside = false; return; }
			e.preventDefault();
			const data = e.originalEvent && e.originalEvent.dataTransfer;
			const html = transferHtml(data);
			if (!html) { return; }
			const ev = e.originalEvent;
			if (document.caretRangeFromPoint && ev) {
				const range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
				if (range) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
			}
			exec("insertHTML", html);
		});
		// Esc cancels, Alt+S saves (as with CKEditor)
		$area.on("keydown", function(e) {
			if (e.key === "Escape" || e.keyCode === 27) {
				e.preventDefault();
				$host.closest(".comment").find(".commentCancel").trigger("click");
			} else if (e.altKey && (e.key === "s" || e.key === "S" || e.keyCode === 83)) {
				e.preventDefault();
				$host.closest(".comment").find(".commentSave").trigger("click");
			}
		});

		$wrap.append($area);
		$host.after($wrap).hide();
		return {$wrap: $wrap, $area: $area};
	}

	function run(hooks, element) {
		hooks.forEach(function(fn) {
			try { fn(element); } catch (err) { console.error("Note editor hook failed", err); }
		});
	}

	/** Put the caret at the end of the note */
	function focusEnd(area) {
		area.focus();
		if (!window.getSelection || !document.createRange) { return; }
		const range = document.createRange();
		range.selectNodeContents(area);
		range.collapse(false);
		const sel = window.getSelection();
		sel.removeAllRanges();
		sel.addRange(range);
	}

	return {
		instances: instances,
		safeLinkUrl: safeLinkUrl,
		transferHtml: transferHtml,

		onOpen: function(fn) { openHooks.push(fn); },
		onClose: function(fn) { closeHooks.push(fn); },

		/** Open the editor in place of the note element `id`; onReady(instance) once it is in the page */
		replace: function(id, onReady) {
			if (instances[id]) { return instances[id]; }
			const $host = $(document.getElementById(id));
			if (!$host.length) { return null; }
			run(openHooks, $host[0]);
			const parts = build($host, id);
			const inst = instances[id] = {
				name: id,
				host: $host,
				wrap: parts.$wrap,
				area: parts.$area,
				getData: function() { return clean(parts.$area.html()); },
				focus: function() { focusEnd(parts.$area[0]); }
			};
			setTimeout(function() {
				if (instances[id] !== inst) { return; }
				inst.focus();
				if (typeof onReady === "function") { onReady(inst); }
			}, 0);
			return inst;
		},

		get: function(id) { return instances[id] || null; },

		/** Close the editor: discard true drops the edits, false writes them (sanitised) into the note element */
		destroy: function(id, discard) {
			const inst = instances[id];
			if (!inst) { return; }
			if (!discard) { inst.host.html(inst.getData()); }
			inst.wrap.remove();
			inst.host.show();
			delete instances[id];
			run(closeHooks, inst.host[0]);
		},

		/** Whether a note editor is open (anywhere, or inside `element`) */
		isOpen: function(element) {
			return Object.keys(instances).some(function(id) { return !element || $.contains(element, instances[id].wrap[0]); });
		}
	};
})();

if (typeof tripwire !== "undefined" && tripwire) { tripwire.editor = noteEditor; }
