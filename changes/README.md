# Change log

Every change to this fork gets an entry here. See [AGENTS.md](../AGENTS.md) for the rules and
[_template.md](_template.md) for the format. Newest first.

| Date | Feature | Summary |
| --- | --- | --- |
| 2026-10-10 | [Favourites panel](2026-10-10-favourites-panel/README.md) | Movable panel to add, remove and drag-reorder favourites, choose which are drawn on the chain map, and highlight the shortest or high-sec-only route to them from your location |
| 2026-10-10 | [Kill Reporting](2026-10-10-kill-reporting/README.md) | Sounds and pop-ups for kills in the chain (small gank, gank, friendly kill, friendly loss) from a single server-side zKillboard feed; selectable sound pack with per-event volume |
| 2026-10-10 | [Docker image: amd64 only](2026-10-10-amd64-only/README.md) | Release images are `linux/amd64` only; arm64 under QEMU made releases very slow and has no users yet |
| 2026-10-10 | [Docker image hardening](2026-10-10-image-hardening/README.md) | No upstream analytics/PayPal panel in the image, runtime files only, arm64, utf8mb4, `DB_SSL`, full env var table, fork version as the app version (#9) |
| 2026-10-10 | [Hole size tags on the chain map](2026-10-10-size-tags/README.md) | Each chain map node shows the max ship size (S/M/L/VL/XL) of its connection; XL (capitals) highlighted |
| 2026-10-10 | [Saved destinations](2026-10-10-route-destinations/README.md) | Destinations window with jumps from the chain to saved k-space systems, optionally drawn on the chain map |
| 2026-10-10 | [Jump return bookmark](2026-10-10-jump-return/README.md) | After jumping out through a named hole, a panel offers the return bookmark (`<AB`) to copy |
| 2026-10-10 | [Hole naming](2026-10-10-hole-naming/README.md) | Auto-suggested hierarchical wormhole names; bookmark string copied on Add/Save |
| 2026-10-10 | [Rally point](2026-10-10-rally/README.md) | Mark a chain map system as the rally point for everyone on the mask, with the wormhole route to it highlighted |
| 2026-10-10 | [Agent context](2026-10-10-agent-context/README.md) | EVE wormhole primer for agents, `tripwire-domain` and `tripwire-feature` Claude Code skills |
| 2026-10-10 | [Release versioning](2026-10-10-release-versioning/README.md) | Every merge to `main` gets a SemVer tag, GitHub Release and versioned image; version shown in What's New |
| 2026-10-10 | [Wormhole type quick picks show statics](2026-10-10-sig-quickpicks/README.md) | Signature dialog type quick picks show the system's statics, statics first, no more stale buttons |
| 2026-10-10 | [What's New](2026-10-10-whats-new/README.md) | "What's New in Tripwire" window announcing new fork features, reopenable from Settings |
| 2026-10-10 | [Docker image and dev stack](2026-10-10-docker-image-and-dev-stack/README.md) | Self-contained `petdog/tripwire` image, Docker Hub publishing, local dev stack |
| 2026-10-10 | [Fork setup](2026-10-10-fork-setup/README.md) | Imported upstream snapshot, upstream sync tooling, working rules |
