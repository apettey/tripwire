# PHP 8.5.13, nginx 1.30.7 and OpenSSL fixes

**Date:** 2026-11-22

## Description

Rebuilds the image so production picks up the latest PHP patch release and Alpine security fixes. The
running 1.98.2 image has nginx 1.30.6, which misses the 18 Nov 2026 nginx security release, plus OpenSSL and
libxml2 versions that Alpine has since patched.

## Settings

No toggle: security update, nothing for a user to choose.

## Change

- `docker/Dockerfile`: `php:8.5.12-fpm-alpine3.24` → `php:8.5.13-fpm-alpine3.24` (both stages);
  `docker-compose.dev.yml` Discord mock on `php:8.5.13-cli-alpine` to match (CI's PHP syntax job checks it);
  `docker/README.md` version note.
- The runtime stage's `apk upgrade` / `apk add` then take the Alpine 3.24 fixes released since 1.98.2 was built:
  nginx 1.30.6 → 1.30.7 (its security fixes include CVE-2026-125283, CVE-2026-123007, CVE-2026-123633, CVE-2026-121810, CVE-2026-123634,
  CVE-2026-118899, CVE-2026-113425), OpenSSL 3.5.9-r0 → r1 (security patches), libxml2 2.13.9-r2 → r3
  (CVE-2026-86144), mariadb-client 11.8.9 → 11.8.10.
- Exposure was low: our nginx serves plain HTTP/1.1 on port 80 behind Caddy, without HTTP/2, HTTP/3, TLS,
  `alias`, `resolver` or the mail module, where most of these bugs are.
