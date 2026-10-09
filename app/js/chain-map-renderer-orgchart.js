const ChainMapRendererOrgchart = function(owner) {
	const _this = this;
	
	/** Initialiser - callback from chart onload */
	this.init = function() {
		_this.map = new google.visualization.OrgChart(document.getElementById("chainMap"));
		_this.options = {allowHtml: true, allowCollapse: true, size: "medium", nodeClass: "node"};

		google.visualization.events.addListener(_this.map, "collapse", _this.collapseHandler);

		_this.map.draw(new google.visualization.DataView(new google.visualization.DataTable({cols:[{label: "System", type: "string"}, {label: "Parent", type: "string"}]})), _this.options);
	}
	
	/** Is this renderer ready to accept draw calls? */
	this.ready = function() { return !this.drawing && !!this.map; }
	
	/** Switch to this renderer. The renderer can be in a blank state; draw() will be called after */
	this.switchTo = function() {
		document.getElementById('chainGrid').style.display = '';
		if(!_this.map) { google.charts.setOnLoadCallback(this.init); }
	}
	
	/** Switch away from this renderer. All node divs should be removed from the DOM */
	this.switchFrom = function() {
		document.getElementById('chainGrid').style.display = 'none';
		_this.map.draw(new google.visualization.DataView(new google.visualization.DataTable({cols:[{label: "System", type: "string"}, {label: "Parent", type: "string"}]})), _this.options);		
	}
	
	/** Redraw the map, based on the given node set, line overrides and list of collapsed systems */
	this.draw = function(map, lines, collapsed) {
		this.drawing = true;
		this.map.draw(newView(map), this.options); 
		
		for (var x in collapsed) {
			const s = collapsed[x];
			const nodeId = $("#chainMap [data-nodeid='"+s+"']").attr("id");
			if (nodeId) {
				const nodeVal = nodeId.split("node")[1];
				this.map.collapse(nodeVal - 1, true);
			}
		}
		
		updateLines(map, lines);
		this.drawing = false;
	};
	
	const newView = function(json) {
		const view = new google.visualization.DataView(new google.visualization.DataTable(json));
		return view;
	};
	
	const updateLines = function(map, lines) {
		_this.lastLineData = { map: map, lines: lines };
		function drawNodeLine(system, parent, mode, signatureID) {
			/*	function for drawing colored lines  */
			if(typeof mode == 'string') { mode = [mode]; }

			function addModes(jquerySelector, prefixes) { return doModeClasses(jquerySelector, prefixes, function(s, c) { s.addClass(c); }); }
			function removeModes(jquerySelector, prefixes) { return doModeClasses(jquerySelector, prefixes, function(s, c) { s.removeClass(c); }); }
			function doModeClasses(jquerySelector, prefixes, classFunc) {
				prefixes = prefixes || [];
				prefixes.push('');
				prefixes.forEach(function(prefix) { 
					mode.forEach( function(mode) { classFunc(jquerySelector, (prefix.length ? prefix + '-' : '') + mode); });
				});
				return jquerySelector;
			}

			// Find node in chainmap
			//var $node = $("#chainMap [data-nodeid='"+system+"']").parent();
			var $node = $("#chainMap #node"+system).parent();

			if ($node.length == 0) {
				return false;
			}

			// Get node # in this line
			var nodeIndex = Math.ceil(($node[0].cellIndex + 1) / 2 - 1);

			// applly to my top line
			var $connector = addModes($($node.parent().prev().children("td.google-visualization-orgchart-lineleft, td.google-visualization-orgchart-lineright")[nodeIndex]), [ 'left', 'right' ]);

			// Find parent node
			//var $parent = $("#chainMap [data-nodeid='"+parent+"']").parent();
			var $parent = $("#chainMap #node"+parent).parent();

			if ($parent.length == 0 || $connector.length == 0)
				return false;

			// Find the col of my top line
			var nodeCol = 0, connectorCell = $connector[0].cellIndex;
			$node.parent().prev().find("td").each(function(index) {
				nodeCol += this.colSpan;

				if (index == connectorCell) {
					return false;
				}
			});

			// Get node # in this line
			var parentIndex = Math.ceil(($parent[0].cellIndex + 1) / 2 - 1);

			// Compensate for non-parent nodes (slight performance hit ~10ms)
			var newparentIndex = parentIndex;
			for (var i = 0; i <= parentIndex; i++) {
				var checkSystem = 0;//$node.parent().prev().prev().prev().find("td:has([data-nodeid]):eq("+i+")").find("[data-nodeid]").data("nodeid");
				$node.parent().prev().prev().prev().find("td > [data-nodeid]").each(function(index) {
					if (index == i) {
						checkSystem = $(this).attr("id").replace("node", "");//$(this).data("nodeid");

						return false;
					}
				});

				if ($.map(map.rows, function(node) { return node.c[1].v == checkSystem ? node : null; }).length <= 0) {
					newparentIndex--;
				}
			}
			parentIndex = newparentIndex;

			// Apply to parent bottom line
			var $connecte = addModes($($node.parent().prev().prev().children("td.google-visualization-orgchart-lineleft, td.google-visualization-orgchart-lineright")[parentIndex]), [ 'left', 'right'] );

			// the beans
			var col = 0, parent = false, me = false;
			$node.parent().prev().prev().find("td").each(function(index, value) {
				col += this.colSpan;

				if (me && parent) {
					// All done - get outta here
					return false;
				} else if (typeof($connecte[0]) != "undefined" && $connecte[0].cellIndex == index) {
					parent = true;

					addModes($(this), ['left']);

					// remove bottom border that points to the right
					if (!me && col != nodeCol) {
						addModes($(this), ['bottom']);
					}

					// parent and node are same - we are done
					if (nodeCol == col) {
						return false;
					}
				} else if (col == nodeCol) {
					me = true;

					addModes($(this), [ 'bottom' ]);
				} else if (me || parent) {
					var tempCol = 0, breaker = false, skip = false;

					$node.parent().prev().find("td").each(function(index) {
						tempCol += this.colSpan;

						if (tempCol == col && ($(this).hasClass("google-visualization-orgchart-lineleft") || $(this).hasClass("google-visualization-orgchart-lineright"))) {
							if (parent == false) {
								// Stop looking cuz there is another node between us and parent
								breaker = true;
								removeModes($connecte, [ 'left', 'right' ]);
								return false;
							} else if (parent == true) {
								// Lets make sure there isnt a node between the parent and me
								removeModes($connecte, [ 'left', 'right' ]);

								$node.parent().prev().prev().find("td").each(function(index) {
									if (index >= $connecte[0].cellIndex) {
										// there is a node after parent but before me
										removeModes($(this), [ 'bottom' ]);
									}
								});
								skip = true;
							}
						}
					});

					if (breaker) {
						return false;
					}

					if (!skip) {
						addModes($(this), ['bottom'] );
					}
				}
			});
		}

		for (var x in lines) {
			drawNodeLine(lines[x][0], lines[x][1], lines[x][2].concat(['connection']), lines[x][3]);
		}
	};

	this.collapseHandler = function() {		
		if(_this.drawing) { return; }
		
		const collapsed = _this.map.getCollapsedNodes();
		const collapsedSystems = [];
		for (x in collapsed) {
			var systemID = $("#chainMap #node"+(collapsed[x] +1)).data("nodeid");
			collapsedSystems.push(systemID);
		}
		owner.updateCollapsed(collapsedSystems);
		
		if(_this.lastLineData) { updateLines(_this.lastLineData.map, _this.lastLineData.lines); }
	}


};