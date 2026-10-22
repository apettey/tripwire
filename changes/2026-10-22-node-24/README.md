# Node 24 LTS for builds and tests

**Date:** 2026-10-22

## Description

Node 20 reached end of life on 2026-04-30. The image's asset stage, the dev `assets` service and CI's JS job now use
Node 24 LTS (supported until 2028-04-30). Dependabot's Node 25 bump (#132) was not taken: 25 ended on 2026-06-01.
This also lets jsdom move to 30 (Dependabot #137 failed on Node 20 because jsdom 30 needs Node 22+).

## Settings

No toggle, because nothing changes for users.

## Change

- `docker/Dockerfile` (assets stage), `docker-compose.dev.yml` (`assets`), `.github/workflows/ci.yml`: Node 20 -> 24.
- `package.json` / `package-lock.json`: jsdom 24.1.3 -> 30.1.3 (tests only).
- Checked: `app.min.js` / `app.min.css` built on Node 24 are byte-identical to `main`'s Node 20 build; all 3430
  mocha tests pass; the image builds. No release (`semver:skip`): the shipped files are unchanged.
