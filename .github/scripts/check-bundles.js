// Checks that the committed bundles match a fresh build (run after `npx gulp js && npx gulp css`).
//
// Each source file becomes one line of the bundle, but gulp concatenates them in filesystem order
// (alphabetical on Windows/macOS, arbitrary on Linux), so this compares which lines are present, not
// their order. Source maps embed the sources (line endings differ per OS) and are not compared.
const cp = require("child_process");
const fs = require("fs");

const bundles = ["public/js/app.min.js", "public/css/app.min.css"];

function lines(text) {
	return text.split("\n").filter(l => l.trim() && !/^\/[/*]# sourceMappingURL/.test(l));
}

function count(list) {
	return list.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
}

let stale = false;
for (const file of bundles) {
	const committed = count(lines(cp.execSync("git show HEAD:" + file).toString()));
	const rebuilt = count(lines(fs.readFileSync(file, "utf8")));
	const missing = [...rebuilt].filter(([l, n]) => (committed.get(l) || 0) < n).map(([l]) => l);
	const extra = [...committed].filter(([l, n]) => (rebuilt.get(l) || 0) < n).map(([l]) => l);
	if (missing.length || extra.length) {
		stale = true;
		console.log(`::error::${file} is out of date. Rebuild it (the dev 'assets' service, or 'npx gulp js css') and commit it.`);
		missing.forEach(l => console.log("  missing from the commit: " + l.slice(0, 160)));
		extra.forEach(l => console.log("  not in a fresh build:    " + l.slice(0, 160)));
	} else {
		console.log(file + ": up to date");
	}
}
process.exit(stale ? 1 : 0);
