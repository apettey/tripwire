# Retire upstream sync

**Date:** 2026-11-15

## Description

The fork no longer stays in sync with upstream Tripwire (bitbucket.org/daimian/tripwire): it has drifted too
far, and the upstream 2.0 sync PR #172 was closed unmerged. Useful upstream changes are now ported one at a
time as ordinary features, so the sync machinery and the rules that only existed to keep syncing easy are gone.

## Settings

No toggle, because this is internal (repository tooling and working rules); nothing changes for users.

## Change

- Removed `.github/workflows/upstream-sync.yml`, `.github/scripts/sync-upstream.sh` and `.github/upstream-base`
  (the fork was started from upstream `production` at `6682a89`; that is now recorded in `docker/README.md`).
- `AGENTS.md`: the intro says the fork no longer syncs and upstream is a source of ideas to port; §3 is now
  "Upstream code and porting upstream changes" (editing upstream files is fine, new features still go in
  fork-owned files to stay modular and testable, no reformatting sweeps, credit the upstream commit when porting).
  Listing touched upstream files in the change-log entry is no longer required.
- Updated to match: `.claude/skills/tripwire-feature/SKILL.md`, `changes/_template.md`,
  `.github/pull_request_template.md`, `README.md` (attribution note), `docker/README.md` (file table, the
  "Avoid editing upstream files" line, "Pulling upstream changes" replaced by an "Upstream" section on porting)
  and a comment in `app/js-test/fork/game-data-24-01.test.js`.
- Releases still report the upstream Tripwire version the code is based on (`VERSION` in `settings.php`, the
  `upstream-<version>` image tag); `next-version.sh`, `open-infra-pr.sh` and the release workflow are unchanged.
