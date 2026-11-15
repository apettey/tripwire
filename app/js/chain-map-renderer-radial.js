const ChainMapRendererRadial = function(owner) {
	ChainMapRendererBase.apply(this, arguments);
	
	// The rings are sized per draw from the cards: one ring step is the
	// widest card plus a gap across, and the taller of the tallest card plus
	// the gap or 62% of that down, so the rings are ellipses in the cards'
	// own proportions. Upstream's fixed 70x60 fitted its 30px pills only.
	const GAP = 12, MIN_Y_RATIO = 0.62;
	const CIRCLE_SIZE = { x: 70, y: 60, first_ring_delta: 0.3,
		ringX: function(ci) { return ci == 0 ? 0 : (ci + this.first_ring_delta) * this.x * options.chain.nodeSpacing.x},
		ringY: function(ci) { return ci == 0 ? 0 : (ci + this.first_ring_delta) * this.y * options.chain.nodeSpacing.y},
	 };
	
	this.prepareLayout = function(nodes) {
		const size = this.representativeNodeSize();
		CIRCLE_SIZE.x = Math.max(CIRCLE_SIZE.x, size.width + GAP);
		CIRCLE_SIZE.y = Math.max(CIRCLE_SIZE.y, size.height + GAP, MIN_Y_RATIO * CIRCLE_SIZE.x);
	}
	
	this.arcFactor = function(ci) { return ci / (ci + 1.0); }
	
	this.skipLevels = function(ci, nodes, minRad, maxRad, parentCollapsed) { 
		if(nodes.length < 2) { return 0; } // if there's only 1, no point skipping, even if the space is small
		// Cards fit side by side along a ring at one per ring step of arc
		// length, so a ring holds (its radius in ring steps) cards per radian
		const max_nodes_per_rad = ci + CIRCLE_SIZE.first_ring_delta;
		let skipped = 0;
		if(ci > 0 && !parentCollapsed) {
			while(nodes.length > max_nodes_per_rad * (maxRad - minRad) && ++skipped < 1) { }
		}
		return skipped; 
	}
	
	this.setPosition = function(node, ci, rad_centre) {
		node.radPosition = { r: ci, theta: rad_centre };
		node.position = radToCartesian(node.radPosition);		
	}
	
	this.drawConnection = function(ctx, node) {
		const cp1 = radToCartesian({ r: node.radPosition.r - 0.5, theta: (node.radPosition.theta + 2 * node.parent.radPosition.theta) / 3.0 });
		const cp2 = radToCartesian({ r: node.radPosition.r - 0.5, theta: (2 * node.radPosition.theta + node.parent.radPosition.theta) / 3.0 });
		
		if(node.circle > 1) {				
			ctx.bezierCurveTo(cp2.x, cp2.y, cp1.x, cp1.y, node.parent.position.x, node.parent.position.y);
		} else {
			ctx.lineTo(node.parent.position.x, node.parent.position.y);			
		}
	}
	
	this.adjustAlignmentDelta = function(ci, rad_centre) {
		return ci == 1 ? -rad_centre	// First node on first ring should be axis aligned
		: 0;
	}
	
	this.drawGridlines = function(ctx, ci) {
		ctx.beginPath();
		if(ctx.ellipse) {
			ctx.lineWidth = 0.5;
			ctx.setLineDash([]);
			ctx.ellipse(0, 0, CIRCLE_SIZE.ringX(ci), CIRCLE_SIZE.ringY(ci), 0, 0, Math.PI * 2);
		}
		ctx.strokeStyle = propertyFromCssClass('grid-default', 'color');
		ctx.stroke();		
	}		
	
	function radToCartesian(rad) {
		return { 
			x: CIRCLE_SIZE.ringX(rad.r) * Math.sin(rad.theta), 
			y: CIRCLE_SIZE.ringY(rad.r) * Math.cos(rad.theta)
		};

	}
};

ChainMapRendererRadial.prototype = new ChainMapRendererBase();