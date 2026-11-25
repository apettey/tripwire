# Fix main: PHP back to 8.5.13, glob-parent 7 in the bundle build

**Date:** 2026-11-25

## Description

Two Dependabot merges broke `main` (CI and the Docker image both failed, so no release went out). #190 moved the
image to the PHP release candidate `8.6.0RC7`, and #189's glob-parent 7 is an ES module, so the bundle build stopped
with `globParent is not a function`.

## Settings

No toggle, because this is a build fix with no user-visible change.

## Change

- `docker/Dockerfile`: back to `php:8.5.13-fpm-alpine3.24`. With `8.6.0RC7`, docker-php-extension-installer 2.12.3
  stopped with "Unsupported PHP version: 8.6", and CI's PHP syntax job failed because `docker-compose.dev.yml` was still on 8.5.13.
- `docker/gulpfile.dev.js`: uses glob-parent's default export when `require()` returns the ES module namespace
  (glob-parent 7), and still accepts the plain function (6). Both return the same bases for every glob in
  `gulpfile.js`, so file order and source-map paths stay the same.
- `.github/dependabot.yml`: Dependabot now proposes only PHP patch releases. A new PHP minor (8.6) is a manual
  upgrade, because its first tags are release candidates and the extension installer and dev compose images have
  to be upgraded with it. `docker/README.md` says so.
