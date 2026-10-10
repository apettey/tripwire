# Agent context docs and skills

**Date:** 2026-10-10

## Description

Added an EVE Online wormhole primer and two Claude Code project skills so AI agents (and new
contributors) without EVE knowledge understand the domain and the fork's feature workflow.

## Change

- `docs/eve-wormhole-primer.md`: condensed EVE/wormhole primer, how wormhole corps use maps, how
  Tripwire's data model and code map onto it, and a glossary.
- `.claude/skills/tripwire-domain/SKILL.md`: points agents at the primer and the key globals/entry points.
- `.claude/skills/tripwire-feature/SKILL.md`: checklist for shipping a user-facing feature (fork files,
  tests, bundles, test data, screenshots, change log, What's New, PR, merge).
- `AGENTS.md`: new "0. Context" section linking the above. No code or upstream files changed.
