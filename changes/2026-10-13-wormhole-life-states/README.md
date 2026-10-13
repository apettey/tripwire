# Wormhole life states: Stable, <4h, <1h, EOL

**Date:** 2026-10-13

## Description

A hole's life can now be set to Stable, <4h, <1h or EOL instead of only Stable or EOL. These follow the four states
the game's Wormhole Information shows since the Catalyst update ("Reliable lifetime", "less than 4 hours", "less than
1 hour", "Expired"; Tripwire calls the last one EOL). You can set them in the signature dialog, in the sig list's Life
cell (L, then 1-4) and with Ctrl+K "Set life". The chain map draws each state differently, and bookmark names use
<4h / <1h / EOL.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.png) | ![after](after.png) |

Chain map: <4h (B) keeps the dashed line, <1h (C, here also mass critical) is dotted, EOL (D) is a thin dotted line
with an EOL tag. A is stable (mass destabbed).

![chain map](after-map.png)

## Settings

Toggle: Settings > Signatures > "Wormhole life states" (`options.lifeStates.enabled`, on by default; added to the
mask-defaults allow-list). Off: upstream's Stable / EOL buttons and behaviour everywhere, including the old dashed EOL
line on the map and "EOL" in bookmark names.

## Change

- No schema change. `wormholes.life` stays `stable` / `critical`. The three critical states come from the hole's
  signature timer (`lifeLeft`), which upstream already counts down for EOL holes. More than 1 h left (or no timer) is
  <4h, 0-1 h is <1h, and past the timer is EOL (internal key `expired`). Picking a state keeps the timer if it is
  already inside that state's band; otherwise the timer is set to now + 4 h, now + 1 h or now, on both signatures, in
  the same request as the life change. So states move on with time like in game. The server deletes an EOL hole a
  tenth of its life length after expiry (upstream's `wormholeClean` event). "Never expires" signatures (life length 0)
  get a timer too, but the server never deletes them.
- New `app/js/fork/life-states.js` (pure logic, dialog buttons, sig list Life text and colours, map lines and legend,
  settings row) and `app/css/fork/life-states.css` (<4h amber, <1h red, EOL magenta). The dialog's two extra buttons
  are added from JS; upstream's EOL button becomes "<4h".
- `app/js/fork/sig-inline.js`: four choices (keys 1-4), state-aware payload, cell text/colour and popover sync; undo
  restores the life and the timer. `command-args.js` / `command-palette.js`: Ctrl+K "Set life" takes 4h / critical
  (<4h), 1h (<1h), eol / expired / closing (EOL); the hole list shows the state. `life-wording.js`: tooltips for the
  four buttons.
- Chain map: a `chain.nodes` wrapper adds `life-lt4h` / `life-lt1h` / `life-eol` (and `-chain` for the holes further
  out) next to upstream's `eol` modifier. It also tags the node behind an EOL hole. CSS makes <1h and EOL dotted, and EOL
  thinner on the canvas map. This works for every renderer (org chart, top, side, radial). The map legend gets the
  <1h and EOL lines.
- Bookmark names: the `{life}` token (`bookmark-template.js`) is `<4h`, `<1h` or `EOL` for the hole's state (empty
  when stable; `EOL` for any critical hole with the setting off). Callers: `hole-naming.js` (dialog save),
  `jump-sig-prompt.js`, `jump-return.js`. Only letters, digits and `<` are kept in it, and every place that shows a
  bookmark escapes it.
- Undo/redo send whole signatures, and the server applies `lifeLength` after `lifeLeft`, which reset the timer.
  `lifeLeft` is now sent after `lifeLength` (a `tripwire.refresh` wrapper), so undo restores the exact timer.
- Undo now restores a hole's old EOL timer for everyone (setting on or off). So undoing a mistaken Stable on a hole
  that expired long ago can bring it back already past its timer, and the server may clean it up soon after.
- Upstream files touched (small, local): `app/js/dialogs/signature-dialog.js` (two hook lines: prefill and payload),
  `signatures.php` (a change to EOL keeps a timer the request sent instead of forcing now + 4 h),
  `app/js/chain-map-renderer-base.js` (the canvas renderers also draw a `dotted` border style). Also
  `docs/eve-wormhole-primer.md`.
