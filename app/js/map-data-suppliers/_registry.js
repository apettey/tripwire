// Registry of third-party map data suppliers.
//
// The directory name always implied a set, but chain-map.js hard-coded
// `thirdPartySuppliers = [ eveScout ]`, so adding a source meant editing core.
// A supplier now registers itself and the chain map asks the registry, which
// is what lets a corp-specific intel feed or a second scout source be added as
// one file.
//
// Deliberately a bare global rather than a property of `tripwire`: the build
// loads app/js/map-data-suppliers/*.js before app/js/tripwire.js, so that
// object does not exist yet. Same reason eveScout itself is a bare const.

var mapDataSuppliers = (function() {
	var suppliers = [];

	return {
		// A supplier must implement findLinks(systemID, ids) -> array of
		// connections; ids carries a parent id and a child id to increment per
		// connection. active() is optional and defaults to always on.
		register: function(supplier) {
			if (!supplier || typeof supplier.findLinks !== "function") {
				throw new Error("Map data supplier must implement findLinks(systemID, ids)");
			}
			suppliers.push(supplier);
			return supplier;
		},

		all: function() { return suppliers.slice(); }
	};
})();
