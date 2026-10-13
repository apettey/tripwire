# Hole names: size digit only once

**Date:** 2026-10-13

## Description

Suggested hole names marked every medium or small hole with a digit, so a chain of medium holes gave names like
`A678`. A size digit is now added only when a hole is more restrictive than the path to it: past a medium hole,
medium and large holes get letters (`A6` -> `A6A`) and only a small hole gets a digit again (`A61`); past a small
hole everything gets letters.

## Settings

No new toggle: this refines the existing Settings > Signatures > Suggest hole names, which still turns it off.

## Change

`app/js/fork/hole-naming.js`: new `holeNaming.pathSize(token)`; `nextName` drops to letters when the prefix
already marks the hole's size or a smaller one. Tests in `app/js-test/fork/hole-naming.test.js`. `docs/eve-wormhole-primer.md` updated. No upstream files touched.
