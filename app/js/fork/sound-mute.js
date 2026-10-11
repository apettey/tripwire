const soundMute = {
	// Fork-owned: a speaker button next to Settings that silences every Tripwire sound with one click.
	// All sounds (kill reporting, watchlist alerts) are played by killReporting.play(), which is wrapped here.
	// Per-user settings in options.soundMute = {enabled (button shown), muted}. A missing key means the button
	// is shown and sound is on. Hiding the button (Settings > General) also unmutes, so nobody ends up muted
	// with no way to see it. The Settings "Test" buttons still play while muted: they are a deliberate click.

	/** Whether the button is shown (options.soundMute.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.soundMute && opts.soundMute.enabled === false);
	},

	/** Whether sounds are muted: only while the button is shown and options.soundMute.muted is true */
	muted: function(opts) {
		return soundMute.enabled(opts) && !!(opts && opts.soundMute && opts.soundMute.muted === true);
	},

	/** Options with the mute state set (keeps the enabled flag) */
	withMuted: function(opts, muted) {
		const current = opts.soundMute && typeof opts.soundMute === "object" ? opts.soundMute : {};
		opts.soundMute = { enabled: current.enabled !== false, muted: !!muted };
		return opts;
	},

	/** Button tooltip for the current state */
	tooltip: function(muted) {
		return muted ? "Sounds muted: click to unmute" : "Mute all Tripwire sounds";
	},

	/** Speaker icon (inline SVG: the icon font has none); muted = speaker with a cross, else with sound waves */
	iconSvg: function(muted) {
		const speaker = "<path d=\"M3 9h4l5-4v14l-5-4H3z\" fill=\"currentColor\" stroke=\"none\"/>";
		const waves = "<path d=\"M15.5 8.5a5 5 0 0 1 0 7\"/><path d=\"M18.5 5.5a9 9 0 0 1 0 13\"/>";
		const cross = "<path d=\"M16 9l6 6\"/><path d=\"M22 9l-6 6\"/>";
		return "<svg viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" fill=\"none\" stroke=\"currentColor\" " +
			"stroke-width=\"2\" stroke-linecap=\"round\" aria-hidden=\"true\">" + speaker + (muted ? cross : waves) + "</svg>";
	},

	// ---- Browser ----

	previewing: false,	// true during a Settings "Test" click, which plays even while muted

	current: function() {
		return typeof options !== "undefined" ? options : undefined;
	},

	isMuted: function() {
		return soundMute.muted(soundMute.current());
	},

	/** Stop anything playing right now (cached kill sounds, a Settings preview, speech) */
	silence: function() {
		if (typeof killReporting !== "undefined") {
			Object.keys(killReporting.audioCache || {}).forEach(function(id) {
				try { killReporting.audioCache[id].pause(); } catch (e) { /* ignore */ }
			});
			if (killReporting.preview) { try { killReporting.preview.pause(); } catch (e) { /* ignore */ } }
		}
		if (typeof speechSynthesis !== "undefined") { speechSynthesis.cancel(); }
	},

	/** Wrap killReporting.play so nothing plays while muted (done() is still called, so its queue drains) */
	wrapPlayer: function() {
		if (typeof killReporting === "undefined" || typeof killReporting.play !== "function" || killReporting.play.soundMuteWrapped) { return; }
		const play = killReporting.play;
		killReporting.play = function(soundID, volume, category, done) {
			if (soundMute.isMuted() && !soundMute.previewing) {
				if (typeof done === "function") { done(); }
				return;
			}
			return play.apply(this, arguments);
		};
		killReporting.play.soundMuteWrapped = true;
	},

	/** Show/hide the button and draw it for the current state */
	render: function() {
		const $button = $("#sound-mute");
		if (!$button.length) { return; }
		const opts = soundMute.current();
		const muted = soundMute.muted(opts);
		$button.toggle(soundMute.enabled(opts))
			.toggleClass("sound-mute-on", muted)
			.attr({ "data-tooltip": soundMute.tooltip(muted), "aria-pressed": muted ? "true" : "false" })
			.html(soundMute.iconSvg(muted));
	},

	toggle: function() {
		const opts = soundMute.current();
		if (!opts) { return; }
		const muted = !soundMute.muted(opts);
		soundMute.withMuted(opts, muted);
		if (muted) { soundMute.silence(); }
		soundMute.render();
		if (typeof opts.save === "function") { opts.save(); }
	},

	init: function() {
		soundMute.wrapPlayer();

		const $settings = $("#settings");
		if ($settings.length && !$("#sound-mute").length) {
			const $button = $("<i id=\"sound-mute\" role=\"button\" tabindex=\"0\" aria-label=\"Mute all sounds\"></i>").insertBefore($settings);
			soundMute.render();
			// Below the button (the usual right-hand tooltip would run off the screen edge); the text is read from
			// data-tooltip each time it opens, so it follows the state
			if (typeof jBox !== "undefined") {
				new jBox("Tooltip", { attach: $button, getContent: "data-tooltip", position: { y: "bottom" } });
			}
		}
		$(document).on("click", "#sound-mute", function(e) { e.preventDefault(); soundMute.toggle(); });
		$(document).on("keydown", "#sound-mute", function(e) {
			if (e.key === "Enter" || e.key === " ") { e.preventDefault(); soundMute.toggle(); }
		});

		// Settings > Kill Reporting "Test": capture phase, so the flag is set before its own click handler plays
		document.addEventListener("click", function(e) {
			if (!e.target || !e.target.closest || !e.target.closest(".kill-reporting-test")) { return; }
			soundMute.previewing = true;
			setTimeout(function() { soundMute.previewing = false; }, 0);
		}, true);

		// Settings > General row; takes effect on Save (Reset = shown, unmuted)
		forkSettings.register({
			section: "general", order: 30, id: "soundMute-enabled", type: "checkbox", key: "soundMute",
			label: "Mute button:", text: "Show a mute button next to Settings (hiding it also unmutes)",
			keywords: "sound audio silence quiet",
			get: function(o) { return soundMute.enabled(o); },
			set: function(o, on) { o.soundMute = { enabled: on, muted: on ? soundMute.muted(o) : false }; }
		});
		// options.apply() runs on page load, Save and Reset
		if (typeof options !== "undefined" && typeof options.apply === "function" && !options.apply.soundMuteWrapped) {
			const apply = options.apply;
			options.apply = function() {
				const result = apply.apply(this, arguments);
				soundMute.render();
				return result;
			};
			options.apply.soundMuteWrapped = true;
		}

		// Another tab of this user changed it (options.save() writes localStorage)
		window.addEventListener("storage", function(e) {
			if (e.key !== "tripwire_options" || !e.newValue || typeof options === "undefined") { return; }
			try {
				const other = JSON.parse(e.newValue);
				if (!other || typeof other !== "object") { return; }
				if (other.soundMute && typeof other.soundMute === "object") {
					options.soundMute = { enabled: other.soundMute.enabled !== false, muted: other.soundMute.muted === true };
				} else {
					delete options.soundMute;	// Settings > Reset there: back to the default here too
				}
				if (soundMute.isMuted()) { soundMute.silence(); }
				soundMute.render();
			} catch (err) { /* ignore */ }
		});

		soundMute.render();
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() { soundMute.init(); });
}
