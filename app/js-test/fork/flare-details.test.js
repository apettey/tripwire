const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/flare-details');

const T = Date.UTC(2026, 10, 15, 12, 0) / 1000;
const data = (flares) => ({ flares: flares, last_modified: '11/15/2026 12:00:00 UTC' });
const flare = (systemID, colour, extra) => Object.assign({ systemID: systemID, flare: colour, time: '2026-11-15 12:00:00', lifeLength: 86400, reason: null, setAt: T }, extra || {});

describe('Flare details', () => {
	describe('find / list', () => {
		it('finds a flare by system id, string or number', () => {
			const d = data([flare(31000880, 'red'), flare(30002537, 'green')]);
			assert.strictEqual(flareDetails.find(d, '30002537').flare, 'green');
			assert.strictEqual(flareDetails.find(d, 31000880).flare, 'red');
			assert.strictEqual(flareDetails.find(d, 1), null);
		});
		it('copes with flares not loaded yet (upstream 2.0 crashed on the first draw)', () => {
			assert.deepStrictEqual(flareDetails.list(undefined), []);
			assert.deepStrictEqual(flareDetails.list(null), []);
			assert.deepStrictEqual(flareDetails.list({}), []);
			assert.strictEqual(flareDetails.find(undefined, 1), null);
			assert.strictEqual(flareDetails.panelHtml(flareDetails.find(undefined, 1), T), '');
		});
	});

	describe('cleanReason', () => {
		it('makes one trimmed line, as the server does', () => {
			assert.strictEqual(flareDetails.cleanReason('  Loki\tgang\n on  the  null '), 'Loki gang on the null');
			assert.strictEqual(flareDetails.cleanReason('a​b‮c'), 'abc');
			assert.strictEqual(flareDetails.cleanReason(undefined), '');
			assert.strictEqual(flareDetails.cleanReason(42), '');
		});
	});

	describe('payload', () => {
		it('sends the lifetime as 86400 or forever', () => {
			assert.deepStrictEqual(flareDetails.payload(31000880, 'red', '86400', 'camp'), { systemID: 31000880, flare: 'red', lifeLength: '86400', reason: 'camp' });
			assert.deepStrictEqual(flareDetails.payload('31000880', 'green', 'forever', ''), { systemID: 31000880, flare: 'green', lifeLength: 'forever' });
			assert.strictEqual(flareDetails.payload(1, 'red', undefined).lifeLength, '86400');
		});
		it('leaves out an empty reason (no field, not "")', () => {
			assert.ok(!('reason' in flareDetails.payload(1, 'red', '86400', '   ')));
			assert.ok(!('reason' in flareDetails.payload(1, 'red', '86400', undefined)));
			assert.ok(!('reason' in flareDetails.payload(1, 'red', '86400', null)));
		});
	});

	describe('recolour / toggle', () => {
		it('keeps the lifetime and reason of the flare already there', () => {
			const d = data([flare(5, 'red', { lifeLength: null, reason: 'hostile dread' })]);
			assert.deepStrictEqual(flareDetails.recolour(d, 5, 'yellow'), { systemID: 5, flare: 'yellow', lifeLength: 'forever', reason: 'hostile dread' });
		});
		it('keeps a 1 day flare at 1 day and sends no reason when it has none', () => {
			const d = data([flare(5, 'red')]);
			assert.deepStrictEqual(flareDetails.recolour(d, 5, 'green'), { systemID: 5, flare: 'green', lifeLength: '86400' });
		});
		it('gives a new flare 1 day and no reason', () => {
			assert.deepStrictEqual(flareDetails.recolour(data([]), 9, 'red'), { systemID: 9, flare: 'red', lifeLength: '86400' });
			assert.deepStrictEqual(flareDetails.recolour(undefined, 9, 'red'), { systemID: 9, flare: 'red', lifeLength: '86400' });
		});
		it('the same colour again removes, another colour re-colours', () => {
			const d = data([flare(5, 'red', { reason: 'x' })]);
			assert.strictEqual(flareDetails.toggle(d, 5, 'red'), null);
			assert.deepStrictEqual(flareDetails.toggle(d, 5, 'green'), { systemID: 5, flare: 'green', lifeLength: '86400', reason: 'x' });
		});
	});

	describe('applyLocal', () => {
		it('replaces the system\'s flare (no duplicates) and puts it first', () => {
			const d = data([flare(1, 'green'), flare(5, 'red')]);
			const out = flareDetails.applyLocal(d, 5, { systemID: 5, flare: 'yellow', lifeLength: 'forever', reason: 'r' }, T + 10);
			assert.deepStrictEqual(out.flares.map(f => [f.systemID, f.flare]), [[5, 'yellow'], [1, 'green']]);
			assert.strictEqual(out.flares[0].lifeLength, null);
			assert.strictEqual(out.flares[0].reason, 'r');
			assert.strictEqual(out.flares[0].setAt, T + 10);
			assert.strictEqual(out.last_modified, d.last_modified);
			assert.strictEqual(d.flares.length, 2);	// the input is not changed
		});
		it('removes on a null payload and starts from nothing', () => {
			assert.deepStrictEqual(flareDetails.applyLocal(data([flare(5, 'red')]), '5', null, T).flares, []);
			const out = flareDetails.applyLocal(undefined, 7, { systemID: 7, flare: 'red', lifeLength: '86400' }, T);
			assert.deepStrictEqual(out.flares.map(f => [f.systemID, f.lifeLength, f.reason]), [[7, 86400, null]]);
		});
	});

	describe('remaining time', () => {
		it('counts down from the time it was set', () => {
			assert.strictEqual(flareDetails.remaining(flare(1, 'red'), T + 3600), 82800);
			assert.strictEqual(flareDetails.remaining(flare(1, 'red'), T + 90000), 0);
			assert.strictEqual(flareDetails.remaining(flare(1, 'red', { lifeLength: null }), T), null);
			assert.strictEqual(flareDetails.remaining(flare(1, 'red', { setAt: undefined }), T), 86400);
		});
		it('reads as hours and minutes, or until removed', () => {
			assert.strictEqual(flareDetails.remainingText(null), 'until removed');
			assert.strictEqual(flareDetails.remainingText(82800), '23 h left');
			assert.strictEqual(flareDetails.remainingText(3600 * 13 + 300), '13 h 5 min left');
			assert.strictEqual(flareDetails.remainingText(2700), '45 min left');
			assert.strictEqual(flareDetails.remainingText(30), 'less than a minute left');
		});
	});

	describe('panel and tooltip HTML', () => {
		const evil = '<img src=x onerror=alert(1)> & "q" \'s';
		it('escapes the reason in the system panel', () => {
			const html = flareDetails.panelHtml(flare(1, 'red', { reason: evil }), T + 3600);
			assert.ok(html.indexOf('<img') < 0);
			assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot; &#39;s'));
			assert.ok(html.includes("class='flare-red'>Battle flare</span>"));
			assert.ok(html.includes('(23 h left)'));
		});
		it('escapes the reason in the map tooltip', () => {
			const html = flareDetails.tooltipHtml(flare(1, 'yellow', { reason: evil, lifeLength: null }), T);
			assert.ok(html.indexOf('<img') < 0);
			assert.ok(html.includes('Hold flare'));
			assert.ok(html.includes('Until removed'));
		});
		it('shows no reason part when there is none, and an unknown colour as red', () => {
			assert.ok(!flareDetails.panelHtml(flare(1, 'green'), T).includes(':'));
			assert.ok(flareDetails.panelHtml(flare(1, '<b>'), T).includes("flare-red"));
		});
		it('panel key changes with colour, reason and time left', () => {
			const a = flareDetails.panelKey(flare(1, 'red'), T);
			assert.notStrictEqual(a, flareDetails.panelKey(flare(1, 'green'), T));
			assert.notStrictEqual(a, flareDetails.panelKey(flare(1, 'red', { reason: 'x' }), T));
			assert.notStrictEqual(a, flareDetails.panelKey(flare(1, 'red'), T + 120));
			assert.strictEqual(flareDetails.panelKey(null, T), '');
		});
	});
});
