# PHP test fixes

**Date:** 2026-10-22

## Description

Three PHP test scripts failed on every PHP version, so `docker/dev/run-php-tests.sh` could not go green. The tests were
wrong, not the app: two never sent the CSRF token that options.php and masks.php want since the
[App security fixes](../2026-10-21-app-security-fixes/README.md), one still used the API password login that is now off
by default, and one had a fixed test date that had gone stale.

## Settings

No toggle, because nothing users see changed (tests only).

## Change

- `tests/mask_access_test.php`: after logging in it reads the session's token from the app page's
  `<meta name="csrf-token">` and sends it as `X-CSRF-Token` on options.php, like `app/js/fork/csrf.js`. Its REST API
  part used the HTTP Basic password login, which answers 401 unless `TRIPWIRE_API_PASSWORD_AUTH` is on. With the
  switch off it now checks that the password login is refused, and runs upstream's mask check
  (`api/auth.php`, `api/signatures/get.php`) in a CLI PHP instead. With the switch on it tests over HTTP as before.
- `tests/mask_admins_test.php`: the fixture sessions carry a CSRF token (as `csrf.inc.php` stores it), and the
  options.php / masks.php posts send it. The "granted admin cannot ..." and outsider checks were passing only
  because the token was missing; they now test the mask permission again.
- `tests/jump_fit_test.php`: the database part builds its report with a fit time relative to the real clock. The
  fixed test date had fallen outside the 7-day window, so `jump_fit_clean_report` rightly dropped the fit time.

No upstream files touched.
