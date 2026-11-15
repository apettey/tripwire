# Map jumps of all my tracked characters: every online character, no limit of 5

**Date:** 2026-11-15

## Description

"Map jumps of all my tracked characters" used the first 5 characters (by name) whose A switch was on, even if some
were logged off, so an offline alt could take the slot of one that was actually flying. Now every online character
with its A switch on is used, with no limit.

## Change

- `multiTrack.optedIn` keeps only online characters (`multiTrack.isOnline`: what upstream's `/online/` poll last said,
  via `esi-offline-skip.js`; unknown counts as online) and drops the 5-character cap (`CAP`, the cap note above the
  tracking list and the "over the 5" A-icon state are gone).
- An A icon that is on for an offline character is dimmed, tooltip "on, but it is offline (used once it logs in)".
  Offline characters leave the chip strip (the active one stays, as before).
- Settings row text: "Map jumps of all my tracked characters" (was "... (up to 5)"); the hint and the catalog title say the same.
- Load: no new requests. Offline characters with the A switch on are no longer always polled for location and ship
  (they now get the normal offline skip). Online characters were polled anyway.
- Moves are only watched for the active and online characters (`multiTrack.watchedIds`): an offline character's stored
  system is dropped and, once `/online/` shows it logged in, it stays unwatched until a fresh location answer arrives
  (counted with a jQuery `ajaxSuccess` listener on upstream's location requests, which fires after upstream has stored
  the system; debug characters use 60 s instead), so that first location is a first sighting. Trade-off: jumps in the first ~2 minutes after a login (until `/online/` notices) aren't
  switched to or mapped, instead of risking one fake hole from where it logged off to where it is now. Picking such a
  character yourself in that window makes it active with its logoff system, as for any other alt today.
- No upstream files touched.

## Settings

No new toggle: same opt-in row, Settings > Wormhole Jumps & Mass > "Map jumps of all my tracked characters". This
change only fixes which characters it uses.

## Tip

No new tip; the existing `multiTrack.otherJump` tip covers the feature.
