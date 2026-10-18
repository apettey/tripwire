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
- [ ] Tests added/updated; `npx mocha --recursive app/js-test` passes
- [ ] Upstream files touched (list them, keep the diff minimal): none
- [ ] Version bump: default (feature = minor, other = patch, docs = none) or a `semver:*` label
