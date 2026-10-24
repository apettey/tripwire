// Applies Tripwire's look to a CKEditor 4 release (called by update.sh): builds
// public/ckeditor/skins/custom, restyles contents.css and patches autogrow.
//   node port-skin.js <source moono dir> <built moono dir> <dest skin dir> <autogrow plugin.js>
//
// The custom skin is moono with Tripwire's edits (flat white toolbar, translucent dark editing area,
// font/size combos shown as icons). The edits are applied to the release's moono sources here so
// they can be re-applied on the next upgrade; each one must match exactly or the script stops.
'use strict';
const fs = require('fs');
const path = require('path');

const [srcDir, builtDir, destDir, autogrowFile] = process.argv.slice(2);
if (!autogrowFile) {
	console.error('usage: node port-skin.js <source moono> <built moono> <dest skin dir> <autogrow plugin.js>');
	process.exit(1);
}

function replaceOnce(file, text, from, to) {
	if (from instanceof RegExp) {
		if (!from.test(text)) throw new Error(`${file}: expected text not found:\n${from}`);
		return text.replace(from, to);
	}
	const i = text.indexOf(from);
	if (i < 0) throw new Error(`${file}: expected text not found:\n${from}`);
	return text.slice(0, i) + to + text.slice(i + from.length);
}

const edits = {
	'mainui.css': [
		// no border round the editor, transparent inner box
		['\tdisplay: block;\n\tborder: 1px solid #b6b6b6;\n\tpadding: 0;\n', '\tdisplay: block;\n\tpadding: 0;\n'],
		['\t-webkit-touch-callout: none;\n\n\tbackground: #fff;\n\tpadding: 0;', '\t-webkit-touch-callout: none;\n\n\tpadding: 0;'],
		// flat white toolbar strip
		[`	/*border: 1px solid #b2b2b2;*/
	border-bottom: 1px solid #b6b6b6;
	padding: 6px 8px 2px;

	/* Allow breaking toolbars when in a narrow editor. (#9947) */
	white-space: normal;

	box-shadow: 0 1px 0 #fff inset;

	background: #cfd1cf;
	background-image: linear-gradient(to bottom, #f5f5f5, #cfd1cf);
	filter: progid:DXImageTransform.Microsoft.gradient(gradientType=0, startColorstr='#f5f5f5', endColorstr='#cfd1cf');`,
		`	/* Allow breaking toolbars when in a narrow editor. (#9947) */
	white-space: normal;

	box-shadow: 0 1px 2px rgba(0,0,0,0.2);

	background: #fff;`]
	],
	'panel.css': [
		['\tcolor: inherit !important;', '\tcolor: #333 !important;']
	],
	'presets.css': [
		// translucent dark editing area (source mode and WYSIWYG)
		['\tfont-size: small;\n\tbackground-color: #fff;', '\tfont-size: small;\n\tcolor: #eee;\n\tbackground-color: rgba(0,0,0,.6);'],
		['.cke_wysiwyg_frame, .cke_wysiwyg_div\n{\n\tbackground-color: #fff;', '.cke_wysiwyg_frame, .cke_wysiwyg_div\n{\n\tbackground-color: rgba(0,0,0,.6);']
	],
	'richcombo.css': [
		// pressed look for the font/size combos, which are drawn as buttons
		['.cke_combo_on a.cke_combo_button:hover,', `.cke_combo_on a
{
	box-shadow: 0 1px 5px rgba(0,0,0,.6) inset, 0 1px 0 rgba(0,0,0,.2);

	background: #b5b5b5;
}

.cke_combo_on a:hover,
.cke_combo_on a:focus,
.cke_combo_on a:active
{
	box-shadow: 0 1px 6px rgba(0,0,0,.7) inset, 0 1px 0 rgba(0,0,0,.2);

	background: #b5b5b5;
}

.cke_combo_on a.cke_combo_button:hover,`],
		['.cke_combo_disabled .cke_combo_open\n', '.cke_combo_disabled .cke_combo_open,\n.cke_combo_disabled .cke_button_icon\n']
	],
	'skin.js': [
		["CKEDITOR.skin.name = 'moono';", "CKEDITOR.skin.name = 'custom';"]
	],
	'toolbar.css': [
		// buttons without group boxes or gradients
		[`	float: left;
	margin: 0 6px 5px 0;
	border: 1px solid #a6a6a6;
	border-bottom-color: #979797;

	border-radius: 3px;

	box-shadow: 0 1px 0 rgba(255,255,255,.5), 0 0 2px rgba(255,255,255,.15) inset, 0 1px 0 rgba(255,255,255,.15) inset;

	background: #e4e4e4;
	background-image: linear-gradient(to bottom, #ffffff, #e4e4e4);
	filter: progid:DXImageTransform.Microsoft.gradient(gradientType=0, startColorstr='#ffffff', endColorstr='#e4e4e4');
`, '\tfloat: left;\n'],
		['\theight: 18px;\n\tpadding: 4px 6px;', '\theight: 18px;\n\tpadding: 4px 4px;'],
		[`.cke_ltr .cke_button:last-child,
.cke_rtl .cke_button:first-child
{
	/* Don't distort parent's rounded border. */
	border-radius: 0 2px 2px 0;
}

.cke_ltr .cke_button:first-child,
.cke_rtl .cke_button:last-child
{
	/* Don't distort parent's rounded border. */
	border-radius: 2px 0 0 2px;
}

`, ''],
		[`	background-image: linear-gradient(to bottom, #aaa, #cacaca);
	filter: progid:DXImageTransform.Microsoft.gradient(gradientType=0, startColorstr='#aaaaaa', endColorstr='#cacaca');
`, ''],
		[`	background: #ccc;
	background-image: linear-gradient(to bottom, #f2f2f2, #ccc);
	filter: progid:DXImageTransform.Microsoft.gradient(gradientType=0, startColorstr='#f2f2f2', endColorstr='#cccccc');
`, '\tbackground: #ccc;\n'],
		[`		background: #ccc;
		background-image: linear-gradient(to bottom, #f2f2f2, #ccc);
		filter: progid:DXImageTransform.Microsoft.gradient(gradientType=0, startColorstr='#f2f2f2', endColorstr='#cccccc');
`, '\t\tbackground: #ccc;\n']
	]
};

const toolbarAppend = `
/* Tripwire: the font and size combos are drawn as icon buttons (see app/js/ckeditor.js). */
.cke_combo__font .cke_button_icon {
	background-image: url(/ckeditor/plugins/font.png);
	background-position: 0 0px;
	background-size: auto;
}

.cke_combo__fontsize .cke_button_icon {
	background-image: url(/ckeditor/plugins/font_size.png);
	background-position: 0 0px;
	background-size: auto;
}
`;

// 1. Patched sources.
const files = {};
for (const name of fs.readdirSync(srcDir)) {
	if (/\.(css|js)$/.test(name)) files[name] = fs.readFileSync(path.join(srcDir, name), 'utf8').replace(/\r\n/g, '\n');
}
for (const [name, list] of Object.entries(edits)) {
	for (const [from, to] of list) files[name] = replaceOnce(name, files[name], from, to);
}
files['toolbar.css'] = files['toolbar.css'].replace(/\s*$/, '\n') + toolbarAppend;

// 2. Inline @imports into editor.css and dialog.css (the files the editor loads), like CKBuilder.
function inline(name, seen = new Set()) {
	if (seen.has(name)) throw new Error('@import loop at ' + name);
	seen.add(name);
	return files[name].replace(/@import url\("([^"]+)"\);/g, (m, dep) => {
		if (!files[dep]) throw new Error(`${name}: missing @import ${dep}`);
		return inline(dep, seen);
	});
}

// 3. Icon sprite rules: the built moono editor.css ends with them (moono-style icons, as before).
const builtEditor = fs.readFileSync(path.join(builtDir, 'editor.css'), 'utf8');
const iconsStart = builtEditor.search(/\.cke_button__[a-z0-9]+_icon\{background:url\(icons\.png/);
if (iconsStart < 0) throw new Error('no icon rules in built moono editor.css');
const iconRules = builtEditor.slice(iconsStart);

fs.mkdirSync(destDir, { recursive: true });
const banner = '/* Built by tools/ckeditor/port-skin.js from the CKEditor moono skin; edit the script, not this file. */\n';
for (const name of Object.keys(files)) {
	let out;
	if (name === 'editor.css') out = banner + inline(name) + '\n' + iconRules + '\n';
	else if (name === 'dialog.css') out = banner + inline(name);
	else if (/^(editor|dialog)_.*\.css$/.test(name) || name === 'skin.js') out = files[name];
	else continue; // the rest is inlined above
	fs.writeFileSync(path.join(destDir, name), out);
}
for (const f of ['icons.png', 'icons_hidpi.png']) fs.copyFileSync(path.join(builtDir, f), path.join(destDir, f));
fs.cpSync(path.join(builtDir, 'images'), path.join(destDir, 'images'), { recursive: true });

// 4. contents.css (the editing area): Tripwire's small light-on-dark text, no white page or margin,
//    orange bold links.
const contentsFile = path.join(path.dirname(path.dirname(destDir)), 'contents.css');
let contents = fs.readFileSync(contentsFile, 'utf8').replace(/\r\n/g, '\n');
for (const [from, to] of [
	[/\t\/\* Emoji fonts[^\n]*\n\tfont-family: [^\n]*\n\tfont-size: 12px;\n/, "\tfont-size: .6em;\n\tfont-family: Verdana, 'Helvetica Neue', Arial, sans-serif;\n\tline-height: 1.1;\n"],
	['\tcolor: #333;\n', '\tcolor: #ccc;\n'],
	['\t/* Remove the background color to make it transparent. */\n\tbackground-color: #fff;\n\n\tmargin: 20px;\n', ''],
	['\tfont-size: 13px;\n\tline-height: 1.6;\n\n', ''],
	['a\n{\n\tcolor: #0782C1;\n}', 'a\n{\n\tcolor: darkorange;\n\tfont-weight: bold;\n}']
]) contents = replaceOnce('contents.css', contents, from, to);
fs.writeFileSync(contentsFile, contents);

// 5. autogrow: don't grow on startup when the editor opens maximized (toolbarswitch reopens it that way).
const ag = fs.readFileSync(autogrowFile, 'utf8');
const agFrom = 'a.config.autoGrow_onStartup&&a.editable().isVisible()&&a.execCommand("autogrow")';
const agTo = 'a.config.autoGrow_onStartup&&a.editable().isVisible()&&!(a.commands.maximize&&a.commands.maximize.state==CKEDITOR.TRISTATE_ON)&&a.execCommand("autogrow")';
fs.writeFileSync(autogrowFile, replaceOnce('autogrow/plugin.js', ag, agFrom, agTo));

console.log('skins/custom built in ' + destDir);
