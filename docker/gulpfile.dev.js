// Dev-only wrapper around the upstream gulpfile: adds a `watch` task and a deterministic file order.
// Run from the repo root: npx gulp --gulpfile docker/gulpfile.dev.js --cwd . watch   (or: ... js css)
const gulp = require('gulp');

// Upstream's gulpfile passes gulp.src() a list of globs and concatenates files in the order they arrive, which
// depends on the file system (and on a Windows/macOS bind mount, on timing). Script order matters (fork files
// depend on each other), so expand every glob here into a sorted list of files: globs in their listed order,
// files sorted by path within each glob, each file once at its first match. That reproduces the committed bundles.
// Must run before the upstream gulpfile is loaded (it calls gulp.src inside its tasks).
let glob = null;
try { glob = require('glob'); } catch (e) { /* not installed: keep upstream behaviour */ }
const src = gulp.src;
gulp.src = function(globs, options) {
	if (!glob || !Array.isArray(globs) || !globs.every(g => typeof g === 'string' && g[0] !== '!')) {
		return src.apply(this, arguments);
	}
	const seen = new Set();
	const files = [];
	globs.forEach(pattern => {
		glob.sync(pattern, { nodir: true }).sort().forEach(file => {
			if (!seen.has(file)) { seen.add(file); files.push(file); }
		});
	});
	return src.call(this, files.length ? files : globs, options);
};

require('../gulpfile.js');

// Polling so changes made on a Windows/macOS host are seen through the bind mount
const watchOpts = { usePolling: true, interval: 500, ignoreInitial: true };

gulp.task('watch', function() {
    gulp.watch(['app/js/**/*.js'], watchOpts, gulp.series('js'));
    gulp.watch(['app/css/**/*.css'], watchOpts, gulp.series('css'));
});
