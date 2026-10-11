const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/sound-mute');

describe('Sound mute button', () => {
	describe('enabled', () => {
		it('is shown when options have no soundMute key', () => assert.equal(soundMute.enabled({}), true));
		it('is shown without options', () => assert.equal(soundMute.enabled(undefined), true));
		it('is hidden only when explicitly off', () => assert.equal(soundMute.enabled({ soundMute: { enabled: false } }), false));
	});

	describe('muted', () => {
		it('is off by default', () => assert.equal(soundMute.muted({}), false));
		it('is on when muted is true', () => assert.equal(soundMute.muted({ soundMute: { muted: true } }), true));
		it('only true counts', () => assert.equal(soundMute.muted({ soundMute: { muted: 'yes' } }), false));
		it('is off while the button is hidden', () => assert.equal(soundMute.muted({ soundMute: { enabled: false, muted: true } }), false));
	});

	describe('withMuted', () => {
		it('sets muted and keeps the button shown', () => assert.deepEqual(soundMute.withMuted({}, true).soundMute, { enabled: true, muted: true }));
		it('keeps an explicit enabled flag', () => assert.deepEqual(soundMute.withMuted({ soundMute: { enabled: false } }, false).soundMute, { enabled: false, muted: false }));
	});

	describe('icon and tooltip', () => {
		it('muted icon has a cross, unmuted has waves', () => {
			assert.notEqual(soundMute.iconSvg(true), soundMute.iconSvg(false));
			assert.ok(soundMute.iconSvg(true).indexOf('M16 9l6 6') >= 0);
		});
		it('tooltip says how to unmute when muted', () => assert.ok(/unmute/.test(soundMute.tooltip(true))));
	});

	describe('wrapPlayer', () => {
		let calls;
		beforeEach(() => {
			calls = [];
			global.killReporting = { play: (id, v, c, done) => { calls.push(id); if (done) { done(); } } };
			soundMute.previewing = false;
		});
		afterEach(() => { delete global.killReporting; delete global.options; });

		it('plays when not muted', () => {
			global.options = {};
			soundMute.wrapPlayer();
			killReporting.play('tone-chime', 50, 'kill');
			assert.deepEqual(calls, ['tone-chime']);
		});
		it('skips the sound when muted but still calls done', () => {
			global.options = { soundMute: { muted: true } };
			soundMute.wrapPlayer();
			let finished = false;
			killReporting.play('tone-chime', 50, 'kill', () => { finished = true; });
			assert.deepEqual(calls, []);
			assert.equal(finished, true);
		});
		it('a Settings test still plays while muted', () => {
			global.options = { soundMute: { muted: true } };
			soundMute.wrapPlayer();
			soundMute.previewing = true;
			killReporting.play('speech', 50, 'kill');
			assert.deepEqual(calls, ['speech']);
		});
		it('wraps only once', () => {
			soundMute.wrapPlayer();
			const wrapped = killReporting.play;
			soundMute.wrapPlayer();
			assert.equal(killReporting.play, wrapped);
		});
	});
});
