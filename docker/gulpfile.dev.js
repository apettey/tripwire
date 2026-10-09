// Dev-only wrapper around the upstream gulpfile: adds a `watch` task.
// Run from the repo root: npx gulp --gulpfile docker/gulpfile.dev.js --cwd . watch
const gulp = require('gulp');
require('../gulpfile.js');

// Polling so changes made on a Windows/macOS host are seen through the bind mount
const watchOpts = { usePolling: true, interval: 500, ignoreInitial: true };

gulp.task('watch', function() {
    gulp.watch(['app/js/**/*.js'], watchOpts, gulp.series('js'));
    gulp.watch(['app/css/**/*.css'], watchOpts, gulp.series('css'));
});
