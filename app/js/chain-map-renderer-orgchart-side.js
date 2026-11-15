const ChainMapRendererOrgchartSide = function(owner) {
	ChainMapRendererBase.apply(this, arguments);
	
	// Sized per draw from the cards: a column is the widest card plus room
	// for the connectors, a row the tallest card plus a gap (see the top renderer).
	const GAP = { x: 18, y: 12 };
	const GRID_SIZE = { x: 70, y: 45 };
	
	this.initialRads = function(minArc) { return minArc * 0.5; }
	this.centringOptions = { y: true };
	
	this.prepareLayout = function(nodes) {
		const size = this.representativeNodeSize();
		GRID_SIZE.x = Math.max(size.width + GAP.x, GRID_SIZE.x);
		GRID_SIZE.y = Math.max(size.height + GAP.y, GRID_SIZE.y);
	}
	
	function project(rad, ci) { return {
		x: ci * GRID_SIZE.x * options.chain.nodeSpacing.x,
		y: rad * GRID_SIZE.y * options.chain.nodeSpacing.y	
	}; }
	
	this.setPosition = function(node, ci, rad_centre) {
		node.position = project(rad_centre, ci);
	}
	
	this.calcMinArc = function(node) {
		const arcFromSize = (node.requestedSize.height + GAP.y) / (1.0 * GRID_SIZE.y * options.chain.nodeSpacing.y);
		return Math.max(arcFromSize, 1);
	}
	
	this.drawConnection = function(ctx, node) {
		const ave_x = 0.5 * (node.position.x + node.parent.position.x);
		const cp1 = { x: node.parent.position.x, y: node.position.y };
		const cp2 = { x: node.parent.position.x, y: node.position.y };
		
		ctx.bezierCurveTo(cp2.x, cp2.y, cp1.x, cp1.y, node.parent.position.x, node.parent.position.y);
	}
	
	this.drawGridlines = function(ctx, ci, radRange) {
		ctx.beginPath();
		const start = project(radRange.min, ci), end = project(radRange.max, ci);
		ctx.moveTo(start.x, start.y);
		ctx.lineTo(end.x, end.y);
		
		ctx.strokeStyle = propertyFromCssClass('grid-default', 'color');
		ctx.stroke();		
		
		ctx.fillStyle = propertyFromCssClass('grid-default', 'color');
		ctx.font = '10px Sans-serif';
		ctx.fillText(ci, start.x + 5, start.y);
	}		
};

ChainMapRendererOrgchartSide.prototype = new ChainMapRendererBase();