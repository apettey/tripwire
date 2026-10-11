# ESI paths without version prefix, ETags

**Date:** 2026-10-11

## Description

ESI's `/latest/` and `/vN/` path prefixes are legacy; the `X-Compatibility-Date` header we already send (see
`2026-10-10-esi-compat-rate-limits`) selects the behaviour. Every ESI call now uses the plain path, and the server's
GET requests send `If-None-Match` with the stored ETag, so unchanged data comes back as a body-less 304.
Follows squizzlabs/tripwire 37ae522 and fba8457 (MIT).

## Change

No visual change.

- Paths: all routes below exist unversioned in `https://esi.evetech.net/meta/openapi.json` (compat date 2025-12-16).
  Browser (`app/js/tripwire/esi.js`, `app/js/fork/auto-mass.js`): characters/{id}/location, ship, online, assets,
  search, characters/{id}, universe/types, stations, names, system_jumps, system_kills, ui/autopilot/waypoint,
  ui/openwindow/information, status, corporations/{id}, alliances/{id}. Server (`esi.class.php`,
  `public/cached_third_party.php`): characters/{id}, corporations/{id}, alliances/{id}, characters/affiliation,
  universe/names, characters/{id}/roles, titles, universe/system_jumps, system_kills, fw/systems.
  Also `intel/tools/generate-types.js` (dev tool base URL). The zkill worker, skyhooks and system residents were
  already unversioned. No route was left behind.
- ETags: `esi_request()` (and so `esi_open_url()`, skyhooks, system residents) and the zkill worker's
  `zk_http_request()` store a 200's ETag with its body in `cache/esi-etag/` (one file per URL and access token,
  max 1 MB, pruned after a week) and send `If-None-Match`; a 304 is returned to the caller as the stored 200.
  Not covered: `esi.class.php` `getAPI()` (upstream file, only path strings edited) and the worker's
  `zk_http_get_many()` (zKillboard only). The browser relies on its own HTTP cache.
- Upstream files touched (path strings only): `app/js/tripwire/esi.js`, `esi.class.php`, `public/cached_third_party.php`.
- Tests: `esi/tests/esi_test.php`, `zkill/tests/zkill_test.php` (stubbed transports).
