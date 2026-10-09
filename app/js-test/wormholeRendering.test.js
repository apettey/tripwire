const assert = require('assert');
const { include, loadJSON } = require('./helpers/helpers');
include('app/js/wormholeRendering');
const wormholes = loadJSON('tools/wormholes');

describe('Wormhole rendering', () => {
	// Something with multiple 'from'
	const D382 = wormholes.D382;
	it('should render the full info if unknown from system', () => {
		const result = wormholeRendering.renderWormholeType(D382, 'D382');
		assert.equal(result, '<b>D382</b>: <span class="wh class-2">C2</span>,<span class="wh class-14">C14</span>,<span class="wh class-15">C15</span>,<span class="wh class-16">C16</span>,<span class="wh class-17">C17</span>,<span class="wh class-18">C18</span>➔<span class="wh class-2">C2</span> (375kt)');
	});
	it('should render with the given class if known', () => {
		const result = wormholeRendering.renderWormholeType(D382, 'D382', 'Class-2');
		assert.equal(result, '<b>D382</b>: <span class="wh class-2">C2</span>➔<span class="wh class-2">C2</span> (375kt)');
	});
	it('should render with the class from single system if known', () => {
		const result = wormholeRendering.renderWormholeType(D382, 'D382', 'J210536');
		assert.equal(result, '<b>D382</b>: <span class="wh class-2">C2</span>➔<span class="wh class-2">C2</span> (375kt)');
	});	
	it('should render with the exact system if in valid list', () => {
		const result = wormholeRendering.renderWormholeType(wormholes.L005, 'L005', 'Thera');
		assert.equal(result, '<b>L005</b>: <span class="wh class-12">Thera</span>➔<span class="wh class-2">C2</span> (5kt)');
	});		
	it('should render with the exact system object if in valid list', () => {
		const result = wormholeRendering.renderWormholeType(wormholes.L005, 'L005', { name: 'Thera' });
		assert.equal(result, '<b>L005</b>: <span class="wh class-12">Thera</span>➔<span class="wh class-2">C2</span> (5kt)');
	});	
	it('should render the full info if system matches no options', () => {
		const result = wormholeRendering.renderWormholeType(D382, 'D382', 'Jita');
		assert.equal(result, '<b>D382</b>: <span class="wh class-2">C2</span>,<span class="wh class-14">C14</span>,<span class="wh class-15">C15</span>,<span class="wh class-16">C16</span>,<span class="wh class-17">C17</span>,<span class="wh class-18">C18</span>➔<span class="wh class-2">C2</span> (375kt)');
	});	
});