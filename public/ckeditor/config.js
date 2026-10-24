/**
 * Tripwire's CKEditor config (loaded by ckeditor.js; the per-editor settings are in app/js/ckeditor.js).
 * public/ckeditor/ is the CKEditor 4.22.1 release trimmed to these plugins; rebuild it with
 * tools/ckeditor/update.sh.
 */

CKEDITOR.editorConfig = function( config ) {
	// The 4.4.6 custom build's plugin set. Plugins not inside ckeditor.js load from plugins/;
	// autolink and toolbarswitch are third-party plugins (autolink also links bare www. addresses).
	config.plugins = 'autogrow,autolink,basicstyles,clipboard,colorbutton,colordialog,enterkey,entities,' +
		'floatingspace,font,indentblock,indentlist,link,list,maximize,sourcearea,toolbar,toolbarswitch,undo,wysiwygarea';

	// Keep 4.4.6's behaviour where 4.22 changed the defaults:
	// the old 40-colour palette, 8 per row, without the "used colours" and "colours in this note" rows,
	config.colorButton_colors = '000,800000,8B4513,2F4F4F,008080,000080,4B0082,696969,' +
		'B22222,A52A2A,DAA520,006400,40E0D0,0000CD,800080,808080,' +
		'F00,FF8C00,FFD700,008000,0FF,00F,EE82EE,A9A9A9,' +
		'FFA07A,FFA500,FFFF00,00FF00,AFEEEE,ADD8E6,DDA0DD,D3D3D3,' +
		'FFF0F5,FAEBD7,FFFFE0,F0FFF0,F0FFFF,F0F8FF,E6E6FA,FFF';
	config.colorButton_colorsPerRow = 8;
	config.colorButton_historyRowLimit = 0;
	config.colorButton_renderContentColors = false;
	// pasted formatting kept in Chrome/Safari too (no 'semantic-content' filter; notes are sanitised on save),
	config.pasteFilter = null;
	// and no pasting of image files: they'd become data: URLs, which the note sanitiser drops on save.
	config.clipboard_handleImages = false;

	// Only the English UI is shipped.
	config.language = 'en';

	// Don't ask cdn.ckeditor.com for the latest version (a third-party call) or show
	// "this version is not secure" notices: we know 4.22.1 is the last open-source release.
	config.versionCheck = false;
};
