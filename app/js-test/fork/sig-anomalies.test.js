const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/sig-anomalies');

describe('Cosmic anomalies in the signature list', () => {
	const hide = { sigAnomalies: { mode: 'hide' } };
	const skip = { sigAnomalies: { mode: 'skip' } };
	const anomalyRow = { id: ['ABC', '123'], scanGroup: 'Cosmic Anomaly', type: 'Combat' };
	const sigRow = { id: ['ABC', '124'], scanGroup: 'Cosmic Signature', type: 'Data' };

	it('recognises the anomaly group in every language', () => {
		['Cosmic Anomaly', 'Anomalie cosmique', 'Kosmische Anomalie', '宇宙の特異点', '코즈믹 어노말리', 'Космическая аномалия']
			.forEach(g => assert.ok(sigAnomalies.isAnomalyGroup(g), g));
	});
	it('does not take signature groups for anomalies', () => {
		['Cosmic Signature', 'Signature cosmique', 'Kosmische Signatur', '宇宙のシグネチャ', '코즈믹 시그니처', 'Скрытый сигнал', '', undefined]
			.forEach(g => assert.ok(!sigAnomalies.isAnomalyGroup(g), String(g)));
	});

	describe('mode', () => {
		it('defaults to show', () => { assert.equal(sigAnomalies.mode(undefined), 'show'); assert.equal(sigAnomalies.mode({}), 'show'); });
		it('ignores unknown values', () => assert.equal(sigAnomalies.mode({ sigAnomalies: { mode: 'x' } }), 'show'));
		it('reads hide and skip', () => { assert.equal(sigAnomalies.mode(hide), 'hide'); assert.equal(sigAnomalies.mode(skip), 'skip'); });
	});

	describe('paste', () => {
		it('marks anomaly rows only', () => {
			assert.equal(sigAnomalies.marker(anomalyRow), 'anomaly');
			assert.equal(sigAnomalies.marker(sigRow), undefined);
		});
		it('skips anomaly rows only in skip mode', () => {
			assert.ok(sigAnomalies.skipRow(anomalyRow, undefined, skip));
			assert.ok(!sigAnomalies.skipRow(anomalyRow, undefined, hide));
			assert.ok(!sigAnomalies.skipRow(anomalyRow, undefined, undefined));
			assert.ok(!sigAnomalies.skipRow(sigRow, undefined, skip));
		});
		it('does not skip an anomaly already in the list: it only gets marked', () => assert.ok(!sigAnomalies.skipRow(anomalyRow, { type: 'combat' }, skip)));
		it('marks an existing unmarked sig, once, in every mode, and never wormholes', () => {
			assert.ok(sigAnomalies.needsMark(anomalyRow, { type: 'combat' }));
			assert.ok(!sigAnomalies.needsMark(anomalyRow, { type: 'combat', bookmark: 'anomaly' }));
			assert.ok(!sigAnomalies.needsMark(anomalyRow, { type: 'wormhole' }));
			assert.ok(!sigAnomalies.needsMark(sigRow, { type: 'data' }));
		});
	});

	describe('delete missing sigs', () => {
		it('keeps anomalies absent from the paste in skip mode', () => assert.ok(sigAnomalies.keepOnFullPaste({ bookmark: 'anomaly' }, skip)));
		it('treats anomalies like other sigs in show and hide mode', () => {
			assert.ok(!sigAnomalies.keepOnFullPaste({ bookmark: 'anomaly' }, hide));
			assert.ok(!sigAnomalies.keepOnFullPaste({ bookmark: 'anomaly' }, undefined));
		});
		it('never keeps ordinary sigs', () => assert.ok(!sigAnomalies.keepOnFullPaste({ bookmark: null }, skip)));
	});

	describe('selection', () => {
		let saved;
		beforeEach(() => { saved = global.$; });
		afterEach(() => { global.$ = saved; });
		it('drops hidden rows from the selection and refreshes the buttons', () => {
			const calls = [];
			global.$ = sel => ({
				length: sel.indexOf('sig-anomaly-hidden.selected') >= 0 ? 2 : 1,
				removeClass: c => calls.push('removeClass ' + c),
				trigger: e => calls.push('trigger ' + e)
			});
			sigAnomalies.unselectHidden();
			assert.deepEqual(calls, ['removeClass selected', 'trigger selected:change']);
		});
		it('does nothing when no hidden row is selected', () => {
			const calls = [];
			global.$ = () => ({ length: 0, removeClass: () => calls.push('x'), trigger: () => calls.push('x') });
			sigAnomalies.unselectHidden();
			assert.deepEqual(calls, []);
		});
	});

	describe('list', () => {
		const sigs = { 1: { systemID: 5, bookmark: 'anomaly' }, 2: { systemID: 5 }, 3: { systemID: 6, bookmark: 'anomaly' }, 4: { systemID: 5, bookmark: 'anomaly' } };
		it('hides marked anomalies of the viewed system in hide mode', () => assert.deepEqual(sigAnomalies.hiddenIds(sigs, 5, hide), ['1', '4']));
		it('hides nothing in show and skip mode', () => {
			assert.deepEqual(sigAnomalies.hiddenIds(sigs, 5, undefined), []);
			assert.deepEqual(sigAnomalies.hiddenIds(sigs, 5, skip), []);
		});
		it('bar text counts and toggles', () => {
			assert.equal(sigAnomalies.barText(0, false), '');
			assert.equal(sigAnomalies.barText(1, false), '1 anomaly hidden - show');
			assert.equal(sigAnomalies.barText(3, false), '3 anomalies hidden - show');
			assert.equal(sigAnomalies.barText(3, true), 'Showing 3 anomalies - hide');
		});
	});
});
