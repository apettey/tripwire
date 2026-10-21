# PHP 8.3.36 security update (PHP2Shell)

**Date:** 2026-10-21

## Description

PHP2Shell (CVE-2026-109618, CVE-2026-109619) is a pair of critical, unauthenticated remote code execution
flaws in PHP itself, fixed in PHP 8.3.36 on 2026-10-21. The image now builds on `php:8.3.36-fpm-alpine3.24`
instead of the floating `php:8.3-fpm-alpine3.24`, so a cached base layer can't ship an unpatched PHP.

## Settings

No toggle, because it is a security fix with no visible change.

## Change

- `docker/Dockerfile`: both PHP stages pinned to `php:8.3.36-fpm-alpine3.24`; bump the patch version on each
  PHP security release.
- `docker-compose.dev.yml`: dev Discord mock pinned to `php:8.3.36-cli-alpine`.
- No upstream files touched. Self-hosters running upstream's own setup must update PHP to 8.3.36 / 8.4.27 /
  8.5.12 / 8.2.35 themselves.
