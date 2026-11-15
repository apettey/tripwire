// The note editor (app/js/fork/note-editor.js): what goes in and out of it is always sanitised.
const assert = require('assert');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { include } = require('../helpers/helpers');

describe('Note editor', () => {
	let dom, win, commands, saved;

	before(() => {
		saved = { $: global.$, window: global.window, document: global.document, DOMParser: global.DOMParser, tripwire: global.tripwire };
		dom = new JSDOM('<!doctype html><body><div class="comment"><div id="comment0" class="commentBody"></div>' +
			'<a class="commentSave"></a><a class="commentCancel"></a></div></body>', { runScripts: 'outside-only' });
		win = dom.window;
		win.eval(fs.readFileSync('public/js/jquery-3.7.1.min.js', 'utf8'));
		global.window = win;
		global.document = win.document;
		global.DOMParser = win.DOMParser;
		global.$ = win.$;
		global.tripwire = {};
		commands = [];
		win.document.execCommand = (cmd, ui, arg) => { commands.push([cmd, arg]); return true; };
		include('app/js/fork/sanitise-html');
		include('app/js/fork/note-editor');
	});
	after(() => {
		Object.keys(saved).forEach(k => { if (saved[k] === undefined) { delete global[k]; } else { global[k] = saved[k]; } });
	});
	beforeEach(() => { commands.length = 0; });

	describe('safeLinkUrl', () => {
		it('adds https:// to a bare host', () => assert.strictEqual(noteEditor.safeLinkUrl('zkillboard.com/kill/1/'), 'https://zkillboard.com/kill/1/'));
		it('keeps http, https and mailto', () => {
			assert.strictEqual(noteEditor.safeLinkUrl('https://evemaps.dotlan.net/map'), 'https://evemaps.dotlan.net/map');
			assert.strictEqual(noteEditor.safeLinkUrl('http://example.com/'), 'http://example.com/');
			assert.strictEqual(noteEditor.safeLinkUrl('mailto:ceo@example.com'), 'mailto:ceo@example.com');
		});
		it('keeps a link into Tripwire', () => assert.strictEqual(noteEditor.safeLinkUrl('/?system=Jita'), '/?system=Jita'));
		['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox(1)', 'file:///etc/passwd', '/comments.php?mode=delete', '//evil.example/x', '', null].forEach(url => {
			it('refuses ' + JSON.stringify(url), () => assert.strictEqual(noteEditor.safeLinkUrl(url), null));
		});
	});

	describe('transferHtml (paste and drop)', () => {
		const data = items => ({ getData: type => items[type] || '' });
		it('sanitises pasted HTML', () => {
			const out = noteEditor.transferHtml(data({ 'text/html': '<b>hi</b><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><script>alert(1)</script>' }));
			assert.ok(out.includes('<b>hi</b>'));
			assert.ok(!/onerror|javascript|script/i.test(out), out);
		});
		it('escapes plain text and keeps its lines', () => {
			assert.strictEqual(noteEditor.transferHtml(data({ 'text/plain': '<img src=x onerror=alert(1)>\nnext & last' })),
				'&lt;img src=x onerror=alert(1)&gt;<br>next &amp; last');
		});
		it('nothing to insert', () => assert.strictEqual(noteEditor.transferHtml(null), ''));
	});

	describe('replace / getData / destroy', () => {
		it('opens with the note sanitised, even when the element holds unsafe markup', () => {
			win.document.getElementById('comment0').innerHTML = '<b>note</b><span onclick="alert(1)">x</span>';
			const inst = noteEditor.replace('comment0');
			assert.ok(inst && tripwire.editor === noteEditor);
			assert.strictEqual(inst.area.html(), '<b>note</b><span>x</span>');
			assert.ok(noteEditor.isOpen());
			assert.strictEqual(win.$('#comment0').css('display'), 'none');
			noteEditor.destroy('comment0', true);
		});

		it('getData() and destroy(id, false) hand back sanitised HTML (never the raw editor HTML)', () => {
			win.document.getElementById('comment0').innerHTML = 'old';
			const inst = noteEditor.replace('comment0');
			inst.area[0].innerHTML = '<p>new <img src="https://images.evetech.net/a.png" onerror="alert(1)"></p>';
			assert.strictEqual(inst.getData(), '<p>new <img src="https://images.evetech.net/a.png"></p>');
			noteEditor.destroy('comment0', false);
			assert.strictEqual(win.document.getElementById('comment0').innerHTML, '<p>new <img src="https://images.evetech.net/a.png"></p>');
			assert.ok(!noteEditor.isOpen());
			assert.strictEqual(win.$('.rte').length, 0);
		});

		it('destroy(id, true) keeps the saved note', () => {
			win.document.getElementById('comment0').innerHTML = 'saved';
			const inst = noteEditor.replace('comment0');
			inst.area[0].innerHTML = 'unsaved';
			noteEditor.destroy('comment0', true);
			assert.strictEqual(win.document.getElementById('comment0').innerHTML, 'saved');
		});

		it('a paste inserts sanitised HTML only', () => {
			const inst = noteEditor.replace('comment0');
			const ev = new win.Event('paste', { bubbles: true, cancelable: true });
			ev.clipboardData = { getData: type => type === 'text/html' ? '<i>ok</i><svg onload=alert(1)></svg><img src=x onerror=alert(1)>' : '' };
			inst.area[0].dispatchEvent(ev);
			assert.ok(ev.defaultPrevented, 'the browser must not insert the clipboard itself');
			const inserted = commands.filter(c => c[0] === 'insertHTML');
			assert.strictEqual(inserted.length, 1);
			assert.strictEqual(inserted[0][1], '<i>ok</i><img>');
			noteEditor.destroy('comment0', true);
		});

		it('a drop inserts sanitised HTML only', () => {
			const inst = noteEditor.replace('comment0');
			const ev = new win.Event('drop', { bubbles: true, cancelable: true });
			ev.dataTransfer = { getData: type => type === 'text/html' ? '<a href="javascript:alert(1)">x</a>' : '' };
			inst.area[0].dispatchEvent(ev);
			assert.ok(ev.defaultPrevented);
			assert.deepStrictEqual(commands.filter(c => c[0] === 'insertHTML').map(c => c[1]), ['<a>x</a>']);
			noteEditor.destroy('comment0', true);
		});

		it('onOpen runs before the editor reads the note; onClose after it is gone', () => {
			const seen = [];
			noteEditor.onOpen(el => { seen.push('open'); el.innerHTML = 'stored'; });
			noteEditor.onClose(() => seen.push('close:' + win.$('.rte').length));
			const inst = noteEditor.replace('comment0');
			assert.strictEqual(inst.area.html(), 'stored');
			noteEditor.destroy('comment0', true);
			assert.deepStrictEqual(seen, ['open', 'close:0']);
		});

		it('Esc cancels and Alt+S saves', () => {
			const clicks = [];
			win.$('.commentSave').on('click', () => clicks.push('save'));
			win.$('.commentCancel').on('click', () => clicks.push('cancel'));
			const inst = noteEditor.replace('comment0');
			inst.area[0].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			inst.area[0].dispatchEvent(new win.KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true }));
			assert.deepStrictEqual(clicks, ['cancel', 'save']);
			noteEditor.destroy('comment0', true);
		});

		it('a missing element opens nothing', () => assert.strictEqual(noteEditor.replace('nope'), null));
	});
});
