const assert = require('assert');
const { include, loadJSON } = require('./helpers/helpers');
const { document } = require('./helpers/fakeDOM');
include('app/js/maskRendering');

describe('Mask rendering', () => {
	const sampleData = loadJSON('app/js-test/testdata/masks-sample');
	
	describe('Render single mask', () => {
		it('should render default public mask', () => {
			const result = maskRendering.renderMask(sampleData[0]);
			assert.equal(result, '<span class="mask" data-mask="0.0"><i data-icon="eye" class="global"></i>Public</span>');
		});
		it('should render default personal mask', () => {
			const result = maskRendering.renderMask(sampleData[1]);
			assert.equal(result, '<span class="mask" data-mask="96191857.1"><i data-icon="user" class="character"></i>Private</span>');
		});
		it('should render default corp mask', () => {
			const result = maskRendering.renderMask(sampleData[2]);
			assert.equal(result, '<span class="mask" data-mask="98363074.2"><i data-icon="star" class="corporate"></i>Corp</span>');
		});	
		it('should render default alliance mask', () => {
			const result = maskRendering.renderMask(sampleData[3]);
			assert.equal(result, '<span class="mask" data-mask="99005476.3"><i data-icon="star" class="alliance"></i>Alliance</span>');
		});
		it('should render owned personal mask', () => {
			const result = maskRendering.renderMask(sampleData[4]);
			assert.equal(result, '<span class="mask" data-mask="1.0"><i data-icon="user" class="character"></i>Owned</span>');
		});
	});
	
	describe('Update DOM', () => {
		beforeEach(() => {
			document.setup();
			document.elementsById['mask'] = document.createElement('a');
			document.elementsById['mask-menu-mask-list'] = document.createElement('div');
		});
		
		it('should update current mask', () => {
			maskRendering.update( [ sampleData[2] ], "98363074.2" );
			assert.equal(document.getElementById('mask').innerHTML, '<span class="mask" data-mask="98363074.2"><i data-icon="star" class="corporate"></i>Corp</span>');
		});
		
		it('should update mask list, showing owned, active and joined/alliance', () => {
			maskRendering.update( sampleData, "4.0" );
			// No 3 because it isn't joined. 4 is here because it's active
			assert.deepEqual(document.getElementById('mask-menu-mask-list').children.map(n => n.className), [
				undefined, undefined, undefined, undefined, undefined, undefined, 'active', undefined
			]);
			assert.deepEqual(document.getElementById('mask-menu-mask-list').children.map(n => n.innerHTML), [
				'<span class="mask" data-mask="0.0"><i data-icon="eye" class="global"></i>Public</span>',
				'<span class="mask" data-mask="96191857.1"><i data-icon="user" class="character"></i>Private</span>',
				'<span class="mask" data-mask="98363074.2"><i data-icon="star" class="corporate"></i>Corp</span>',
				'<span class="mask" data-mask="99005476.3"><i data-icon="star" class="alliance"></i>Alliance</span>',
				'<span class="mask" data-mask="1.0"><i data-icon="user" class="character"></i>Owned</span>',			
				'<span class="mask" data-mask="2.0"><i data-icon="user" class="character"></i>Personal</span>',			
				'<span class="mask" data-mask="4.0"><i data-icon="star" class="corporate"></i>Joined through corp</span>',
				'<span class="mask" data-mask="5.0"><i data-icon="star" class="corporate"></i>Invited through alliance</span>',
			]);			
		});
	});
});
