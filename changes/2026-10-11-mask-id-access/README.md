# Mask id access check (security fix)

**Date:** 2026-10-11

## Description

Security fix: the active mask id a user picks was checked with PHP loose comparisons, while MySQL matches mask ids
numerically, so a non-canonical spelling of a mask id could pass the check and still select another mask. A
logged-in user could then read and write the signatures, notes and other data of custom masks, other characters'
personal masks and other corporations' masks they had no access to.

## Settings

No toggle, because this is a security fix.

## Change

- New fork-owned `mask-guard.inc.php`: mask ids are only accepted in canonical form (`<digits>.<0-3>`, leading zeros
  stripped, nothing else); anything else falls back to the character's corporation mask, as on login. Access is
  re-checked with strict comparisons using the same rule as upstream `verifyMask` (own character / corporation /
  alliance mask, custom mask via owner or `groups` membership).
- The guard runs on every request from `docker/db.inc.php` (loaded by every endpoint), so existing sessions with a bad
  mask and masks whose access was removed are reset on the next request, and right after login (`public/login.php`),
  so a bad mask stored in the preferences never reaches the session.
- Upstream `verifyMask()` (`lib.inc.php`) canonicalises the id first, so `options.php` can no longer store a
  malformed mask id.
- REST API (`api/auth.php`) checked: its custom-mask query has an operator-precedence slip, but it only returns masks
  the account can access and the result is compared with the requested id, so it does not grant access to other
  masks; left unchanged. Covered by the new test.
- Tests: `tests/mask_guard_test.php` (canonicaliser and access rules) and `tests/mask_access_test.php` (HTTP flow on
  the dev stack: malformed and other-owner mask ids through `options.php`, then `refresh.php` reads and
  `comments.php` writes; member, personal, corporation and alliance masks still work; API).
- Upstream files touched: `lib.inc.php` (2 lines in `verifyMask`), `public/login.php` (1 line).
