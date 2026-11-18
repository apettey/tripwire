# Paste preview: Delete by default, auto-save timer

**Date:** 2026-11-18

## Description

The paste preview waited for an answer and pre-selected "Mark broken" for gone wormholes. Now every gone signature
defaults to Delete, and the dialog counts down 10 seconds: with no input by then the paste saves only its new and
updated signatures and leaves everything gone as it is (nothing deleted, nothing marked broken). The time is a
drop-down in the preview's top right (Never, 3 s, 5 s, 10 s), also in Settings > Signatures.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.jpg) | ![after](after.jpg) |

No input for 10 seconds: ![after auto-save](after-auto.png)

The auto-save drop-down, top right: ![drop-down](after-dropdown.jpg)

## Settings

Settings > Signatures > **Paste preview auto-save** (After 10 s by default; Never, 3 s, 5 s), stored in
`options.pastePreview.autoSeconds` (missing = 10; covered by the existing `pastePreview` mask default). The same choice is a
drop-down in the preview's title bar. Settings > Signatures > Preview pastes still turns the preview off. Tip: none, the countdown explains itself in the dialog.

## Change

- `app/js/fork/paste-preview.js`: a gone wormhole's choice defaults to Delete (Delete listed first, Mark broken still
  offered). New `AUTO_SECONDS: 10` and `keepGone(groups)` (all Gone rows unticked). The dialog shows a countdown line
  with a shrinking bar; any mousedown, key, wheel or touch on the page stops it and the user chooses as before (Apply /
  Enter, Esc / Cancel). At zero the preview applies `keepGone`: adds, updates and broken-hole restores only. The notice
  says "(2 gone left alone: no choice made)". An auto-save is tracked as the event `auto_saved` (not the use `applied`; added to `public/fork/feature-catalog.json`).
  Stopped by input, the line stays in place ("Countdown stopped") so the buttons don't move under the mouse.
- `AUTO_CHOICES` / `autoSeconds(opts)`; a drop-down in the dialog's title bar (left of the close button) saves the
  choice with `options.save()` for the next paste and stops the current countdown; Never (0) shows no countdown.
  Settings row `pastePreview-auto` (order 21.3). Preview pastes text updated.
- `app/css/fork/paste-preview.css`: the countdown line and the title-bar drop-down.
- Tests: Delete default, `keepGone` plan, choice counts, `autoSeconds` (`app/js-test/fork/paste-preview.test.js`).
