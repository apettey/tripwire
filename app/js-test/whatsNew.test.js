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
		it('Tooltip', () => assert.equal(whatsNew.versionTooltip({ version: '1.6.0', upstream: '1.30b' }), 'Tripwire fork v1.6.0 · based on upstream Tripwire 1.30b'));
		it('Tooltip in dev', () => assert.equal(whatsNew.versionTooltip({ version: 'dev', upstream: '1.30b' }), 'Tripwire fork dev · based on upstream Tripwire 1.30b'));
		it('Tooltip without version.json', () => {
			assert.equal(whatsNew.versionTooltip({ version: ' dev ' }), 'Tripwire fork dev');
			assert.equal(whatsNew.versionTooltip(null), 'Tripwire fork dev');
		});
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

		it('Try it, used tick and Turned off from infoFor(pr)', () => {
			const info = { 7: { feature: 'jumpPlanner', status: 'used', canTry: true }, 5: { feature: 'sizeTags', status: 'off', canTry: true },
				3: { feature: 'apiTokens', status: 'new', canTry: false } };
			const html = whatsNew.render(features, 0, pr => info[pr] || null);
			const item = pr => html.split("data-pr='" + pr + "'")[1].split('whats-new-item')[0];
			assert.ok(item(7).includes("class='whats-new-try' data-feature='jumpPlanner'>Try it</button>"));
			assert.ok(item(7).includes("You've used this"));
			assert.ok(item(5).includes('Turned off') && item(5).includes('>Turn it on</button>'));
			assert.ok(!item(3).includes('whats-new-actions'), 'nothing to try, not used: no line');
			assert.ok(!item(1).includes('whats-new-actions'), 'no feature (skipped PR): no line');
		});

		it('No actions without infoFor (catalog not loaded): as before', () => assert.ok(!whatsNew.render(features, 0).includes('whats-new-actions')));

		it('Escapes the feature id', () => assert.ok(!whatsNew.actionsHtml({ feature: "x' onclick='y", canTry: true }).includes("' onclick")));
	});

	describe('firstRun (new account vs veteran)', () => {
		it('What\'s New seen before: today\'s behaviour, whatever the age', () => {
			assert.equal(whatsNew.firstRun({ whatsNew: { lastSeenPR: 5 } }, 0), 'seen');
			assert.equal(whatsNew.firstRun({ whatsNew: { lastSeenPR: 5 } }, null), 'seen');
		});
		it('Never seen, account under 14 days: new', () => {
			assert.equal(whatsNew.firstRun({}, 0), 'new');
			assert.equal(whatsNew.firstRun({}, 13), 'new');
		});
		it('Never seen, older account (a veteran who never opened it): unknown, today\'s behaviour', () => assert.equal(whatsNew.firstRun({}, 14), 'unknown'));
		it('Server answer failed or odd: unknown, today\'s behaviour', () => {
			[null, undefined, 'x', NaN, -1].forEach(a => assert.equal(whatsNew.firstRun({}, a), 'unknown', String(a)));
			assert.equal(whatsNew.firstRun(null, 3), 'new');
		});

		it('A new account ignores What\'s New state the server didn\'t send (another account\'s, from this browser)', () => {
			assert.equal(whatsNew.firstRun({ whatsNew: { lastSeenPR: 5 } }, 2, false), 'new');
			assert.equal(whatsNew.firstRun({ whatsNew: { lastSeenPR: 5 } }, 2, true), 'seen');
			assert.equal(whatsNew.firstRun({ whatsNew: { lastSeenPR: 5 } }, 20, false), 'seen', 'an old account keeps today\'s behaviour');
			assert.equal(whatsNew.firstRun({ whatsNew: { lastSeenPR: 5 } }, null, false), 'seen', 'age unknown: today\'s behaviour');
		});
		it('serverHadOptions', () => {
			assert.equal(whatsNew.serverHadOptions({ options: null }), false);
			assert.equal(whatsNew.serverHadOptions({ options: {} }), false);
			assert.equal(whatsNew.serverHadOptions(null), false);
			assert.equal(whatsNew.serverHadOptions({ options: { whatsNew: { lastSeenPR: 1 } } }), true);
		});

		describe('firstRunKind', () => {
			const saved = {};
			before(() => { saved.options = global.options; saved.forkUsage = global.forkUsage; saved.init = global.init; });
			afterEach(() => { global.options = saved.options; global.forkUsage = saved.forkUsage; global.init = saved.init; });

			it('local state from another account (server had none) waits for the account age', async () => {
				global.options = { whatsNew: { lastSeenPR: 1 } };
				global.init = { options: null };
				global.forkUsage = { serverInfo: Promise.resolve({ accountAgeDays: 0 }) };
				assert.equal(await whatsNew.firstRunKind(), 'new');
			});
			it('seen: no wait for the server', async () => {
				global.init = { options: { whatsNew: { lastSeenPR: 1 } } };
				global.options = { whatsNew: { lastSeenPR: 1 } };
				global.forkUsage = { serverInfo: new Promise(() => {}) };
				assert.equal(await whatsNew.firstRunKind(), 'seen');
			});
			it('new from the server\'s account age', async () => {
				global.options = {};
				global.forkUsage = { serverInfo: Promise.resolve({ accountAgeDays: 2 }) };
				assert.equal(await whatsNew.firstRunKind(), 'new');
			});
			it('veteran account', async () => {
				global.options = {};
				global.forkUsage = { serverInfo: Promise.resolve({ accountAgeDays: 14 }) };
				assert.equal(await whatsNew.firstRunKind(), 'unknown');
			});
			it('server failure (null answer, rejected, no forkUsage): unknown', async () => {
				global.options = {};
				global.forkUsage = { serverInfo: Promise.resolve(null) };
				assert.equal(await whatsNew.firstRunKind(), 'unknown');
				global.forkUsage = { serverInfo: Promise.reject(new Error('x')) };
				assert.equal(await whatsNew.firstRunKind(), 'unknown');
				global.forkUsage = undefined;
				assert.equal(await whatsNew.firstRunKind(), 'unknown');
			});
		});
	});
});
