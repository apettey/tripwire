const mutator_favourite = new _FavouriteMutator();
systemAnalysis.addMutator(mutator_favourite);

function _FavouriteMutator() {
	const _this = this;

	this.mutate = function(system, systemID) {
		if(options.favorites.indexOf(systemID * 1) >= 0) {
			system.pathSymbol = '★';
			system.systemTypeModifiers.push('<span class="favorite active" data-icon="star"></span>');		// star added by CSS
		}
	}
}