const sizeTags = {
	/** Size classes by the max jump mass (kg) of a wormhole, smallest first */
	classes: [
		{ size: 'S', max: 5000000, label: 'frigates and destroyers' },
		{ size: 'M', max: 62000000, label: 'up to battlecruisers' },
		{ size: 'L', max: 410000000, label: 'up to battleships' },
		{ size: 'VL', max: 1000000000, label: 'freighters, not capitals' },
		{ size: 'XL', max: Infinity, label: 'capitals' }
	],

	/** Size class for a wormhole's max jump mass in kg: 'S'|'M'|'L'|'VL'|'XL', or null if unknown */
	sizeOf: function(jumpKg) {
		const jump = Number(jumpKg);
		if (!jump || jump <= 0 || isNaN(jump)) { return null; }
		for (var i = 0; i < sizeTags.classes.length; i++) {
			if (jump <= sizeTags.classes[i].max) { return sizeTags.classes[i].size; }
		}
		return null;
	},

	/** Size tag for a connection, using the same lookup as the chain map's connection auras.
	@return { size, certain, jump } or null if no size is known.
	certain is true when the size comes from a known wormhole type, false when it is guessed from the system classes. */
	tagFor: function(parentType, childType, parentSystemID, childSystemID) {
		const known = wormholeAnalysis.wormholeFromTypePair(parentType, childType);
		const wormhole = known || wormholeAnalysis.likelyWormhole(parentSystemID, childSystemID);
		if (!wormhole) { return null; }
		const size = sizeTags.sizeOf(wormhole.jump);
		return size ? { size: size, certain: !!known, jump: wormhole.jump } : null;
	},

	formatKt: function(jumpKg) {
		return String(Math.round(jumpKg / 1e6)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	},

	/** HTML for a tag from tagFor, or '' if there is none. extra: optional extra class and inline style (numbers only) */
	tagHtml: function(tag, extraClass, style) {
		// A hole the watchlist highlights (watchlist.decorateHoles): an eye in front, or the eye alone without a size
		const watch = tag && Array.isArray(tag.watchlist) && tag.watchlist.length ? tag.watchlist : null;
		if (watch && typeof watchlist !== 'undefined') {
			const names = 'Watchlist: ' + watch.join(', ');
			if (!tag.size) {
				return '<span class="size-tag size-tag-watchlist size-tag-watchlist-only' + (extraClass ? ' ' + extraClass : '') + '"' + (style ? ' style="' + style + '"' : '')
					+ ' title="' + watchlist.escape(names) + '"><i data-icon="eye"></i></span>';
			}
			const plain = Object.assign({}, tag, { watchlist: null });
			return sizeTags.tagHtml(plain, 'size-tag-watchlist' + (extraClass ? ' ' + extraClass : ''), style)
				.replace(/ title="([^"]*)">/, function(m, title) { return ' title="' + watchlist.escape(names) + ' · ' + title + '"><i data-icon="eye"></i>'; });
		}
		if (!tag || !tag.size) { return ''; }
		const cls = sizeTags.classes.filter(function(c) { return c.size == tag.size; })[0];
		const title = (tag.certain ? 'Max ship ' : 'Likely max ship ') + (tag.jump ? sizeTags.formatKt(tag.jump) + ' kt ' : '') +
			'(' + (cls ? cls.label : tag.size) + ')' +
			(tag.certain ? '' : ' - wormhole type unknown, guessed from the system classes');
		return '<span class="size-tag size-' + tag.size.toLowerCase() + (tag.certain ? '' : ' size-uncertain') +
			(extraClass ? ' ' + extraClass : '') + '"' + (style ? ' style="' + style + '"' : '') + ' title="' + title + '">' +
			tag.size + (tag.certain ? '' : '?') + '</span>';
	},

	/** Whether a chain row is a synthetic node added by another feature (e.g. route destinations) */
	isSynthetic: function(row, node) {
		const id = String(node.v);
		const html = typeof node.f === 'string' ? node.f : '';
		return !!(row.destination || id.indexOf('dest-') === 0 ||
			html.indexOf('destination-node') >= 0 || html.indexOf("id='dest-") >= 0 || html.indexOf('id="dest-') >= 0 ||
			html.indexOf("id='nodedest-") >= 0 || html.indexOf('id="nodedest-') >= 0);
	},

	/** Decorate the result of chain.nodes() with size tags in place: each tagged child node's cell gets a sizeTag
	property ({ size, certain, jump } from tagFor), which the renderer hooks below draw on the connection to its parent.
	@param result { map: { rows }, lines } from chain.nodes
	@param wormholeTypeFor function(wormholeId) returning the connection's wormhole type (e.g. 'H296'), or undefined */
	decorate: function(result, wormholeTypeFor) {
		if (!result || !result.map || !Array.isArray(result.map.rows)) { return result; }
		const rows = result.map.rows;
		const byId = {};
		rows.forEach(function(row) { if (row && row.c && row.c[0]) { byId[row.c[0].v] = row.c[0]; } });
		const wormholeIdByChild = {};
		(result.lines || []).forEach(function(l) { if (l) { wormholeIdByChild[l[0]] = l[3]; } });

		rows.forEach(function(row) {
			try {
				if (!row || !row.c || !row.c[0] || !row.c[1]) { return; }
				const node = row.c[0], parentID = row.c[1].v;
				delete node.sizeTag;
				if (parentID === null || parentID === undefined) { return; }	// root
				if (typeof node.f !== 'string' || sizeTags.isSynthetic(row, node)) { return; }
				if (!Array.isArray(row.pathHome) || !row.pathHome.length) { return; }
				const child = row.pathHome[row.pathHome.length - 1];
				if (!child || child.path || child.systemID != node.systemID) { return; }	// calculated gate route, or not what we expect
				const parent = byId[parentID];
				if (!parent) { return; }

				const wormholeType = wormholeTypeFor ? wormholeTypeFor(wormholeIdByChild[node.v]) : undefined;
				// One side of a connection is the wormhole's type, the other is K162; the lookup is symmetric
				const otherType = wormholeType && wormholeType != child.type ? wormholeType : 'K162';
				const tag = sizeTags.tagFor(otherType, child.type, parent.systemID, node.systemID);
				if (tag) { node.sizeTag = tag; } else { delete node.sizeTag; }
			} catch (e) {
				if (typeof console !== 'undefined') { console.warn('size-tags: could not tag chain node', e); }
			}
		});
		return result;
	},

	/** Wormhole type for a chain connection id, from Tripwire's wormholes or EVE-Scout links */
	wormholeTypeFor: function(wormholeId) {
		if (wormholeId === undefined || wormholeId === null) { return undefined; }
		if (typeof tripwire !== 'undefined' && tripwire.client && tripwire.client.wormholes && tripwire.client.wormholes[wormholeId]) {
			return tripwire.client.wormholes[wormholeId].type || undefined;
		}
		const id = String(wormholeId);
		if (id.indexOf('ES-') === 0 && typeof eveScout !== 'undefined' && Array.isArray(eveScout.links)) {
			const link = eveScout.links.filter(function(l) { return 'ES-' + l.id == id; })[0];
			return link ? link.wh_type : undefined;
		}
		return undefined;
	},

	// --- Drawing the tag on the connection (all chain renderers) ---

	/** Point on a cubic bezier curve at t (0..1) */
	cubicPoint: function(p0, p1, p2, p3, t) {
		const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
		return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
	},

	/** Trace a connection as a polyline by running a renderer's drawConnection(ctx, node) against a recording
	context, starting at the node's position (as the renderer's own drawing does). Lines and curves are split
	into `steps` pieces so the visible part can be measured. */
	tracePath: function(drawConnection, renderer, node, steps) {
		steps = steps || 24;
		const start = { x: node.position.x, y: node.position.y };
		const points = [start];
		var current = start;
		const add = function(p) { points.push(p); current = p; };
		const recorder = {
			moveTo: function(x, y) { add({ x: x, y: y }); },
			lineTo: function(x, y) {
				const from = current;
				for (var i = 1; i <= steps; i++) { add({ x: from.x + (x - from.x) * i / steps, y: from.y + (y - from.y) * i / steps }); }
			},
			quadraticCurveTo: function(cx, cy, x, y) {
				const from = current, c = { x: cx, y: cy }, to = { x: x, y: y };
				// a quadratic is a cubic with both control points 2/3 of the way to the quadratic's control point
				const c1 = { x: from.x + 2 / 3 * (c.x - from.x), y: from.y + 2 / 3 * (c.y - from.y) };
				const c2 = { x: to.x + 2 / 3 * (c.x - to.x), y: to.y + 2 / 3 * (c.y - to.y) };
				for (var i = 1; i <= steps; i++) { add(sizeTags.cubicPoint(from, c1, c2, to, i / steps)); }
			},
			bezierCurveTo: function(c1x, c1y, c2x, c2y, x, y) {
				const from = current, c1 = { x: c1x, y: c1y }, c2 = { x: c2x, y: c2y }, to = { x: x, y: y };
				for (var i = 1; i <= steps; i++) { add(sizeTags.cubicPoint(from, c1, c2, to, i / steps)); }
			}
		};
		drawConnection.call(renderer, recorder, node);
		return points;
	},

	/** Box covered by a drawn node, which is centred on its position (chainmap-radial.css) */
	nodeRect: function(node) {
		const size = node.requestedSize || { width: 0, height: 0 };
		return { x0: node.position.x - size.width / 2, x1: node.position.x + size.width / 2,
			y0: node.position.y - size.height / 2, y1: node.position.y + size.height / 2 };
	},

	/** The screen rects ({ left, top, right, bottom }) that stick out of box, i.e. a node's badges; empty ones and
	ones inside the box are skipped */
	outsideRects: function(box, rects) {
		return (rects || []).filter(function(r) {
			if (!r || !(r.right > r.left) || !(r.bottom > r.top)) { return false; }
			return r.left < box.left || r.top < box.top || r.right > box.right || r.bottom > box.bottom;
		});
	},

	/** Screen rect -> map coordinates ({ x0, y0, x1, y1 }), given the screen position of the map's origin and the
	screen px per map px (chain zoom, UI scale) */
	toMapRect: function(r, origin, scale) {
		scale = scale > 0 ? scale : 1;
		return { x0: (r.left - origin.left) / scale, y0: (r.top - origin.top) / scale,
			x1: (r.right - origin.left) / scale, y1: (r.bottom - origin.top) / scale };
	},

	/** A drawn node's box, and the boxes of the badges sticking out of it (threat, occupied, statics...),
	in map coordinates, measured from the DOM. null if the node isn't laid out. */
	measureNode: function(node) {
		const el = node.domNode && node.domNode.firstElementChild;
		const container = node.domNode && node.domNode.parentNode;
		if (!el || !container || !el.getBoundingClientRect || !container.getBoundingClientRect) { return null; }
		const box = el.getBoundingClientRect();
		if (!box.width || !el.offsetWidth) { return null; }
		const origin = container.getBoundingClientRect(), scale = box.width / el.offsetWidth;
		const rects = [];
		const children = el.querySelectorAll('*');
		for (var i = 0; i < children.length; i++) {
			const r = children[i].getBoundingClientRect();
			// Hidden placeholders count too: chain.draw shows the activity dots and occupied badge only after the
			// renderer has drawn (and the tags have been placed)
			if (sizeTags.outsideRects(box, [r]).length) { rects.push(r); }
		}
		// The node's text lines (class, name, hole type), measured as text so the empty ends of each line stay free
		const texts = [];
		if (typeof document !== 'undefined' && document.createRange) {
			const lines = el.querySelectorAll('h4');
			for (var j = 0; j < lines.length; j++) {
				const range = document.createRange();
				range.selectNodeContents(lines[j]);
				const t = range.getBoundingClientRect();
				if (t.width && t.height) { texts.push(sizeTags.toMapRect(t, origin, scale)); }
			}
		}
		return { box: sizeTags.toMapRect(box, origin, scale),
			badges: sizeTags.outsideRects(box, rects).map(function(r) { return sizeTags.toMapRect(r, origin, scale); }),
			texts: texts };
	},

	/** Rect grown by margin on each side (marginY for top and bottom, default margin) */
	growRect: function(r, margin, marginY) {
		if (marginY === undefined) { marginY = margin; }
		return { x0: r.x0 - margin, y0: r.y0 - marginY, x1: r.x1 + margin, y1: r.y1 + marginY };
	},

	inRect: function(p, r) { return p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1; },

	/** Halfway point, by length, along the part of a polyline that is not under any of the rects (the nodes at
	its ends), so the tag sits in the middle of the line you can see. Falls back to the middle of the whole line
	when none of it is visible (nodes touching), and returns null for an empty path. With minVisible, returns
	null instead when less than that length of the line is visible. */
	visibleMidpoint: function(points, rects, minVisible) {
		if (!points || !points.length) { return null; }
		if (points.length == 1) { return { x: points[0].x, y: points[0].y }; }
		rects = rects || [];
		const segments = [];
		var visibleLength = 0, totalLength = 0;
		for (var i = 1; i < points.length; i++) {
			const a = points[i - 1], b = points[i];
			const length = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const visible = !rects.some(function(r) { return sizeTags.inRect(mid, r); });
			segments.push({ a: a, b: b, length: length, visible: visible });
			totalLength += length;
			if (visible) { visibleLength += length; }
		}
		if (minVisible && visibleLength < minVisible) { return null; }
		const useAll = visibleLength <= 0;
		var remaining = (useAll ? totalLength : visibleLength) / 2;
		for (var j = 0; j < segments.length; j++) {
			const s = segments[j];
			if (!useAll && !s.visible) { continue; }
			if (remaining <= s.length) {
				const f = s.length ? remaining / s.length : 0;
				return { x: s.a.x + (s.b.x - s.a.x) * f, y: s.a.y + (s.b.y - s.a.y) * f };
			}
			remaining -= s.length;
		}
		const last = points[points.length - 1];
		return { x: last.x, y: last.y };
	},

	/** Area two rects ({ x0, y0, x1, y1 }) have in common */
	overlapArea: function(a, b) {
		const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
		return w > 0 && h > 0 ? w * h : 0;
	},

	/** The point of the path where a tag (TAG_HALF around its centre) covers the least: badges count, the
	nodes' text counts four times as much, a node's empty edge half as much, and the distance from target breaks ties.
	For when there's no free stretch of line (nodes close together or crowded with badges). */
	leastCoveredPoint: function(points, target, boxes, badges, texts) {
		const half = sizeTags.TAG_HALF;
		var best = null, bestCost = Infinity;
		(points || []).forEach(function(p) {
			const tag = { x0: p.x - half.x, y0: p.y - half.y, x1: p.x + half.x, y1: p.y + half.y };
			const sum = function(rects, weight) {
				return (rects || []).reduce(function(acc, r) { return acc + weight * sizeTags.overlapArea(tag, r); }, 0);
			};
			const distance = target ? Math.sqrt((p.x - target.x) * (p.x - target.x) + (p.y - target.y) * (p.y - target.y)) : 0;
			const cost = sum(badges, 1) + sum(texts, 4) + sum(boxes, 0.5) + 0.01 * distance;
			if (cost < bestCost) { bestCost = cost; best = p; }
		});
		return best;
	},

	/** Where to centre a connection's tag on its traced path, given the boxes of the two nodes, of their badges
	and of their text lines (map coordinates): the middle of the stretch of line that is clear of the nodes (by
	NODE_MARGIN) and of their badges (by half a tag), or, if there's too little of that, the point where the tag
	covers the least (leastCoveredPoint). */
	pointOnPath: function(path, boxes, badges, texts) {
		const half = sizeTags.TAG_HALF;
		const grownBadges = (badges || []).map(function(r) { return sizeTags.growRect(r, half.x, half.y); });
		const grownBoxes = boxes.map(function(r) { return sizeTags.growRect(r, sizeTags.NODE_MARGIN); });
		return sizeTags.visibleMidpoint(path, grownBoxes.concat(grownBadges), sizeTags.MIN_VISIBLE) ||
			sizeTags.leastCoveredPoint(path, sizeTags.visibleMidpoint(path, boxes), boxes, badges, texts);
	},

	/** Size tags by chain node id, from a decorated chain map ({ rows }) */
	tagsByNodeId: function(map) {
		const tags = {};
		((map && map.rows) || []).forEach(function(row) {
			if (row && row.c && row.c[0] && row.c[0].sizeTag) { tags[row.c[0].v] = row.c[0].sizeTag; }
		});
		return tags;
	},

	/** Shortest stretch of line between the badges worth centring a tag on, in map px; with less, the tag goes
	between the node borders instead */
	MIN_VISIBLE: 4,
	/** Half a tag's size in map px: how far a tag's centre stays from badges and text */
	TAG_HALF: { x: 10, y: 7 },
	/** Gap kept between a tag's centre and a node's border, in map px (about half a tag's height) */
	NODE_MARGIN: 5,

	/** Canvas renderers (chain-map-renderer-base.js): put a tag on the middle of each drawn connection.
	nodes are the renderer's laid-out nodes (position, requestedSize, parent, domNode).
	The tag goes in the middle of the line between the nodes' badges if there's room, otherwise between the
	nodes' borders. All positions are measured first and the tags added after, so layout is read only once. */
	placeOnDrawnMap: function(renderer, drawConnection, nodes) {
		const tags = sizeTags.tagsByNodeId(renderer.mapData && renderer.mapData.map);
		const measured = [];
		const measure = function(node) {
			if (!node.sizeTagsMeasured) {
				const m = sizeTags.measureNode(node);
				node.sizeTagsMeasured = m || { box: sizeTags.nodeRect(node), badges: [], texts: [] };
				measured.push(node);
			}
			return node.sizeTagsMeasured;
		};
		const placed = [];
		(nodes || []).forEach(function(node) {
			try {
				const tag = tags[node.id];
				if (!tag || !node.parent || !node.parent.position || !node.position) { return; }
				const container = node.domNode && node.domNode.parentNode;
				if (!container || node.domNode.style.display == 'none') { return; }	// child of a collapsed system
				const path = sizeTags.tracePath(drawConnection, renderer, node);
				const child = measure(node), parent = measure(node.parent);
				const point = sizeTags.pointOnPath(path, [child.box, parent.box], child.badges.concat(parent.badges), child.texts.concat(parent.texts));
				if (point) { placed.push({ container: container, tag: tag, point: point }); }
			} catch (e) {
				if (typeof console !== 'undefined') { console.warn('size-tags: could not place tag', e); }
			}
		});
		measured.forEach(function(node) { delete node.sizeTagsMeasured; });
		placed.forEach(function(p) {
			// tagHtml only contains fixed text, the tag's size class and numbers
			p.container.insertAdjacentHTML('beforeend', sizeTags.tagHtml(p.tag, 'size-tag-connector',
				'left: ' + Math.round(p.point.x) + 'px; top: ' + Math.round(p.point.y) + 'px'));
		});
	},

	/** Old org chart (Google OrgChart table): put the tag on the vertical connector cell above each child node,
	the same cell upstream colours for the connection's mass/EOL state (chain-map-renderer-orgchart.js). */
	placeOnOrgChart: function(map) {
		$("#chainMap .size-tag-connector").remove();
		const tags = sizeTags.tagsByNodeId(map);
		Object.keys(tags).forEach(function(id) {
			const $td = $("#chainMap #node" + id).parent();
			if (!$td.length || !$td.is(":visible")) { return; }
			const index = Math.ceil(($td[0].cellIndex + 1) / 2 - 1);
			const cell = $td.parent().prev().children("td.google-visualization-orgchart-lineleft, td.google-visualization-orgchart-lineright")[index];
			if (!cell) { return; }
			const side = $(cell).hasClass("google-visualization-orgchart-lineleft") ? 'size-tag-on-left' : 'size-tag-on-right';
			$(cell).addClass("size-tag-cell").append(sizeTags.tagHtml(tags[id], 'size-tag-connector size-tag-orgchart ' + side));
		});
	},

	/** Hook a chain renderer so tags are drawn after each draw and collapse. Idempotent.
	owner: the chain; while it is drawing, canvas tags wait for its draw to finish (see installRenderers). */
	installRenderer: function(renderer, owner) {
		if (!renderer || renderer.sizeTagsHooked) { return; }
		if (typeof renderer.drawConnection === 'function' && typeof renderer.draw === 'function' && typeof renderer.collapse === 'function') {
			renderer.sizeTagsHooked = true;
			const drawConnection = renderer.drawConnection;
			// The base renderer calls this for every drawn connection (twice with auras): remember the nodes
			renderer.drawConnection = function(ctx, node) {
				drawConnection.apply(this, arguments);
				if (renderer.sizeTagsNodes && renderer.sizeTagsNodes.indexOf(node) < 0) { renderer.sizeTagsNodes.push(node); }
			};
			['draw', 'collapse'].forEach(function(name) {
				const original = renderer[name];
				renderer[name] = function() {
					renderer.sizeTagsNodes = [];
					// placeAgain waits for this (collapse updates the chain's badges before it redraws)
					renderer.sizeTagsBusy = true;
					try { return original.apply(this, arguments); }
					finally {
						renderer.sizeTagsBusy = false;
						const nodes = renderer.sizeTagsNodes;
						renderer.sizeTagsNodes = null;
						renderer.sizeTagsLast = { drawConnection: drawConnection, nodes: nodes };
						if (owner && owner.drawing) { renderer.sizeTagsPending = true; }
						else { sizeTags.placeOnDrawnMap(renderer, drawConnection, nodes); }
					}
				};
			});
		} else if (typeof renderer.collapseHandler === 'function' && typeof renderer.draw === 'function') {
			renderer.sizeTagsHooked = true;
			renderer.sizeTagsOrgChart = true;
			const draw = renderer.draw;
			renderer.draw = function(map) {
				try { return draw.apply(this, arguments); }
				finally { sizeTags.placeOnOrgChart(map); }
			};
		}
	},

	/** Place the tags of the current canvas renderer again, e.g. after badges were added to the drawn nodes
	without a redraw (system-threat's patchChain). The old org chart sits in connector cells and needs nothing. */
	placeAgain: function(chainObj) {
		const r = chainObj && chainObj.renderer;
		if (!r || !r.sizeTagsLast || r.drawing || r.sizeTagsBusy) { return; }
		const containers = [];
		r.sizeTagsLast.nodes.forEach(function(node) {
			const c = node.domNode && node.domNode.parentNode;
			if (c && containers.indexOf(c) < 0) { containers.push(c); }
		});
		containers.forEach(function(c) { $(c).children(".size-tag-connector").remove(); });
		sizeTags.placeOnDrawnMap(r, r.sizeTagsLast.drawConnection, r.sizeTagsLast.nodes);
	},

	/** Hook the chain's renderers: the current one now, others when the user switches, and the old org chart's
	own collapse (Google redraws the table, then reports it through chain.updateCollapsed). */
	installRenderers: function(chainObj) {
		if (!chainObj || chainObj.sizeTagsRenderersHooked || typeof chainObj.useRenderer !== 'function') { return; }
		chainObj.sizeTagsRenderersHooked = true;
		sizeTags.installRenderer(chainObj.renderer, chainObj);
		const useRenderer = chainObj.useRenderer;
		chainObj.useRenderer = function() {
			const result = useRenderer.apply(this, arguments);
			sizeTags.installRenderer(chainObj.renderer, chainObj);
			return result;
		};
		// chain.draw reveals the activity dots, occupied counts etc. only after the renderer has drawn: place the
		// canvas tags once it's done, so they are measured with those badges
		var inDraw = false, badgesChanged = false;
		if (typeof chainObj.draw === 'function') {
			const draw = chainObj.draw;
			chainObj.draw = function() {
				const outer = !inDraw;
				inDraw = true;
				try { return draw.apply(this, arguments); }
				finally {
					if (outer) {
						inDraw = false;
						const changed = badgesChanged;
						badgesChanged = false;
						const r = chainObj.renderer;
						if (r && r.sizeTagsPending) {
							r.sizeTagsPending = false;
							sizeTags.placeOnDrawnMap(r, r.sizeTagsLast.drawConnection, r.sizeTagsLast.nodes);
						} else if (changed) {
							// no map change, only new occupied/activity data (sync.js parses { map: null, occupied })
							sizeTags.placeAgain(chainObj);
						}
					}
				}
			};
		}
		// ...and when they arrive later without a redraw (activity is fetched from ESI)
		['activity', 'occupied'].forEach(function(name) {
			if (typeof chainObj[name] !== 'function') { return; }
			const original = chainObj[name];
			chainObj[name] = function() {
				const result = original.apply(this, arguments);
				if (inDraw) { badgesChanged = true; } else { sizeTags.placeAgain(chainObj); }
				return result;
			};
		});
		if (typeof chainObj.updateCollapsed === 'function') {
			const updateCollapsed = chainObj.updateCollapsed;
			chainObj.updateCollapsed = function() {
				const result = updateCollapsed.apply(this, arguments);
				const r = chainObj.renderer;
				if (r && r.sizeTagsOrgChart && !r.drawing && r.lastLineData) { sizeTags.placeOnOrgChart(r.lastLineData.map); }
				return result;
			};
		}
	},

	legendRow: function() {
		return "<tr><th colspan='4'>Max ship size</th></tr><tr><td colspan='4'>" +
			"<span class='size-tag size-s'>S</span> frig " +
			"<span class='size-tag size-m'>M</span> 62kt " +
			"<span class='size-tag size-l'>L</span> 410kt " +
			"<span class='size-tag size-vl'>VL</span> freighter " +
			"<span class='size-tag size-xl'>XL</span> capital " +
			"<span class='size-tag size-l size-uncertain'>L?</span> guessed" +
			"</td></tr>";
	},

	/** Whether size tags are switched on in the given user options (options.sizeTags.enabled; on unless explicitly false) */
	enabled: function(opts) {
		return !(opts && opts.sizeTags && opts.sizeTags.enabled === false);
	},

	install: function(chainObj) {
		if (!chainObj || typeof chainObj.nodes !== 'function' || chainObj.nodes.sizeTagsWrapped) { return; }
		const previous = chainObj.nodes;
		const wrapped = function() {
			const result = previous.apply(this, arguments);
			if (!sizeTags.enabled(typeof options !== 'undefined' ? options : undefined)) { return result; }
			return sizeTags.decorate(result, sizeTags.wormholeTypeFor);
		};
		wrapped.sizeTagsWrapped = true;
		chainObj.nodes = wrapped;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	if (typeof chain !== "undefined") { sizeTags.install(chain); sizeTags.installRenderers(chain); }
	$(function() {
		if (typeof chain !== "undefined") { sizeTags.install(chain); sizeTags.installRenderers(chain); }
		// Threat badges can arrive after the draw (async fetch): move tags off them
		if (typeof systemThreat !== "undefined" && typeof systemThreat.patchChain === "function" && !systemThreat.patchChain.sizeTagsWrapped) {
			const patchChain = systemThreat.patchChain;
			systemThreat.patchChain = function() {
				const result = patchChain.apply(this, arguments);
				if (typeof chain !== "undefined" && sizeTags.enabled(options)) { sizeTags.placeAgain(chain); }
				return result;
			};
			systemThreat.patchChain.sizeTagsWrapped = true;
		}
		const legend = $("#show-chainLegend");
		const tip = legend.attr("data-tooltip");
		if (tip && tip.indexOf("size-tag") < 0 && tip.indexOf("</table>") >= 0) {
			legend.attr("data-tooltip", tip.replace("</table>", sizeTags.legendRow() + "</table>"));
		}

		// Settings > Map Markers: "Hole size tags". Takes effect on Save (upstream Save then runs options.apply() ->
		// chain.redraw() and options.save()); Close discards it; Reset turns it back on.
		forkSettings.register({
			section: "markers", order: 10, id: "sizeTags-enabled", type: "checkbox", key: "sizeTags",
			label: "Hole size tags:", text: "Show max ship size on connections",
			get: function(o) { return sizeTags.enabled(o); },
			set: function(o, on) { o.sizeTags = { enabled: on }; }
		});
	});
}
