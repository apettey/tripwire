# Ctrl+K opens count once (usage analytics)

**Date:** 2026-10-18

## Description

Opening the usage analytics dashboard or What's New from Ctrl+K logged two use events (`command` and `opened`). Now a
Ctrl+K open logs only `command`, as the features hub already does (#124), and the dashboard's What's New numbers count
Ctrl+K opens through `command`.

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
- Dashboard, Tips & What's New: "users opened What's New themselves" and the per-release share count users with
  `whatsNew.opened` or `whatsNew.command` (`analytics/dashboard.inc.php`), so Ctrl+K opens aren't lost now that they no
  longer log `opened`. The dashboard counts users, not events, so its other numbers don't change.
- Tests: `app/js-test/fork/try-it-usage.test.js` runs each entry point through the real forkUsage hooks;
  `tests/analytics_dashboard_test.php` adds a Ctrl+K-only What's New user.
- Fork files only (`app/js/fork/analytics-dashboard.js`, `app/js/fork/command-palette.js`, `app/js/fork/feature-usage.js`,
  `analytics/dashboard.inc.php`); no upstream files touched.
