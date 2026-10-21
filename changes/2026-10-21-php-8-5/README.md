# PHP 8.5 upgrade

**Date:** 2026-10-21

## Description

The image moves from PHP 8.3.36 to PHP 8.5.12 (supported until the end of 2029; 8.3 only gets security fixes until
the end of 2027). Tested locally with the full PHP and JS test suites on 8.5 and 8.3 side by side, plus a click-through
of the app.

## Settings

No toggle, because nothing changes for users.

## Change

- `docker/Dockerfile`: `php:8.5.12-fpm-alpine3.24` (docker-php-extension-installer 2.7.24 installs pdo_mysql, gd, intl,
  mbstring on 8.5 unchanged).
- `docker-compose.dev.yml`: Discord mock on `php:8.5.12-cli-alpine`.
- CI "PHP syntax" job lints in `php:8.5.12-cli-alpine` (was the runner's PHP) and fails on compile-time
  deprecations and warnings.
- New `docker/dev/run-php-tests.sh`: runs every PHP test script in the dev stack with `E_ALL`, failing on any PHP
  Deprecated / Warning / Notice (documented in `docker/README.md` and `AGENTS.md`).
- PHP 8.4+ `round()` no longer pre-rounds: 1.5 AU parsed as 224396806.0 km instead of .1. `intel/intel.inc.php`
  now rounds AU distances in whole tenths. Security status rounding was checked for all 8289 systems: unchanged.
- PHP 8.5 deprecations removed: `curl_close()` calls (no-op since PHP 8.0) and, in tests,
  `PDO::sqliteCreateFunction()` (now `Pdo\Sqlite::createFunction()`).
- Upstream file touched: `password_hash.php` (one line, `intdiv` for the bcrypt cost digit: it logged a float to int
  deprecation on every password hash, on 8.3 too).
- Not changed (already logged on 8.3): "passing null" deprecation notices from upstream `public/refresh.php` and
  `public/login.php`; failing `jump_fit`, `mask_access` and `mask_admins` tests.
