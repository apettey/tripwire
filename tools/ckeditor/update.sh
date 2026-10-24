#!/usr/bin/env bash
# Rebuild public/ckeditor/ from the official CKEditor 4 release (npm package ckeditor4) plus the
# GitHub source tag (for the moono skin sources our custom skin is based on).
#
#   tools/ckeditor/update.sh [version]      # default 4.22.1, the last open-source CKEditor 4
#
# The GitHub tarball is checked against a pinned sha256 (npm checks its own package). For another version,
# set CKEDITOR_SRC_SHA256 to that tarball's sha256 (the script prints it when it doesn't match).
#
# What it does:
#   - copies ckeditor.js, contents.css, styles.js, LICENSE.md and lang/en.js from the npm package
#   - keeps only the plugin folders our plugin set (config.js `plugins`) loads at runtime
#   - patches autogrow so it doesn't grow on startup when the editor opens maximized (toolbarswitch)
#   - builds skins/custom: the release's moono skin sources with our edits (port-skin.js), @imports
#     inlined, plus moono's icon sprite rules, like CKBuilder would
#   - restyles contents.css (the editing area) for Tripwire's dark UI
# Files it leaves alone: config.js and the third-party plugins/toolbarswitch and plugins/autolink (kept over the
# core autolink because it also links bare www. addresses), plugins/font.png, plugins/font_size.png.
set -euo pipefail

VERSION="${1:-4.22.1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST="$REPO/public/ckeditor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching ckeditor4@$VERSION (npm) and the $VERSION source tag (GitHub)..."
(cd "$WORK" && npm pack "ckeditor4@$VERSION" --silent >/dev/null && tar xzf "ckeditor4-$VERSION.tgz")
case "$VERSION" in
	4.22.1) PINNED_SHA256=80e336858cfe5a4c0ad45ea8479e75a1617b5b97f5fd45dc3315fc7a41b2e58c ;;
	*) PINNED_SHA256="" ;;
esac
EXPECTED_SHA256="${CKEDITOR_SRC_SHA256:-$PINNED_SHA256}"
curl -fsSL -o "$WORK/src.tar.gz" "https://github.com/ckeditor/ckeditor4/archive/refs/tags/$VERSION.tar.gz"
ACTUAL_SHA256="$(sha256sum "$WORK/src.tar.gz" | cut -d' ' -f1)"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
	echo "Source tarball sha256 is $ACTUAL_SHA256, expected ${EXPECTED_SHA256:-(none pinned for $VERSION)}." >&2
	echo "Check the release, then rerun with CKEDITOR_SRC_SHA256=<sha256>." >&2
	exit 1
fi
tar xzf "$WORK/src.tar.gz" -C "$WORK"
PKG="$WORK/package"
SRC="$WORK/ckeditor4-$VERSION"

# Plugin folders loaded at runtime (everything else in our plugin set is inside ckeditor.js). Checked below
# against config.js's plugin list, so a plugin added there without its folder stops the script.
PLUGIN_DIRS="autogrow clipboard colorbutton colordialog dialog font indentblock link panelbutton"

echo "Replacing release files in $DEST..."
rm -rf "$DEST/lang" "$DEST/skins/custom"
# Everything under plugins/ except our own files comes from the release.
find "$DEST/plugins" -mindepth 1 -maxdepth 1 ! -name toolbarswitch ! -name autolink ! -name font.png ! -name font_size.png -exec rm -rf {} +
mkdir -p "$DEST/lang" "$DEST/plugins"
cp "$PKG/ckeditor.js" "$PKG/contents.css" "$PKG/styles.js" "$PKG/LICENSE.md" "$DEST/"
cp "$PKG/lang/en.js" "$DEST/lang/"
cp "$PKG/plugins/icons.png" "$PKG/plugins/icons_hidpi.png" "$DEST/plugins/"
for d in $PLUGIN_DIRS; do
	cp -r "$PKG/plugins/$d" "$DEST/plugins/"
	# English only (config.language = 'en').
	if [ -d "$DEST/plugins/$d/lang" ]; then
		find "$DEST/plugins/$d/lang" -type f ! -name en.js -delete
	fi
done

# Every plugin in config.js, and everything those plugins require, must be in ckeditor.js or have its folder.
node - "$DEST" <<'EOF'
const fs = require('fs'), path = require('path');
const dest = process.argv[2];
const listed = fs.readFileSync(path.join(dest, 'config.js'), 'utf8').match(/config\.plugins\s*=\s*((?:'[^']*'\s*\+?\s*)+);/);
if (!listed) throw new Error('config.js: no config.plugins');
const wanted = listed[1].replace(/'\s*\+\s*'/g, '').replace(/'/g, '').split(',').map(s => s.trim()).filter(Boolean);
const bundled = new Set(fs.readFileSync(path.join(dest, 'ckeditor.js'), 'utf8').match(/CKEDITOR\.config\.plugins="([^"]*)"/)[1].split(','));
const missing = [], seen = new Set();
(function check(names) {
	for (const name of names) {
		if (seen.has(name) || bundled.has(name)) continue;
		seen.add(name);
		const file = path.join(dest, 'plugins', name, 'plugin.js');
		if (!fs.existsSync(file)) { missing.push(name); continue; }
		const req = fs.readFileSync(file, 'utf8').match(/requires\s*:\s*(?:"([^"]*)"|'([^']*)'|\[([^\]]*)\])/);
		if (req) check((req[1] || req[2] || req[3]).replace(/['"\s]/g, '').split(',').filter(Boolean));
	}
})(wanted);
if (missing.length) { console.error('Plugins neither in ckeditor.js nor in plugins/: ' + missing.join(', ') + ' (add them to PLUGIN_DIRS)'); process.exit(1); }
EOF

node "$HERE/port-skin.js" "$SRC/skins/moono" "$PKG/skins/moono" "$DEST/skins/custom" "$DEST/plugins/autogrow/plugin.js"

echo "Done: CKEditor $VERSION in $DEST. Run npx retire --path public/ckeditor and test comments in the dev stack."
