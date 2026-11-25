# New k-space Discord message names the hole

**Date:** 2026-11-25

## Description

The "New k-space near a ping system" Discord message now names the hole the way the chain map does (its chain label,
e.g. **AAA**) instead of its signature ID, so pilots can find it on the map. Holes without a name still show the
signature ID.

## Settings

No toggle: it is the message text, which admins already edit in Mask Admin > Discord (the new `{name}` placeholder;
`{sig}` still works).

Tip: none, the message is posted to Discord, nothing to find in the app.

## Change

- Message text: "Hole PQY-801 in J124526" becomes "Hole **AAA** in J124526" (`{name}` in the default text). Masks still
  on the old default text get the new one automatically; customised texts are left alone.
- Embed: the Hole field shows "AAA B274 in J124526" instead of "PQY-801 B274 in J124526".
- `discord/template.php`, tests in `discord/tests/discord_test.php`.
