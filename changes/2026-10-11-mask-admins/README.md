# Mask admins: several admins, block members, mask default settings

**Date:** 2026-10-11

## Description

Mask Admin has a new "Admins & members" tab. The mask owner (or the owning corporation's admins) can make any member
a mask admin, admins can remove or block a member (with a reason) even when their corporation or alliance has access,
and admins can save their own settings as the mask's defaults, which members who haven't chosen otherwise get.
Requests: Tripwire #441 "allow to set mask admins", forum requests to remove/block members, Wanderer-style admin defaults.

## Before / After

| Before | After |
| --- | --- |
| ![before](before.png) | ![after](after.png) |

More: [block form](after-block.png), [mask default badge in Settings](settings.png). "Before" is the same dialog with the
new tab hidden (the tab is the only difference).

## Settings

No toggle. It is an admin feature (Mask Admin, mask-wide per AGENTS.md); members keep full control: any setting they
change themselves overrides the mask default, and Settings > Reset goes back to the mask default. The "mask default"
badge only appears on settings an admin chose.

## Change

- New: `maskadmin/maskadmin.inc.php` (levels, grant/revoke/block/unblock/remove, defaults, audit), `public/mask_admins.php`
  (JSON endpoint with the fork's CSRF pattern; the mask is always the session's), `app/js/fork/mask-admin-tab.js`,
  `app/js/fork/mask-defaults.js`, `app/css/fork/mask-admin-tab.css`, `docker/sql/mask-admins.sql`, tests
  (`tests/mask_admins_test.php`, `app/js-test/fork/mask-defaults.test.js`), docs in `docker/README.md#mask-admins`.
- Tables created on first use: `fork_mask_admins`, `fork_mask_blocks`, `fork_mask_defaults`, `fork_mask_audit`.
- Enforcement of blocks: `docker/db.inc.php` (fork-owned, loaded by every endpoint) drops a blocked character's session
  to their corp mask before any endpoint reads `$_SESSION['mask']`.
- **Upstream files touched (one line each):** `lib.inc.php` (`checkAdmin()` also accepts granted admins),
  `masks.inc.php` (blocked masks are left out of the mask list), `public/masks.php` (deleting a mask stays with the
  owner / corp admins, via `maskadmin_corp_admin()`).
- Defaults are applied in the browser by wrapping `options.get` / `options.apply`; inherited values are not saved
  as personal choices.
