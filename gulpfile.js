const gulp = require('gulp');
const pump = require('pump');
const shell = require('gulp-shell');
const mocha = require('gulp-mocha');
const notify = require('gulp-notify');
const uglify = require('gulp-uglify-es').default;
const cleancss = require('gulp-clean-css');
const concat = require('gulp-concat');
const sourcemaps = require('gulp-sourcemaps');
const rename = require('gulp-rename');

// The order of the files in `src` are important, be sure to include a file before something else uses it
var jsFiles = [
    {
        name: 'app.js',
        nameMin: 'app.min.js',
        src: [
            'app/js/helpers.js',
			'app/js/data-mutators/*.js',
			'app/js/map-data-suppliers/*.js',
            'app/js/init.js',
            'app/js/options.js',
            'app/js/layout.js',
            'app/js/tripwire.js',
            'app/js/global-hooks.js',
            'app/js/wormholeRendering.js',
            'app/js/widget-*.js',
            'app/js/systemAnalysis.js',
			'app/js/system-mutators/*.js',
            'app/js/guidance.js',
            'app/js/systemRendering.js',
            'app/js/chain-map-renderer*.js',
            'app/js/chain-map.js',
            'app/js/guidance_profiles.js',
            'app/js/systemPanel.js',
            'app/js/tripwire/*.js',
            'app/js/*.js',
            'app/js/**/*.js'
        ],
        output: 'public/js'
    }
];

var cssFiles = [
    {
        name: 'app.css',
        nameMin: 'app.min.css',
        src: ['app/css/base.css', 'app/css/*.css', 'app/css/**/*.css'],
        output: 'public/css'
    }
];

// Gulp v4 changed how you call .task with multiple subtasks, gulp parallel needed instead
// gulp.task('default', ['js', 'css']);
//gulp.task('default', gulp.parallel('js', 'css'));

gulp.task('js', function(cb) {
    for (var j in jsFiles) {
        pump([
            gulp.src(jsFiles[j].src),
            sourcemaps.init(),
            uglify(),
            concat(jsFiles[j].name),
            rename(jsFiles[j].nameMin),
            sourcemaps.write('.'),
            gulp.dest(jsFiles[j].output),
            notify({
                message: "Finished javascript",
                onLast: true
            })
        ], cb);
    }
});

gulp.task('js_dev', function(cb) {
    for (var j in jsFiles) {
        pump([
            gulp.src(jsFiles[j].src),
            sourcemaps.init(),
            concat(jsFiles[j].name),
            rename(jsFiles[j].nameMin),
            sourcemaps.write('.'),
            gulp.dest(jsFiles[j].output),
            notify({
                message: "Finished javascript",
                onLast: true
            })
        ], cb);
    }
});

gulp.task('css', function(cb) {
    for (var c in cssFiles) {
        pump([
            gulp.src(cssFiles[c].src),
            sourcemaps.init(),
            cleancss(),
            concat(cssFiles[c].name),
            rename(cssFiles[c].nameMin),
            sourcemaps.write('.'),
            gulp.dest(cssFiles[c].output),
            notify({
                message: "Finished css",
                onLast: true
            })
        ], cb);
    }
});

gulp.task('test', cb => {
	gulp.src(['app/js-test/**/*.js']).pipe(mocha());
	cb();
});