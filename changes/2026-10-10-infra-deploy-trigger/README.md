# Deploy releases to eve-infrastructure

**Date:** 2026-10-10

## Description

Every release now opens a PR in the private `apettey/eve-infrastructure` repo that pins the new
`petdog/tripwire:X.Y.Z` by digest, with squash auto-merge, so production updates once infra's required
checks pass. A `deploy:manual` label on a fork PR keeps that infra PR from auto-merging.

## Settings

No toggle: internal release tooling, nothing users see.

## Change

- New `.github/workflows/infra-deploy.yml` (reusable + manual "Deploy release to infra" with `version`,
  `auto_merge`, `allow_downgrade`, `dry_run`; `main` only) and `.github/scripts/open-infra-pr.sh`.
- `.github/workflows/docker-publish.yml`: new `infra` job after `release` (fork-owned file).
- Uses the new secret `INFRA_REPO_TOKEN` (fine-grained PAT for eve-infrastructure only) from the
  `infra-deploy` environment (`main` only); skipped with a warning while it is missing. Public logs show
  only the image change, never infra contents. Calls only GitHub and Docker Hub; no new third-party hosts.
- Docs: [docker/README.md](../../docker/README.md#deploying-to-eve-infrastructure), AGENTS.md section 5.
- No upstream files touched.
