var guidance = (function (undefined) {
	

	var sorter = function (a, b) {
		return parseFloat (a) - parseFloat (b);
	}

	function adjustCostForOptions(mapCost, toSystem) {		
		var system = systemAnalysis.analyse(30000000 + 1 * toSystem);
		if(!system) { return mapCost; }
		if(options.chain.routeIgnore.enabled && options.chain.routeIgnore.systems.indexOf(system.name) >= 0) {
			mapCost += 100;	// Penalty for an avoided system
		}
		if(system.name == 'Zarzakh') { mapCost += 100; } // Always avoid Zarzakh for its 6h wait
		switch(options.chain.routeSecurity) {
			case 'highsec': return mapCost + (system.security < 0.45 ? 100 : 0);
			case 'avoid-high': return mapCost + (system.security >= 0.45 ? 100 : 0);
			case 'avoid-null': return mapCost + (system.security <= 0.0 ? 100 : 0);
			default: return mapCost;	// in case of some invalid option, default to shortest
		}	
	}
	
	function adjustJumpCost(from, to, cost) {
		return Guidance.jumpCostModifiers.reduce((cost, modifier) => modifier(from, to, cost), cost);
	}

	/** Find a path between the start and end nodes (which may be arrays), up to the path length limit */
	var findPaths = function (map, start, end, limit) {
		if(!Array.isArray(start)) { start = [start]; } 
		if(!Array.isArray(end)) { end = [end]; } 
		
		start = start.filter(function(x) { return map[x]; });
		end = end.filter(function(x) { return map[x]; });
		
		const endsInStart = end.filter(function(x) { return start.indexOf(x) >= 0; });
		if(endsInStart.length) { return [endsInStart[0]]; }
		
		if(!(start.length && end.length)) { return null; }	// both ends of path must be in network somewhere

		var costs = {},
		    open = {'0': []},
		    predecessors = {},
		    keys;
		
		start.forEach(function(x) { costs[x] = 0; open[0].push(x); });

		var addToOpen = function (cost, vertex) {
			var key = "" + cost;
			if (!open[key]) open[key] = [];
			open[key].push(vertex);
		}

		while ((keys = Object.keys(open)).length) {
			keys.sort(sorter);

			var key = keys[0],
			    bucket = open[key],
			    node = bucket.shift(),
			    currentCost = parseFloat(key),
			    adjacentNodes = map[node] || {};

			if (!bucket.length) delete open[key];
			if(currentCost >= limit) { break; }

			for (var vertexText in adjacentNodes) {
				const vertex = 1 * vertexText;
			    if (adjacentNodes[vertex] !== undefined) {
					var cost = 1 + adjustCostForOptions(adjacentNodes[vertex], vertex),
					    totalCost = cost + currentCost,
					    vertexCost = costs[vertex];
					
					cost = adjustJumpCost(node, vertex, cost);

					if ((cost > 0) && (vertexCost === undefined) || (vertexCost > totalCost)) {
						costs[vertex] = totalCost;
						addToOpen(totalCost, vertex);
						predecessors[vertex] = node;
						if(end.indexOf(vertex) >= 0) {
							return extractShortest(predecessors, vertex);
						}
					}
				}
			}
		}
		
		return null;	// never hit any end node
	}

	var extractShortest = function (predecessors, end) {
		var nodes = [],
		    u = end;

		while (u) {
			nodes.push(u);
			predecessor = predecessors[u];
			u = predecessors[u];
		}

		nodes.reverse();
		return nodes;
	}

	/** Find the best path that connects the given nodes, in that order. The limit will be applied to each path segment, not the path as a whole. */
	var findMultiNodePath = function (map, nodes, limit) {
		var start = nodes.shift(),
		    end,
		    predecessors,
		    path = [],
		    shortest;

		while (nodes.length) {
			end = nodes.shift();
			shortest = findPaths(map, start, end, limit);

			if (shortest) {
				if (nodes.length) {
					path.push.apply(path, shortest.slice(0, -1));
				} else {
					return path.concat(shortest);
				}
			} else {
				return null;
			}

			start = end;
		}
	}
	
	var Guidance = { kSpaceCache: {}, jumpCostModifiers: [] };
	Guidance.clearCache = function() { Guidance.kSpaceCache = {}; }
	
	/** Find the shortest path between start and end nodes on the given map.
	The map should be a dictionary of node IDs where each entry is a dictionary of connected nodes and costs (see appData.map.shortest). An additional cost of 1 per jump will be added.
	You may also specify a maximum path length limit, if no path under this length is found then no path will be returned, even if a longer one is available.
	Start and end nodes may be a single ID or an array of IDs. If arrays are used then a single shortest path between any combination of nodes will be returned */
	Guidance.findShortestPath = function (map, start, end, limit) {
		if(start > 30000000) { start -= 30000000; }
		if(end > 30000000) { end -= 30000000; }
		
		const nodes = [start, end];

		const cacheKey = nodes.join(',') + (limit ? '-' + limit : '');
		const cachedPath = Guidance.kSpaceCache[cacheKey];
		if(cachedPath === undefined) {
			return Guidance.kSpaceCache[cacheKey] = findPaths(map, start, end, limit);
		} else {
			return cachedPath;
		}
	}
	
	/** Find the systems directly connected to this one. System IDs are in normal (+ 30000000) domain. */
	Guidance.connections = function(map, start) {
		if(start > 30000000) { start -= 30000000; }
		return Object.keys(map[start] || {})
			.map(k => (k * 1))
			.map(k => {
				const r = { systemID: k + 30000000 };
				if(0 > adjustJumpCost(start, k, 1)) { r.closed = true; }
				return r;
			});
	}

	return Guidance;
})();
