# Build tooling updates

**Date:** 2026-10-22

## Description

Dependabot's updates to the gulp build tooling, merged as one change because their lockfiles conflict:
gulp-shell 0.6.5 -> 0.8.0 (#130), pump 1.0.3 -> 3.0.4 (#131), gulp-notify 3.2.0 -> 5.0.0 (#133),
gulp-sourcemaps 2.6.4 -> 3.0.0 (#136).

## Settings

No toggle, because nothing changes for users.

## Change

`package.json` / `package-lock.json` only. Checked on Node 20: `app.min.js` and `app.min.css` are byte-identical to
`main`'s and all 3430 mocha tests pass. No release (`semver:skip`).
