# Set route in game

**Date:** 2026-10-10

## Description

A "Set route in game" button in the Favourites panel (next to each favourite's route button) and in the Destinations
window sends the gate part of the route Tripwire worked out to the in-game autopilot as ESI waypoints, so EVE flies
exactly that route (e.g. the safe, high-sec only one) instead of picking its own.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.png) | ![after](after.png) |

After: the blue autopilot button on Jita and Amarr in the Favourites panel and on each destination; clicking Jita's
(safe route, 19 gate jumps from Hek) set it with 3 waypoints. ESI was stubbed in the browser for the screenshot.

## Settings

No toggle: it is a button that does nothing until clicked, and it only appears where a route is already shown (a
favourite with Route on, a destination with a gate route). Nothing is drawn or sent automatically.

## Change

- `app/js/fork/autopilot-route.js` (new): pure logic in `autopilotRoute` plus the UI.
  - Leg: Favourites panel plans through the chain start at the exit system (wormholes can't be waypointed; you
    fly the holes yourself), direct plans at your location. The gate path is a breadth-first search with the
    panel's own rules (`favouritesPanel.passable`: safe = only high-sec in between, Zarzakh and the avoid list are
    never passed), so its length matches the panel's `…g` count. Destinations use the path the window already
    computed (`routeDestinations.evaluate(...).best.path`, from `guidance`). Before sending, `kspaceLeg` cuts any
    route down to its k-space tail, so wormhole space is never sent as a waypoint.
  - Waypoints: every low-sec, null-sec and Pochven system on the route is a waypoint (EVE's "safer" preference
    would otherwise go round a low-sec stretch through high-sec, even when that stretch is the only shortest
    route). High-sec stretches are reduced greedily: skip ahead while the path so far is the only shortest gate
    route there (counted over the whole gate map) and stays in high-sec, so "shortest" can't pick another way and
    "safer" has nothing better. Always ends with the destination. E.g. the 19-jump safe Hek → Jita route needs 3
    waypoints, the 15-jump shortest Hek → Amarr (mostly low-sec) 11.
  - Cap: 50 waypoints, the commonly quoted in-game limit (a third-party figure, not confirmed by CCP). Over it,
    the first 49 are set plus the destination, and the success toast says so: the route is followed as far as the
    last pinned system and EVE picks its own route from there.
  - Sending: `tripwire.esi.setDestination` one call after another (not in parallel), the first with
    `clear_other_waypoints=true`, the rest appended (`add_to_beginning=false`). Character: the active tracked
    character (`options.tracking.active`), like upstream's chain map "Set destination".
  - Feedback: a progress toast ("waypoint n of N") stays up while sending, then a success toast (jumps and waypoint
    count, plus the cap note) or an error: no tracked character / no ESI login, 401/403 (expired login or missing
    `esi-ui.write_waypoint.v1`: log in again), rate limit, network; a failure part-way says how many waypoints were
    set.
  - UI hooks without touching other files: a `MutationObserver` on the Favourites panel list adds the button to its
    rows; `routeDestinations.renderRows` is wrapped to add a column.
- `app/css/fork/autopilot-route.css` (new), `app/js-test/fork/autopilot-route.test.js` (new, 60 tests), rebuilt
  bundles.
- Upstream files touched: none (besides the rebuilt bundles). Calls only ESI (`esi.evetech.net`), which upstream
  already uses for "Set destination".

## Limitations

- EVE's "less secure" autopilot preference could still leave a high-sec stretch of the route; "shortest" and
  "safer" (the usual ones) follow it. An in-game avoid list that blocks a system on the route also changes it.
- Routes through a lot of low/null-sec need many waypoints (one per system), so they take a few seconds to set and
  very long ones hit the 50-waypoint cap.
- The route is set from where you leave the chain; while you are still in J-space EVE shows it only once you are out.
