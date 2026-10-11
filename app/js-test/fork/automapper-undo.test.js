const assert = require('assert');
const { include } = require('../helpers/helpers');
include('app/js/fork/automapper-undo');

describe('automapperUndo.system', () => {
	const FROM = 31000005, TO = 31000006, ELSEWHERE = 30000142;
	it('keeps the viewed system when it is the origin', () => assert.equal(automapperUndo.system(FROM, FROM, TO), FROM));
	it('keeps the viewed system when it is the destination', () => assert.equal(automapperUndo.system(TO, FROM, TO), TO));
	it('uses the destination when viewing an unrelated system', () => assert.equal(automapperUndo.system(ELSEWHERE, FROM, TO), TO));
	it('uses the destination when nothing is viewed', () => assert.equal(automapperUndo.system(undefined, FROM, TO), TO));
});
