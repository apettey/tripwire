# Mute button

**Date:** 2026-10-11

## Description

A speaker button next to Settings in the top bar mutes every Tripwire sound (kill reporting sounds and voice, watchlist
alerts) with one click, so a user can work undisturbed without changing their sound settings. Click it again to
unmute.

## Before / After

After: muted (red speaker with a cross). Unmuted, it is a grey speaker like the icons next to it.

| Before | After |
| --- | --- |
| ![before](before.png) | ![after](after.png) |

## Settings

Toggle: Settings > General > Mute button (on by default). Unticking it hides the button and also unmutes, so nobody is
left muted with nothing on screen saying so. The mute state itself is stored per user in `options.soundMute.muted`
(saved straight away, like the layout buttons), so it follows the user to other browsers; Settings > Reset shows the
button and unmutes.

## Change

- `app/js/fork/sound-mute.js` adds the button before `#settings` and wraps `killReporting.play`, which plays every
  sound in the app (Kill Reporting, Watchlist). While muted it plays nothing but still calls the caller's `done`, so
  the kill sound queue drains instead of piling up. Muting also stops whatever is playing (cached sounds, a Settings
  preview, speech).
- The Settings > Kill Reporting "Test" buttons still play while muted: they are a deliberate click.
- Other open tabs of the same user pick up the change through the `storage` event on `tripwire_options`.
- Keyboard: the button is focusable and toggles with Enter/Space; tooltip below the button says the current state.
- Tests: `app/js-test/fork/sound-mute.test.js`.

Files: `app/js/fork/sound-mute.js`, `app/css/fork/sound-mute.css`, `app/js-test/fork/sound-mute.test.js`. Upstream
files touched: none.
