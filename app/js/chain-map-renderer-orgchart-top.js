const ChainMapRendererOrgchartTop = function(owner) {
	ChainMapRendererBase.apply(this, arguments);
	
	const GAP = { x: 12, y: 18 };
	const GRID_SIZE = { x: 55, y: 45 };
	
	this.initialRads = function(minArc) { return minArc * 0.5; }
	this.centringOptions = { x: true };
	
	this.prepareLayout = function(nodes) {
		const size = this.representativeNodeSize();
		GRID_SIZE.x = Math.max(size.width + GAP.x, GRID_SIZE.x);
		GRID_SIZE.y = Math.max(size.height + GAP.y, GRID_SIZE.y);
	}
	
	function project(rad, ci) { return {
		x: rad * GRID_SIZE.x * options.chain.nodeSpacing.x,
		y: ci * GRID_SIZE.y * options.chain.nodeSpacing.y
	}; }
	
	this.setPosition = function(node, ci, rad_centre) {
		node.position = project(rad_centre, ci);
		node.rad_centre = rad_centre;
	}
	
	this.calcMinArc = function(node) {
		// A card never gets less than its own width plus the gap, whatever the spacing setting
		const arcFromSize = (node.requestedSize.width + GAP.x) / (1.0 * GRID_SIZE.x * options.chain.nodeSpacing.x);
		return Math.max(arcFromSize, 1);
	}
	
	this.drawConnection = function(ctx, node) {
		const endpoint_y = node.parent.position.y; // + 10 * (3 - Math.abs(node.rad_centre - node.parent.rad_centre));
		const ave_y = 0.5 * (node.position.y + endpoint_y);
		const cp1 = { x: node.position.x, y: endpoint_y };
		const cp2 = { x: node.position.x, y: endpoint_y };
		
		ctx.bezierCurveTo(cp2.x, cp2.y, cp1.x, cp1.y, node.parent.position.x, endpoint_y);
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
		ctx.fillText(ci, start.x, start.y + 12);
	}		
};

ChainMapRendererOrgchartTop.prototype = new ChainMapRendererBase();