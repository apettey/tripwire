# gulp-mocha 10

**Date:** 2026-10-28

## Description

Dependabot bumped gulp-mocha from 8.0.0 to 10.0.1. Version 10 is ESM-only, so `require('gulp-mocha')` now returns the
module namespace instead of the plugin function and `npx gulp test` failed with "mocha is not a function".

## Settings

No toggle, because this only changes the test tooling.

## Change

`gulpfile.js` takes the plugin from `require('gulp-mocha').default` (Node 24's `require()` of an ES module). CI, the
bundle build and the Docker image never call the plugin, so they were not affected.

Upstream files touched: `gulpfile.js` (one line).

Tested: `npx gulp test` in `node:24-bookworm-slim` (3431 passing, exit 0), mocha CLI and the bundle build. On Windows
directly, `gulp test` still stops with "The command line is too long" (gulp-mocha passes every test file to `mocha`);
that already happened with 8.0.0, so use the `assets` container or `npx mocha --recursive app/js-test` there.
