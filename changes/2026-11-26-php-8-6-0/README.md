# PHP 8.6.0

**Date:** 2026-11-26

## Description

Moves the image from PHP 8.5.13 to 8.6.0, released on 23 Nov 2026. It is a manual upgrade, because Dependabot now
proposes only PHP patch releases (after its 8.6.0RC7 bump broke `main`, see
[the fix](../2026-11-25-fix-main-php-rc-glob-parent/README.md)).

## Settings

No toggle: a runtime upgrade, nothing for a user to choose.

## Change

- `docker/Dockerfile`: `php:8.5.13-fpm-alpine3.24` → `php:8.6.0-fpm-alpine3.24` (both stages), and
  docker-php-extension-installer 2.12.3 → 2.13.4 (2.12.3 stops with "Unsupported PHP version: 8.6").
  `docker-compose.dev.yml`: the Discord mock is on `php:8.6.0-cli-alpine` to match (CI's PHP syntax job checks it).
  `docker/README.md` has the new version.
- The official 8.6 images are thread-safe (ZTS) builds, where 8.5 was NTS. php-fpm, OPcache, gd, intl, mbstring
  and pdo_mysql all run as before.
- Checked on a dev stack against both versions. Every PHP file lints clean on 8.6 with E_ALL, and the PHP tests
  give the same results on 8.5.13 and 8.6.0 (`analytics_dashboard_test` fails on both: it expects #114 among the
  last 15 What's New launches). Dev login and the map page work. The php-fpm log shows the same deprecations as on
  8.5.13 (`login.php:96`, `refresh.php:333/368`), nothing new.
