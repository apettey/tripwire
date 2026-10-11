# Stacked PRs

**Date:** 2026-10-11

## Description

New features and fixes now stack on the newest open PR instead of all branching from `main`, so open PRs form one chain and stop conflicting on `changes/README.md`, `features.json` and Settings rows.

## Change

- `.claude/skills/tripwire-feature/SKILL.md`: section 1 says branch from the top of the stack (or `main` when nothing is open), and that the coordinator rebases parallel work onto the stack and edits the shared index files; section 8 says open the PR against the stacked-on branch with "Stacked on #M"; section 9 says merge bottom-up (head branches are deleted on merge, so the next PR retargets to `main`).
- `AGENTS.md` §5: same rule in one line.

Docs only, no app change.
