## What

<!-- What changed and why, in plain language. -->

## Screenshots

| Before | After |
| --- | --- |
|  |  |

## Checklist (see AGENTS.md)

- [ ] Change-log entry in `changes/YYYY-MM-DD-<feature>/` (with before/after)
- [ ] User-facing? What's New entry in `public/whats-new/features.json` with this PR's number
- [ ] User-facing? Entry in `public/fork/feature-catalog.json`, success signal: ..., analytics evidence (`forkUsage.debug` console lines or SQL result) below
- [ ] **Settings toggle?** Yes: Settings > ... > ... (on by default) / No, because ...
- [ ] **Feature tip?** Yes: `forkHints.register` id ..., trigger ... / No, because ... (visible button, bug fix, ...)
- [ ] Tests added/updated; `npx mocha --recursive app/js-test` passes
- [ ] No reformatting of unrelated code; ported from upstream? Upstream commit credited in the change-log entry
- [ ] Version bump: default (feature = minor, other = patch, docs = none) or a `semver:*` label
