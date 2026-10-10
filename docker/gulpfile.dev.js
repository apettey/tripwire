// Dev-only wrapper around the upstream gulpfile: adds a `watch` task and a deterministic file order.
// Run from the repo root: npx gulp --gulpfile docker/gulpfile.dev.js --cwd . watch   (or: ... js css)
const gulp = require('gulp');

// Upstream's gulpfile passes gulp.src() a list of globs and concatenates files in the order they arrive, which
// depends on the file system (and on a Windows/macOS bind mount, on timing). Script order matters (fork files
// depend on each other), so expand every glob here into a sorted list of files: globs in their listed order,
// files sorted by path within each glob, each file once at its first match. That reproduces the committed bundles.
// Must run before the upstream gulpfile is loaded (it calls gulp.src inside its tasks).
// Each file keeps the base of the glob it matched (e.g. app/js for app/js/**/*.js), as gulp would give it, so
// source-map paths stay the same (dialogs/x.js, fork/x.js).
const path = require('path');
const { Transform } = require('stream');
let glob = null;
let globParent = null;
try { glob = require('glob'); globParent = require('glob-parent'); } catch (e) { /* not installed: keep upstream behaviour */ }
const src = gulp.src;
gulp.src = function(globs, options) {
	if (!glob || !globParent || !Array.isArray(globs) || !globs.every(g => typeof g === 'string' && g[0] !== '!')
		|| (options && options.base)) {
		return src.apply(this, arguments);
	}
	const bases = new Map();   // absolute file path => absolute base of the first glob it matched
	const files = [];
	globs.forEach(pattern => {
		const base = path.resolve(globParent(pattern));
		glob.sync(pattern, { nodir: true }).sort().forEach(file => {
			const absolute = path.resolve(file);
			if (!bases.has(absolute)) { bases.set(absolute, base); files.push(file); }
		});
	});
	if (!files.length) { return src.apply(this, arguments); }
	return src.call(this, files, options).pipe(new Transform({
		objectMode: true,
		transform(file, encoding, done) {
			if (bases.has(file.path)) { file.base = bases.get(file.path); }
			done(null, file);
		}
	}));
};

require('../gulpfile.js');

// Polling so changes made on a Windows/macOS host are seen through the bind mount
const watchOpts = { usePolling: true, interval: 500, ignoreInitial: true };

gulp.task('watch', function() {
    gulp.watch(['app/js/**/*.js'], watchOpts, gulp.series('js'));
    gulp.watch(['app/css/**/*.css'], watchOpts, gulp.series('css'));
});
