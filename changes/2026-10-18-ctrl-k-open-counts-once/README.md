# Ctrl+K opens count once (usage analytics)

**Date:** 2026-10-18

## Description

Opening the usage analytics dashboard or What's New from Ctrl+K counted two events (`command` and `opened`), so the
analytics dashboard overstated how often they were opened. Now a Ctrl+K open counts only `command`, as the features hub
already does (#124).

## Settings

No toggle: a fix to how usage is counted, nothing users see.

## Tip

No tip: nothing user-facing changed.

## Change

- `analyticsDashboard.open(tab, fromCommand)`: the Ctrl+K command (`analytics.open`) passes `true` and skips
  `analyticsDashboard.opened`; the user-menu button still counts `opened`.
- What's New: the Ctrl+K command (`app.whatsNew`) calls `whatsNew.open(true)`, and forkUsage's `whatsNew.open` hook skips
  `whatsNew.opened` for it. Settings > General > What's new still counts `opened`; the automatic opening after an update
  still counts nothing.
- Tests in `app/js-test/fork/try-it-usage.test.js` run each entry point through the real forkUsage hooks.
- Fork files only: `app/js/fork/analytics-dashboard.js`, `app/js/fork/command-palette.js`, `app/js/fork/feature-usage.js`.
  No upstream files touched. No data migration: past days keep their double counts.
