# Mask id access check (security fix)

**Date:** 2026-10-11

## Description

Security fix: the active mask id was not validated strictly enough, so malformed or foreign mask ids could be
selected and used, giving access to masks the user is not a member of. Separately, saving a note by id could change
a note that belongs to another mask; it is now limited to the user's active mask.

## Settings

No toggle, because this is a security fix.

## Change

- New fork-owned `mask-guard.inc.php`: mask ids are only accepted in canonical form (`<digits>.<0-3>`, leading zeros
  stripped; the Public mask is `0.0`); anything else falls back to the character's corporation mask, as on login.
  Access is re-checked with strict comparisons using the same rule as upstream `verifyMask` (Public, own character /
  corporation / alliance mask, custom mask via owner or `groups` membership).
- The guard runs on every request from `docker/db.inc.php` (loaded by every endpoint), so existing sessions with a bad
  mask and masks whose access was removed are reset on the next request, and right after login (`public/login.php`),
  so a bad mask stored in the preferences never reaches the session.
- Upstream `verifyMask()` (`lib.inc.php`) canonicalises the id first, so a malformed mask id is never stored.
- Notes (`public/comments.php`): saving an existing note first checks that it belongs to the session mask (404
  otherwise), and the save's update only changes a row whose mask matches. New notes always get the session mask;
  delete and sticky were already limited to the session mask.
- REST API (`api/auth.php`) reviewed: its mask check only grants masks the account can access; left unchanged.
- Tests: `tests/mask_guard_test.php` (canonicaliser and access rules) and `tests/mask_access_test.php` (HTTP flow on
  the dev stack with generated malformed and foreign mask ids for reads and writes; Public, member, personal,
  corporation and alliance masks still work; notes of another mask can't be changed by id; API).
- Upstream files touched: `lib.inc.php` (2 lines in `verifyMask`), `public/login.php` (1 line),
  `public/comments.php` (save: 2 lines added, update clause changed).
