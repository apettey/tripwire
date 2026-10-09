/** Functions for rendering things relating to masks */
const maskRendering = new function() { 
	/** Render a mask, as returned from masks.php */
	this.renderMask = function(mask) {
		const icons = { global: 'eye', character: 'user', corporate: 'star', alliance: 'star' };

		return '<span class="mask" data-mask="' + mask.mask + '">'
			+ '<i data-icon="' + icons[mask.ownerType] + '" class="' + mask.ownerType + '"></i>'
			+ mask.label
			+ '</span>';
	}
	
	this.update = function(masks, newActive) {
		const activeMask = masks.find(x => newActive !== undefined ? x.mask === newActive : x.active);
		document.getElementById('mask').innerHTML = maskRendering.renderMask(activeMask);
		const list = document.getElementById('mask-menu-mask-list');
		list.innerHTML = '';
		masks.filter(m => m.owner || (m.joined || m.joinedBy == 'alliance') || m == activeMask).map(m => {
			const a = document.createElement('a');
			a.href = '#';
			a.innerHTML = this.renderMask(m);
			if(m === activeMask) { a.className = 'active'; }
			a.addEventListener('click', e => {
				maskFunctions.updateActiveMask(m.mask, () => document.getElementById('mask-menu').style.display = 'none');
			});
			list.appendChild(a);
		});
	}
};