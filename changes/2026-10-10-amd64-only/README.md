# Docker image: amd64 only

**Date:** 2026-10-10

## Description

Release images are built for `linux/amd64` only again. Building `linux/arm64` under QEMU (PHP
extensions such as intl and gd compiled under emulation) made every release build very slow, and
nobody runs the image on arm64 yet.

## Settings

No toggle: CI/image change only, nothing in the Tripwire UI changes.

## Change

- `.github/workflows/docker-publish.yml`: `platforms: linux/amd64`, no `docker/setup-qemu-action`.
  Everything else is unchanged (version job, tags, explicit `org.opencontainers.image.version` label,
  `TRIPWIRE_FORK_VERSION` build arg, GHA cache, release after the image push).
- `docker/README.md` (Publishing > Image tags) says the images are amd64 only and that arm64 can be
  added back with native arm64 runners (`ubuntu-24.04-arm`, one build per platform merged into a
  manifest list) instead of QEMU.
- `docker/Dockerfile` is unchanged: the `assets` and `src` stages keep `--platform=$BUILDPLATFORM`,
  which is a no-op for an amd64-only build and ready for arm64 later.
- Supersedes the arm64 part (#9.4) of [Docker image hardening](../2026-10-10-image-hardening/README.md).
