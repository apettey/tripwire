---
name: tripwire-feature
description: End-to-end checklist for implementing and shipping a user-facing feature in this Tripwire fork - branch, fork-owned JS/CSS files, mocha tests, dev stack and bundles, seeding test data, screenshots, change-log entry, review loop until no findings, What's New entry, PR and merge. Use when building, testing, screenshotting or opening a PR for a UI/feature change (not for docs-only or infrastructure changes).
---

# Shipping a Tripwire fork feature

Rules live in [AGENTS.md](../../../AGENTS.md); domain background in the `tripwire-domain` skill and
[docs/eve-wormhole-primer.md](../../../docs/eve-wormhole-primer.md). Work through this list in order.

## 1. Branch and plan
- [ ] `git checkout main && git pull && git checkout -b feature/<name>` (one feature per branch/PR).
- [ ] Start the dev stack: `docker compose -f docker-compose.dev.yml up --build` (http://127.0.0.1:8080).
- [ ] Take the **before** screenshot now, before editing (see step 5).
- [ ] Answer **"does it need a Settings toggle?"** (AGENTS.md section 2). Default yes for user-facing
      features: on by default, `options.<feature>.enabled` (missing = on), a row in the matching Settings
      section injected from your JS, applied on Save, surviving Reset. Write the answer in the PR.

## 2. Code in fork-owned files
- [ ] JS in `app/js/fork/<feature>.js`, CSS in `app/css/fork/<feature>.css`. Gulp bundles
      `app/js/**/*.js` and `app/css/**/*.css`, so new files are picked up automatically (fork JS loads
      after upstream JS).
- [ ] Wrap or extend upstream instead of editing it: hook DOM events, wrap globals
      (`const orig = chain.redraw; chain.redraw = function() { orig.apply(this, arguments); ... }`),
      use `systemAnalysis.addMutator`, add jump-cost modifiers to `guidance`, etc.
- [ ] If an upstream file must change, keep the diff tiny, keep its line endings, and list it in the
      change-log entry.
- [ ] Put pure logic (no DOM) in one global object so it can be unit-tested.

## 3. Tests (mocha)
- [ ] Tests in `app/js-test/fork/<feature>.test.js`, loading the script with
      `const { include } = require('../helpers/helpers'); include('app/js/fork/<feature>');`
- [ ] Helper quirk: `include()` turns the file into globals by stripping the **first** `const ` /
      `var `. The file's first line must be `const <name> = {` (or `const <name> = new function() {`);
      no comment or other `const` above it, or the object won't be global.
- [ ] Other helpers: `fake$`, `fakeAjax`, `loadJSON` in `app/js-test/helpers/helpers.js`; test data
      in `app/js-test/testdata/`. Code that needs `appData` must have it faked in the test.
- [ ] Run: `MSYS_NO_PATHCONV=1 docker compose -f docker-compose.dev.yml exec -T assets npx mocha --recursive app/js-test`
      (`MSYS_NO_PATHCONV` stops Git Bash on Windows mangling paths). All tests must pass.

## 4. Bundles
- [ ] The `assets` service builds `public/js/app.min.js` and `public/css/app.min.css` on start and
      rebuilds them on save. They are git-ignored build output: **don't commit them** (CI and the
      Docker image build their own). To rebuild by hand, use the dev gulpfile (it orders the files
      deterministically: globs in order, files sorted within each glob):
      `MSYS_NO_PATHCONV=1 docker compose -f docker-compose.dev.yml exec -T assets npx gulp --gulpfile docker/gulpfile.dev.js --cwd /src js css`.
      Not plain `npx gulp js css`: upstream's gulpfile concatenates in file-system order.
- [ ] Script order matters (fork files depend on each other): files load in gulpfile glob order, sorted
      by path within a glob, so a fork file loads after the fork files it uses only if it sorts after them.

## 5. Try it in the browser
- [ ] Dev login: `docker compose -f docker-compose.dev.yml exec app bash /opt/app/docker/dev-seed.sh`,
      then user `dev` / `dev-password` on the "Tripwire" tab of the login page (docker/README.md).
- [ ] Simulate a jump (no ESI token in dev), from the browser console, call twice:
      `tripwire.EVE({characterID: 1, characterName: 'Test', systemID: <from>})` then the same with
      the destination `systemID`. With the automapper on, this maps a hole.
- [ ] Seed a wormhole from the console:
      ```js
      tripwire.refresh('refresh', {signatures: {add: [{
        wormhole: {type: 'H296', parent: 'initial', life: 'stable', mass: 'stable'},
        signatures: [
          {signatureID: 'abc123', systemID: <fromID>, type: 'wormhole', name: 'A', lifeLength: 86400},
          {signatureID: 'xyz789', systemID: <toID or genericSystemTypes index>, type: 'wormhole', name: '', lifeLength: 86400}
        ]}]}}, d => console.log(d), () => {});
      ```
      `parent: 'initial'` means the first signature has the real type and the second is the K162.
- [ ] Screenshots with the built-in browser: emulate an 800x600 viewport, run
      `document.documentElement.style.zoom = 1.4`, position dialogs with CSS `top`/`left` so they
      frame well, capture with the zoom/region action, then copy the saved PNG from the tool-results
      folder into the repo (`changes/...` and `public/whats-new/img/`).

## 6. Change log (required)
- [ ] `changes/YYYY-MM-DD-<feature>/README.md` from `changes/_template.md` with `before.png` /
      `after.png`; add the top row to `changes/README.md`.

## 7. Review loop (required, before the PR)
Every feature is reviewed until a review comes back with **no findings**. Don't open the PR before that.
- [ ] Commit, then hand the branch to a **fresh reviewer** (a new agent/session that didn't write the
      code; when an agent built it, the coordinating session spawns the reviewer). Give it the branch,
      the diff against `origin/main` (`git diff origin/main...HEAD`), the feature's spec, and this list.
- [ ] The reviewer checks, and reports each finding with file:line, what's wrong and why:
  - correctness and edge cases against the spec (unknown/missing data, empty chain, several tracked
    characters, other users' changes arriving via sync);
  - AGENTS.md rules: change-log entry and row, Settings toggle decision (on by default, applied on
    Save, survives Reset), fork-owned files, small upstream edits listed in the entry, no reformatting
    or line-ending changes, no committed bundles;
  - security: pasted/user text escaped when rendered, no new CSRF/XSS, no secrets, no new third-party
    hosts unless logged; all zKillboard access only through the pooled worker;
  - tests: pure logic covered by mocha, tests pass
    (`MSYS_NO_PATHCONV=1 docker compose -f docker-compose.dev.yml exec -T assets npx mocha --recursive app/js-test`);
  - it actually works in the dev stack, and the screenshots show the final version.
- [ ] The author fixes every finding (or answers why it's not a problem), commits, and the reviewer
      reviews **again from the new diff**. Repeat until a round returns no findings. Where possible use
      the same reviewer each round so it can check its earlier findings were addressed.
- [ ] Note the number of review rounds in the PR body.

## 8. PR and What's New
- [ ] Commit, push, open the PR against `main` **first** to learn its number `<N>`.
- [ ] Add the entry at the top of `public/whats-new/features.json`: `pr: <N>`, `date`, `title`,
      plain-text `description`, `images` saved as `public/whats-new/img/pr-<N>-<name>.png`.
- [ ] PR body: what changed, link to the change-log entry, before/after screenshots as
      `https://raw.githubusercontent.com/<owner>/<repo>/<commit sha>/<path>` (pin the SHA so images
      survive branch deletion). End with the attribution line.
- [ ] Image builds: `docker build -f docker/Dockerfile -t tripwire:local .`

## 9. Merge
- [ ] Merge with a **merge commit** (not squash/rebase).
