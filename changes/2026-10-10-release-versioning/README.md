# Release versioning

**Date:** 2026-10-10

## Description

Every merge to `main` now becomes a numbered release (`vX.Y.Z` tag, GitHub Release, versioned Docker
image), so deployments can pin a version and users can see which one they run.

## Change

- New `.github/workflows/ci.yml` for PRs and main (tests, bundle freshness, PHP lint, JSON, actionlint,
  shellcheck). PRs no longer build the Docker image; only `main` builds and pushes it.

- `.github/workflows/docker-publish.yml` restructured into three jobs: `version` (computes the next
  version; on PRs writes the would-be version to the job summary), `build` (builds; pushes only on a
  release) and `release` (annotated tag + `gh release create --generate-notes`, after the image is pushed).
  Manual run with a `bump` input forces a release; runs on `main` are serialized (`release-main`).
- Bump rules in `.github/scripts/next-version.sh` (tests: `test-next-version.sh`): `semver:*` PR labels,
  else What's New entry = minor, docs-only = no release, else patch. First release is `v1.0.0`.
- Image tags are now `X.Y.Z`, `X.Y`, `X`, `latest`, `upstream-1.30b`, `sha-<commit>`. The bare upstream
  version tag (`1.30b`) and the `v*` tag trigger are gone.
- `docker/Dockerfile`: `TRIPWIRE_FORK_VERSION` build arg/env, writes `public/version.json` in the image.
- `app/js/whats-new.js`, `app/css/whats-new.css`: version line in the What's New dialog footer and next to
  Settings > What's new ("dev" when there is no `version.json`, e.g. the dev stack).
- No upstream files touched. Docs: `docker/README.md` (Publishing), `AGENTS.md` (Commits and PRs).
