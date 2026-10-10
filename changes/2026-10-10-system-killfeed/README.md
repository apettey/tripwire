# System Kill Feed

**Date:** 2026-10-10

## Description

A new "Kills" panel in the layout shows the 20 most recent kills in the system you are viewing: victim ship, victim
corporation and pilot on the left, the final blow's corporation and the number of pilots involved on the right, with
time and value, each linking to zKillboard. To serve it (and later features) without more zKillboard traffic, all
zKillboard/ESI access now goes through one pooled server module that only the existing feed worker uses.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.jpg) | ![after](after.jpg) |

The panel (2x), at its narrowest and in a wide layout:

![panel](after-panel.jpg)

| Narrow | Wide |
| --- | --- |
| ![narrow](after-narrow.jpg) | ![wide](after-wide.jpg) |

## Settings

Toggle: Settings > General Preferences > "System kill feed" (on by default), stored in `options.systemKillFeed.enabled`
(missing = on). Off removes the panel from the layout and stops all its requests; applied on Save, Settings > Reset
turns it back on.

## Change

- **Panel** `app/js/fork/system-killfeed.js` + `app/css/fork/system-killfeed.css`: a gridster widget added from fork
  JS (`grid.add_widget`), so it takes part in Customize layout and is saved in `options.grid` like the built-in panels.
  A saved layout without it (older layouts) places it right of the top row when the window has room, otherwise under
  the chain map. It follows the viewed system (wraps `tripwire.systemChange`), refreshes every 90 s (every 4 s while
  the server is back-filling or resolving names), pauses while the tab is hidden, and drops secondary details as the
  panel narrows (value, ship line, corp logo/time) and shows the final blow's corporation name when wide. Loading,
  empty ("No kills in the last 48 hours."), feed-off and error states. All external text is escaped.
- **Endpoint** `public/system_kills.php` (new, logged-in users, GET only): `systemID` and/or `systems` (≤ 25),
  `pastSeconds`, `limit` (≤ 50). Reads the database only; queues back-fills and unknown names for the worker; never
  fails because zKillboard or ESI are down (it returns what is stored, with `pending` / `complete` flags).
- **Pooled zKillboard integration** `zkill/` (new, see [docker/README.md](../../docker/README.md#zkillboard-integration)):
  one HTTP client (User-Agent, per-host rate limits, 429 `Retry-After`, backoff, ESI error limit), new tables
  `zkill_killmails` (all kills from the stream, `ZKILL_RETENTION_HOURS`, default 48 h), `zkill_state`,
  `zkill_backfill` (per-system queue), `zkill_names` (ESI name cache); DDL in `docker/sql/zkill.sql`.
  Tests: `zkill/tests/zkill_test.php`.
- **Worker** `zkill_feed.worker.php`: now uses the module's HTTP client, also stores every killmail in
  `zkill_killmails`, and between kills drains the back-fill queue (zKillboard API, one request per
  `ZKILL_API_INTERVAL` s, default 2) and the name queue (ESI `POST /universe/names/`). Kill Reporting is unchanged:
  `zkill_kills` is still filled only from the stream, for chain systems, so back-filled kills never cause sounds or
  pop-ups, and `public/kills.php` is untouched.
- **Config**: `ZKILL_RETENTION_HOURS`, `ZKILL_API_INTERVAL` in `docker/config.php`, `.env.example`, both compose files
  and the docker README; `docker/Dockerfile` leaves `zkill/tests/` out of the image.
- **Third parties** (AGENTS.md section 6): the browser loads ship icons and corporation logos from `images.evetech.net`
  and links to `zkillboard.com`; the server (worker only) calls `zkillboard.com` (back-fills, besides the existing
  R2Z2 feed) and `esi.evetech.net` (killmails, names). No analytics or tracking.
- **Upstream files touched**: none. The panel is added from fork JS; `tripwire.php`, `layout.js`, `options.js` and
  `systemChange.js` are unchanged (wrapped from outside). Rebuilt bundles: `public/js/app.min.js`, `public/css/app.min.css`.
