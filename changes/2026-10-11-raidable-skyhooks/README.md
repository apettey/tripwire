# Raidable skyhooks

**Date:** 2026-10-11

## Description

Low-sec and null-sec systems on the chain map get a small skyhook icon (next to the Jump planner's ring). It opens a
closable, movable box, "Raidable skyhooks near <system>", listing the skyhooks that can be raided (their theft window is
open or opens soon) within a number of gate jumps of THAT system, with the window in EVE time, a countdown and a "Set route
in game" button. The data is ESI's public `GET /skyhooks/raidable`. (First version: an always-on panel; reworked after
user feedback to open on demand like the Jump planner.)

## Before / After

| Before | After |
| --- | --- |
| ![before](before.png) | ![after](after.png) |

(Before: a low-sec system with only the Jump planner ring. After: the skyhook icon beside the ring, and the box it opened.)

## Settings

Settings > Routes & Navigation (all on by default, stored in `options.skyhooksPanel`; Reset deletes it):
- "Skyhook icon": show the icon on low-sec and null-sec systems (`enabled`). Off removes the icons and the box.
- "Raidable skyhooks": also open the box when I click a low-sec or null-sec system's name (`clickOpen`), as the Jump
  planner does for its exits.
- "Skyhooks within": the default maximum number of jumps, 10.

The box's own header has the other options, saved in the same place: max jumps (3 to 30 or any distance), low-sec /
null-sec, window (vulnerable now, opens within 1/2/4/8/24 h, all) and sort (jumps or window start).

## Change

- **Server** (fork-owned): `skyhooks.inc.php` and `public/skyhooks.php` (session required, GET only). One cached copy for
  the whole server in `cache/skyhooks.json`, refreshed from ESI at most every 5 minutes under an exclusive `flock` (if the
  cache can't be written the time of the attempt is kept in the lock file, so ESI is still asked at most once a minute;
  others get the old copy; a request with no copy at all waits up to 10 s for it). On an ESI error, a 404 or one of our
  rate-limit pauses (`esi/esi.inc.php`), the old copy is served (`stale` once it is over 10 minutes old, `error` says
  why) and ESI is not asked again for 60 s; with no copy at all `unavailable` is set. ESI's route is in a rate-limit group
  of only 30 requests per 15 minutes per IP, so browsers never call it. It needs `X-Compatibility-Date: 2026-10-01` (the
  pinned `2025-12-16` answers 404): `esi_request()` already leaves a date header the caller sets alone, so
  `esi/esi.inc.php` is unchanged and only this one call uses the newer date. The route's `theft_vulnerability.start/end`
  become unix seconds. Verified once against live ESI from the dev stack (200, 170-odd skyhooks).
- **Client** (fork-owned): `app/js/fork/skyhooks-panel.js` + `app/css/fork/skyhooks-panel.css`, built like the Jump
  planner. `chain.nodes` is wrapped once to insert the icon (top-right of the node, just left of the Jump planner's ring)
  into the HTML of every low-sec / null-sec system on the chain (not high-sec, W-space, Pochven, Zarzakh, or synthetic
  route nodes). The icon opens the box for that system (and doesn't reach the node); a capture-phase listener opens it
  from a click on the system's name too (viewing the system redraws the chain, which would detach the link before a
  delegated handler ran). The box is a gridster widget with a close button (X); closing it forgets the system, its
  position is remembered (a saved grid entry, else right of the other panels when that fits, else below them), and it is
  never open after a page load. Region, security and system name come from the static system data already in the page,
  so the server sends only IDs and times. Jumps are gate jumps from the clicked system: one search from it over the gate
  map with guidance's own costs (route-security preference, avoid list, Zarzakh, closed gates) and cut-off, so counts match
  `guidance.findShortestPath` (a test compares them); cached until the system, limit, preferences or gate map change
  (and 5 minutes / `guidance.clearCache`). The route is only worked out when "Set route in game" is clicked
  (`autopilotRoute.push`, character picker as elsewhere). The box asks our server every 5 minutes while open and redraws
  the countdowns every 30 s. Empty and error states: nothing from the server, data unavailable, nothing matching the
  options, a line when the server can't be reached or ESI is stale. High-sec or unknown-security systems are never hidden
  by the low/null checkboxes (the data should not have any).
- **Planet names**: not shown. The repo has no planet data (SDE planets), and the name (system + roman numeral) can't be
  derived from the planet ID, so rows say only the system.
- **Tests**: `app/js-test/fork/skyhooks-panel.test.js` (settings, window status and countdown, EVE-time text, security and
  window filters, rows, sorting, the search incl. a comparison with guidance, entry penalties, the chain icon, placement,
  empty states); `tests/skyhooks_test.php` (parsing, 5 minute cache, 60 s retry, stale copy, lock held by another request,
  unwritable cache, unavailable, paused ESI, the date header on the request).
- **Upstream files touched**: none (`docker/README.md` is fork-owned and has a short section).

No new third-party hosts (`esi.evetech.net` is already used), analytics or tracking.
