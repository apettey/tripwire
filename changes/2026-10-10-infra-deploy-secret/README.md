# Infra deploy: pass the environment secret to the release path

**Date:** 2026-10-10

## Description

The v1.9.0 release skipped its eve-infrastructure PR because `INFRA_REPO_TOKEN` resolved to an empty
string in the called `infra-deploy.yml` workflow; manual runs of the same workflow worked. A called
workflow only sees environment secrets when its caller passes secrets, so the `infra` job now uses
`secrets: inherit`.

## Settings

No toggle: internal release tooling, nothing users see.

## Change

- `.github/workflows/docker-publish.yml`: `secrets: inherit` on the `infra` job (fork-owned file).
  The called workflow also receives the other repo secrets (Docker Hub) but does not reference them.
- `docker/README.md`: one note on why.
- No upstream files touched.
