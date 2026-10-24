#!/usr/bin/env bash
# Rebuild public/ckeditor/ from the official CKEditor 4 release (npm package ckeditor4) plus the
# GitHub source tag (for the moono skin sources our custom skin is based on).
#
#   tools/ckeditor/update.sh [version]      # default 4.22.1, the last open-source CKEditor 4
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
curl -fsSL "https://github.com/ckeditor/ckeditor4/archive/refs/tags/$VERSION.tar.gz" | tar xz -C "$WORK"
PKG="$WORK/package"
SRC="$WORK/ckeditor4-$VERSION"

# Plugin folders loaded at runtime (everything else in our plugin set is inside ckeditor.js).
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

node "$HERE/port-skin.js" "$SRC/skins/moono" "$PKG/skins/moono" "$DEST/skins/custom" "$DEST/plugins/autogrow/plugin.js"

echo "Done: CKEditor $VERSION in $DEST. Run npx retire --path public/ckeditor and test comments in the dev stack."
