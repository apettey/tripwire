const assert = require('assert');
const { include } = require('../helpers/helpers');

include('app/js/fork/notifications');

describe('forkNotifications', () => {
	const n = forkNotifications;

	it('uses the top right corner when none or an unknown one is stored', () => {
		assert.strictEqual(n.corner(null), 'top-right');
		assert.strictEqual(n.corner({}), 'top-right');
		assert.strictEqual(n.corner({ notifications: { corner: 'middle' } }), 'top-right');
	});

	it('keeps every offered corner', () => {
		n.CORNERS.forEach(c => assert.strictEqual(n.corner({ notifications: { corner: c[0] } }), c[0]));
		assert.strictEqual(n.CORNERS.length, 4);
	});

	it('leaves pop-up times alone by default', () => {
		assert.strictEqual(n.duration(15000, {}), 15000);
	});

	it('caps pop-up times at 5 seconds with Close pop-ups sooner', () => {
		const opts = { notifications: { short: true } };
		assert.strictEqual(n.duration(15000, opts), 5000);
		assert.strictEqual(n.duration(2000, opts), 2000);
	});

	it('gives a pop-up with no time limit no timer', () => {
		const opts = { notifications: { short: true } };
		[false, 0, undefined, null].forEach(v => assert.strictEqual(n.duration(v, opts), null));
	});

	it('docks a notice, adds a close button and takes over its timer, keeping its other options', () => {
		const given = { content: 'x', color: 'red', autoClose: 9000, closeOnClick: false };
		const result = n.noticeOptions(given, 'dock');
		assert.strictEqual(result.appendTo, 'dock');
		assert.strictEqual(result.closeButton, 'box');
		assert.strictEqual(result.autoClose, false);
		assert.strictEqual(result.color, 'red');
		assert.strictEqual(result.closeOnClick, false);
		assert.strictEqual(given.autoClose, 9000, 'the caller\'s object is not changed');
	});

	it('copes with a notice given no options', () => {
		assert.strictEqual(n.noticeOptions(undefined, 'dock').appendTo, 'dock');
	});

	it('leaves a moment to read after the mouse moves off', () => {
		assert.strictEqual(n.resumeMs(200), n.RESUME_MS);
		assert.strictEqual(n.resumeMs(4000), 4000);
	});
});
