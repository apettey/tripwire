# Inline life and mass edits

**Date:** 2026-10-12

## Description

Click the Life or Mass cell of a wormhole in the signature table (or select one row and press L / M) to pick a new
value from a small pop-over, instead of opening the edit dialog. Double-click still opens the dialog. Ctrl+Z undoes an
inline change, like any other signature edit.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.png) | ![after](after.png) |

Close-ups: Life pop-over (Stable / EOL) and Mass pop-over (Stable / Destab / Critical).

| Life | Mass |
| --- | --- |
| ![life pop-over](popover-closeup.png) | ![mass pop-over](mass.png) |

## Settings

Toggle: Settings > Signatures > "Edit life and mass in place" (on by default, `options.sigInline.enabled`, a missing
key means on). Off means clicks on the cells and the L / M keys do nothing.

## Change

- New `app/js/fork/sig-inline.js` and `app/css/fork/sig-inline.css`; tests in `app/js-test/fork/sig-inline.test.js`.
  No upstream files are edited and there are no server changes.
- Click (no modifier) on column 5 (Life) or 6 (Mass) opens the pop-over under the cell; the row is still selected as
  before. Keys: `1`-`2` (Life) or `1`-`3` (Mass) pick, arrows move, Enter picks the focused chip, Esc or a click outside
  closes. L / M open it for the single selected row (not while typing in a field or with a dialog open).
- Life offers only Stable and EOL (EOL is one normal update; no "EOL ends in..." times). Hole type and Leads To
  are not editable inline.
- Only the changed field is sent (`{wormhole: {id, life|mass}, signatures: [{id}, {id}]}`), so a colleague's edit of
  another field is not overwritten. The cell changes at once and is restored with a red notice if the save fails.
- Undo: before sending, copies of the wormhole and both signatures are kept; on success the same
  `{action: "update"}` entry the dialog pushes goes on `tripwire.signatures.undo[viewingSystemID]` and into
  `sessionStorage`, and `#undo` is enabled. Ctrl+Z / Ctrl+Y therefore work, also after the 10 s refresh.
- While the pop-over is open `tripwire.activity.editSig` is set (others see the "editing" highlight). If the
  10 s refresh re-renders the row the pop-over follows the new cell; if somebody changed the value meanwhile it
  updates and says "Changed by <name>"; if the row is gone it closes.
- `sigInline.setWormhole(wormholeID, {life: ...} | {mass: ...})` is the save path and returns a Promise
  (`"saved"`, `"same"` or `"failed"`); the command palette will reuse it.
- Review fixes: saves are queued (one at a time, since `tripwire.sync` merges overlapping requests and loses the
  first), the pop-over closes on scroll, Tab or focus leaving it and follows its cell while the widget is dragged or
  resized, digits/arrows are ignored while typing in a field, and the selected row stays selected after a save so
  L / M can be used repeatedly.
- `cache/.gitignore` now ignores `esi-etag/` (runtime files that were once committed by accident).
- New setting key `sigInline` added to the mask-defaults allow-list (`app/js/fork/mask-defaults.js`, `maskadmin/maskadmin.inc.php`, test count 26 to 27), as the allow-list test requires.
- Round 2: a save that gets no response within 15 s counts as failed (cell restored, red notice) so the queue never blocks; the selection is restored only for rows newly inserted by the refresh, cleared by any click, and announces `selected:change`.
