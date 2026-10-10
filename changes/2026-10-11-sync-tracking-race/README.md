# Jumps lost while a refresh is in flight

**Date:** 2026-10-11

## Description

Fix: a character's jump could be lost when ESI reported it while a `refresh.php` request was in flight, so
the jump log, the automapper and the fitted-mass jump report (PR #38) never saw it. Found while reviewing
PR #38 (2 of ~7 early e2e runs logged no jump). This is an upstream bug and worth reporting upstream.

## Settings

No toggle: it's a bug fix with no visible change; nobody would want jumps to be dropped.

## Change

- **Cause.** Upstream `tripwire.sync` (`app/js/tripwire/sync.js`) copies the pending `tripwire.data`
  (character `tracking` written by `tripwire.esi.updateTracking`, `esi` flags, `esiDelete`) into the request
  when it is sent, but resets `tripwire.data` to `{tracking: {}, esi: {}}` when the response arrives.
  Anything written in between was never sent and was wiped. `esi.js` only writes tracking when the location,
  station or ship changes, so the jump was never sent again: the `tracking` row skipped it and the upstream
  `jumpHistory` trigger (on `tracking`) never logged it.
- **Fix.** New `app/js/fork/sync-pending.js` wraps `tripwire.sync`: it snapshots `tripwire.data` when a
  request is sent and, right after upstream's reset on success, puts back every entry added or changed after
  the send (per character for `tracking`). Anything written after the response wins. No upstream file is
  edited.
- **Failed requests** were already safe (upstream only resets on success, so everything is resent). When a
  sync has to wait for the in-flight request, upstream already copies the pending data into its retry; the
  wrapper then restores nothing for the old request, so a newer location is not overwritten by an older one.
- **Server side** (`public/refresh.php`, unchanged): a tracking update is an upsert, so sending one twice is
  harmless (the trigger only logs when `systemID` changes). A lost update can't be recovered there: the next
  update just moves the row, and the trigger only logs a jump if one wormhole joins the old and new system
  directly, so a pilot two jumps further on gets no `jumps` row at all.
- **Not fixed here** (separate upstream bug): `app/js/tracking.js` (~line 78, removing an ESI character)
  checks `tripwire.data.esi.delete` but writes `tripwire.data.esiDelete`, so removing two characters before a
  refresh only sends the last one.
- **Tests.** `app/js-test/fork/sync-pending.test.js` runs upstream's real `sync.js` against a fake `$.ajax`
  with held responses: reproduces the bug, then covers the fix, failures, the waiting/retry path and ESI
  flags. End to end (dev stack, refresh.php responses held 2 s, two fake tracked characters jumping
  Jita → J105246 through a seeded hole mid-flight, 3 runs each): upstream alone logged 0 of 6 jumps, with the
  fix 6 of 6.
