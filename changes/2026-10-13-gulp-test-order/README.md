# gulp test: same results as the mocha CLI

**Date:** 2026-10-13

## Description

`npx gulp test` reported 71 failing tests and crashed with an unhandled rejection, while `npx mocha "app/js-test/**/*.js"`
passed everything. The tests shared global state that depended on which test file the runner loaded last, and gulp loads
them in a different order (top-level files first, then subfolders) than the mocha CLI (sorted).

## Settings

No toggle, because this only changes the test setup.

## Change

- `include('public/js/combine')` in the test helpers now loads the game data once, with the generic system types on top
  (as the app's bundle does), and every test file shares that same `appData`. Before, each file re-created `appData`,
  only some added the generic system types, and the last file loaded decided what all tests saw (under gulp:
  `fork/watchlist.test.js`, without them).
- The fake DOM used by `maskRendering.test.js` removes its global `document` after each test, so it no longer leaks into
  `fork/life-wording.test.js` ("does nothing without a document").
- The gulp `test` task returns its stream, so a failing test now ends gulp with `'test' errored` and exit code 1 instead of
  an `UnhandledPromiseRejection` crash after gulp had already reported success.

Upstream files touched: `gulpfile.js`, `app/js-test/helpers/helpers.js`, `app/js-test/helpers/fakeDOM.js`,
`app/js-test/maskRendering.test.js`.
