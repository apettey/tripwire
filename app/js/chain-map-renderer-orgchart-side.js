const ChainMapRendererOrgchartSide = function(owner) {
	ChainMapRendererBase.apply(this, arguments);
	
	const GRID_SIZE = { x: 70, y: 45 };
	
	this.initialRads = function(minArc) { return minArc * 0.5; }
	this.centringOptions = { y: true };
	
	function project(rad, ci) { return {
		x: ((ci == 0 ? -0.3 : 0) + ci) * GRID_SIZE.x * options.chain.nodeSpacing.x,	// root is larger so give some extra space
		y: rad * GRID_SIZE.y * options.chain.nodeSpacing.y	
	}; }
	
	this.setPosition = function(node, ci, rad_centre) {
		node.position = project(rad_centre, ci);
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