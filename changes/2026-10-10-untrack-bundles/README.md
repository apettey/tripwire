# Stop committing the built bundles

**Date:** 2026-10-10

## Description

`public/js/app.min.js` / `public/css/app.min.css` (and their maps) are build output that every branch
touching `app/` rewrote, so they conflicted on almost every merge. Nothing used the committed copies:
the Docker image and the dev stack build their own. They are now git-ignored.

## Settings

No toggle, because nothing changes for users.

## Change

- Bundles untracked and added to `.gitignore` (upstream file, four lines appended).
- The Docker image and CI build with `docker/gulpfile.dev.js` instead of upstream's `gulpfile.js`. Upstream's
  concatenates in file-system order, which on Linux put 16 lines of `app.min.js` in a different order than
  the sorted dev build, so the image could ship fork scripts before the ones they depend on.
- The dev `assets` service builds the bundles on start, then watches.
- CI checks the bundles build instead of comparing them to a committed copy (`check-bundles.js` removed).
- `sync-upstream.sh` leaves out upstream's bundle changes.
- AGENTS.md, docker/README.md, the PR template and the `tripwire-feature` skill no longer say to commit bundles.
