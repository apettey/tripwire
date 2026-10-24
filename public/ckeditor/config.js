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

	// Only the English UI is shipped.
	config.language = 'en';

	// Don't ask cdn.ckeditor.com for the latest version (a third-party call) or show
	// "this version is not secure" notices: we know 4.22.1 is the last open-source release.
	config.versionCheck = false;
};
