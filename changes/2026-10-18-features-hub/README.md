# Features you haven't tried

**Date:** 2026-10-18

## Description

A Features dialog lists every fork feature the user can use with a one-line description, whether they've used it
(Used / Not tried / Turned off), and "Show me" / "Settings" buttons. Features not tried yet come first, from the
sections the user already uses most. It is the place to find everything again, so tips and What's New don't have to
re-teach.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.png) | ![after](after.png) |

Before: Settings > General with no Features row. After: the Features dialog.

## Settings

No toggle: the dialog only opens when the user asks for it (pull, never pushed), so there is nothing to turn off.

## Tip

No tip: Getting started and the What's New footer link to it, Ctrl+K finds it ("features", "help", "discover") and it
sits next to What's new in Settings > General.

## Change

- `app/js/fork/features-hub.js`, `app/css/fork/features-hub.css` (new): the dialog. Rows come from
  `public/fork/feature-catalog.json`; mask admin features only when the Mask Admin link is shown, operator features
  only when the usage analytics command is registered. Description: first sentence of the feature's newest What's New
  entry (plain text, escaped). Sort: not tried, then used, then turned off; within each, sections with the most used
  features first, then stage (first, core, intermediate, admin), then catalog order. Filters: section, stage, status and
  text. "Show me" runs `forkFeatureActions.tryIt` (tip, try command, panel, Settings row, or a short toast: the button
  says "How?" when only the toast is left); "Settings" opens the feature's Settings row.
- Entry points: Ctrl+K `features.open`, a Settings > General row (`forkSettings.register`), and a link in the What's New
  dialog's footer (added on its `dialogopen` event; whats-new.js unchanged).
- `app/js/fork/feature-actions.js`: `features.open` added to the Try it allow-list (`TRY_SAFE`), so What's New's
  "Try it" for this feature opens the dialog.
- Catalog: `featuresHub` (use: `opened`, `tried`; event: `settings`; command `features.open`).
- Tests: `app/js-test/fork/features-hub.test.js` (audience, description, sort, filter, summary, markup).
- No upstream files touched.
