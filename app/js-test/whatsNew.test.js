const assert = require('assert');
const { include } = require('./helpers/helpers');
include('app/js/whats-new');

describe('What\'s New', () => {
	const features = [
		{ pr: 3, title: 'Third', description: 'c' },
		{ pr: 1, title: 'First', description: 'a' },
		{ pr: 7, title: 'Seventh', description: 'g' },
		{ pr: 5, title: 'Fifth', description: 'e' }
	];
	const prs = list => list.map(f => f.pr);

	describe('latestPR', () => {
		it('Empty list', () => assert.equal(whatsNew.latestPR([]), 0));
		it('Missing list', () => assert.equal(whatsNew.latestPR(undefined), 0));
		it('Unsorted list', () => assert.equal(whatsNew.latestPR(features), 7));
	});

	describe('unseen', () => {
		it('Nothing seen yet', () => assert.deepEqual(prs(whatsNew.unseen(features, 0)), [7, 5, 3, 1]));
		it('Seen up to the middle', () => assert.deepEqual(prs(whatsNew.unseen(features, 3)), [7, 5]));
		it('All seen', () => assert.deepEqual(prs(whatsNew.unseen(features, 7)), []));
		it('Does not modify the input', () => {
			whatsNew.unseen(features, 0);
			assert.deepEqual(prs(features), [3, 1, 7, 5]);
		});
	});

	describe('version', () => {
		it('Release version gets a v', () => assert.equal(whatsNew.shortVersion({ version: '1.2.0', upstream: '1.30b' }), 'v1.2.0'));
		it('Non-release version as is', () => assert.equal(whatsNew.shortVersion({ version: 'dev' }), 'dev'));
		it('Missing file is dev', () => {
			assert.equal(whatsNew.shortVersion(null), 'dev');
			assert.equal(whatsNew.shortVersion({}), 'dev');
		});
		it('Full line', () => assert.equal(whatsNew.formatVersion({ version: '1.2.0', upstream: '1.30b' }), 'Tripwire fork v1.2.0 (upstream 1.30b)'));
		it('Full line without upstream', () => assert.equal(whatsNew.formatVersion(undefined), 'Tripwire fork dev'));
	});

	describe('render', () => {
		const evil = [{ pr: 2, title: '<script>alert(1)</script>', description: 'x <script>alert(2)</script> & "q"', images: [{ src: 'a.png', caption: '<b>cap</b>' }] }];

		it('Escapes title, description and caption', () => {
			const html = whatsNew.render(evil, 0);
			assert.ok(!html.includes('<script>'));
			assert.ok(!html.includes('<b>cap'));
			assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
			assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt; &amp; &quot;q&quot;'));
		});

		it('Badges unseen features only', () => {
			const html = whatsNew.render(features, 3);
			assert.equal((html.match(/whats-new-badge/g) || []).length, 2);
			assert.ok(/data-pr='7'><h4 class='whats-new-title'><span class='whats-new-badge'>NEW/.test(html));
			assert.ok(/data-pr='3'><h4 class='whats-new-title'><a /.test(html));
		});

		it('No badges when everything is seen', () => assert.ok(!whatsNew.render(features, 7).includes('whats-new-badge')));

		it('Renders newest first with PR links', () => {
			const html = whatsNew.render(features, 0);
			const order = (html.match(/data-pr='(\d+)'/g) || []).map(m => parseInt(m.match(/\d+/)[0], 10));
			assert.deepEqual(order, [7, 5, 3, 1]);
			assert.ok(html.includes("href='https://github.com/apettey/tripwire/pull/7' target='_blank' rel='noopener'>#7</a>"));
		});

		it('Blank line starts a new paragraph', () => {
			const html = whatsNew.render([{ pr: 1, title: 't', description: 'one\n\ntwo' }], 0);
			assert.equal((html.match(/<p class='whats-new-description'>/g) || []).length, 2);
		});
	});
});
