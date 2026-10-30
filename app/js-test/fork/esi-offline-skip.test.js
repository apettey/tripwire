const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/esi-offline-skip');

describe('esiOfflineSkip', () => {
	it('stateOf: only a real true / false counts', () => {
		assert.strictEqual(esiOfflineSkip.stateOf({ online: true }), 'online');
		assert.strictEqual(esiOfflineSkip.stateOf({ online: false, last_logout: 'x' }), 'offline');
		assert.strictEqual(esiOfflineSkip.stateOf({}), 'unknown');
		assert.strictEqual(esiOfflineSkip.stateOf({ online: 'false' }), 'unknown');
		assert.strictEqual(esiOfflineSkip.stateOf(null), 'unknown');
	});

	it('shouldPoll: skip only a known-offline character whose token is fine', () => {
		assert.strictEqual(esiOfflineSkip.shouldPoll('online', false), true);
		assert.strictEqual(esiOfflineSkip.shouldPoll(undefined, false), true, 'unknown (first load, failed request, no scope)');
		assert.strictEqual(esiOfflineSkip.shouldPoll('unknown', false), true);
		assert.strictEqual(esiOfflineSkip.shouldPoll('offline', false), false);
		assert.strictEqual(esiOfflineSkip.shouldPoll('offline', true), true, 'token about to expire: upstream asks for a refresh');
		assert.strictEqual(esiOfflineSkip.shouldPoll('offline', false, true), true, 'active or opted in: never skipped');
	});

	it('keptIds: the active character, plus the opted-in ones when the feature is on', () => {
		const chars = { 1: { characterName: 'A' }, 2: { characterName: 'B' }, 3: { characterName: 'C' } };
		const mt = { optedIn: (o, c) => (o && o.multiTrack && o.multiTrack.enabled ? Object.keys(c).filter(id => !(o.multiTrack.exclude || {})[id]) : []) };
		assert.deepStrictEqual(esiOfflineSkip.keptIds({ tracking: { active: '2' } }, chars, mt), ['2']);
		assert.deepStrictEqual(esiOfflineSkip.keptIds({ tracking: { active: 2 }, multiTrack: { enabled: true, exclude: { 3: true } } }, chars, mt), ['2', '1']);
		assert.deepStrictEqual(esiOfflineSkip.keptIds({ tracking: { active: null } }, chars, null), []);
		assert.deepStrictEqual(esiOfflineSkip.keptIds(null, chars, mt), []);
	});

	it('filter: a new map with the same objects, offline ones left out', () => {
		const chars = { 1: { characterID: 1 }, 2: { characterID: 2 }, 3: { characterID: 3 }, 4: { characterID: 4, exp: true } };
		const out = esiOfflineSkip.filter(chars, { 1: 'online', 2: 'offline', 4: 'offline' }, c => !!c.exp);
		assert.deepStrictEqual(Object.keys(out), ['1', '3', '4']);
		assert.strictEqual(out[1], chars[1]);
		assert.notStrictEqual(out, chars);
		assert.deepStrictEqual(Object.keys(esiOfflineSkip.filter(chars, {}, null)), ['1', '2', '3', '4']);
		assert.deepStrictEqual(Object.keys(esiOfflineSkip.filter(chars, { 2: 'offline' }, null, id => id === '2')), ['1', '2', '3', '4'], 'kept');
		assert.deepStrictEqual(esiOfflineSkip.filter(undefined, {}), {});
	});

	it('resumes: offline to online only', () => {
		assert.strictEqual(esiOfflineSkip.resumes('offline', 'online'), true);
		assert.strictEqual(esiOfflineSkip.resumes(undefined, 'online'), false);
		assert.strictEqual(esiOfflineSkip.resumes('online', 'online'), false);
		assert.strictEqual(esiOfflineSkip.resumes('offline', 'unknown'), false);
	});

	describe('wired to a stand-in esi', () => {
		let calls, tw, statusAnswers;
		const hadMoment = Object.prototype.hasOwnProperty.call(global, 'moment'), savedMoment = global.moment;
		afterEach(() => { if (hadMoment) { global.moment = savedMoment; } else { delete global.moment; } });
		const deferred = () => {
			const d = { doneFns: [], failFns: [] };
			d.done = fn => { d.doneFns.push(fn); return d; };
			d.fail = fn => { d.failFns.push(fn); return d; };
			return d;
		};
		beforeEach(() => {
			calls = [];
			statusAnswers = {};
			esiOfflineSkip.states = {};
			tw = { esi: { characters: { 1: { characterID: 1 }, 2: { characterID: 2 } } } };
			tw.esi.location = function() { Object.keys(tw.esi.characters).forEach(id => calls.push('location:' + id)); };
			tw.esi.ship = function() { Object.keys(tw.esi.characters).forEach(id => calls.push('ship:' + id)); };
			tw.esi.characterStatus = function(id) { const d = deferred(); statusAnswers[id] = d; return d; };
			global.moment = undefined;
			esiOfflineSkip.install(tw);
		});
		const answer = (id, data) => statusAnswers[id].doneFns.forEach(fn => fn(data));
		const failed = (id) => statusAnswers[id].failFns.forEach(fn => fn({ status: 403 }));

		it('unknown polls everyone; offline is skipped; a failure is unknown again; coming back polls at once', () => {
			const tokenOk = () => { tw.esi.characters[1].tokenExpire = tw.esi.characters[2].tokenExpire = 'x'; };
			tokenOk();
			global.moment = (function() {
				const m = function() { return { isBefore: () => false }; };
				m.utc = function() { return { subtract: () => ({ isBefore: () => false }) }; };
				return m;
			})();
			tw.esi.location(); tw.esi.ship();
			assert.deepStrictEqual(calls, ['location:1', 'location:2', 'ship:1', 'ship:2'], 'unknown: as today');

			tw.esi.characterStatus(1); tw.esi.characterStatus(2);
			answer(1, { online: true }); answer(2, { online: false });
			calls = [];
			tw.esi.location(); tw.esi.ship();
			assert.deepStrictEqual(calls, ['location:1', 'ship:1'], 'offline alt skipped');
			assert.strictEqual(Object.keys(tw.esi.characters).length, 2, 'map put back');

			tw.esi.characterStatus(2); failed(2);
			calls = [];
			tw.esi.location();
			assert.deepStrictEqual(calls, ['location:1', 'location:2'], 'failed /online/: never stuck offline');

			tw.esi.characterStatus(2); answer(2, { online: false });
			calls = [];
			tw.esi.characterStatus(2); answer(2, { online: true });
			assert.deepStrictEqual(calls, ['location:2', 'ship:2'], 'back online: that character at once');
			calls = [];
			tw.esi.location();
			assert.deepStrictEqual(calls, ['location:1', 'location:2']);
		});

		it('the active character is polled even when /online/ says offline (a login takes up to 2 minutes to show)', () => {
			global.options = { tracking: { active: '2' } };
			try {
				tw.esi.characters[1].tokenExpire = tw.esi.characters[2].tokenExpire = 'x';
				global.moment = (function() { const m = function() { return {}; }; m.utc = function() { return { subtract: () => ({ isBefore: () => false }) }; }; return m; })();
				tw.esi.characterStatus(1); tw.esi.characterStatus(2);
				answer(1, { online: false }); answer(2, { online: false });
				calls = [];
				tw.esi.location();
				assert.deepStrictEqual(calls, ['location:2'], 'only the offline alt that is not active is skipped');
			} finally { delete global.options; }
		});

		it('an offline character with an expiring token stays in the loop (upstream asks for the refresh)', () => {
			tw.esi.characterStatus(2); answer(2, { online: false });
			calls = [];
			tw.esi.location();	// no moment: can't tell, so treated as expiring
			assert.deepStrictEqual(calls, ['location:1', 'location:2']);
		});
	});
});
