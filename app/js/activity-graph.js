var activity = new function() {
	this.graph;
	this.options;
	this.view;
	this.span = 24;
	this.columns = [
		{id: "time", label: "Time", role: "domain", type: "string", calc: function(d, r) { return d.getValue(r, 0) + "h"; }},
		{id: "jumps", label: "Jumps", role: "data", type: "number", sourceColumn: 1, column: 1, title: "Jumps"},
		{id: "podkills", label: "Pod Kills", role: "data", type: "number", sourceColumn: 2, column: 2, title: "Pod Kills"},
		{id: "shipkills", label: "Ship Kills", role: "data", type: "number", sourceColumn: 3, column: 3, title: "Ship Kills"},
		{id: "npckills", label: "NPC Kills", role: "data", type: "number", sourceColumn: 4, column: 4, title: "NPC Kills"},
		//{id: "annotationLabel", label: "Test", role: "annotation", type: "string", sourceColumn: 5, title: "Test"},
		//{id: "annotationText", label: "Test", role: "annotationText", type: "string", sourceColumn: 6, title: "Test"}
	];

	this.getData = function(span, cache) {
		var span = typeof(span) !== "undefined" ? span : this.span;
		var cache = typeof(cache) !== "undefined" ? cache : true;

		// Google hasn't finished loading yet
		if (!activity.graph) {
				setTimeout(function() {activity.getData(span, cache)}, 500);
				return false;
		}

		// ESI's hourly feed has no wormhole systems; the kill stream stands in.
		if (tripwire.killStream && tripwire.killStream.isWormhole(viewingSystemID)) {
			if (activity.graph) { activity.graph.clearChart(); }
			activity.view = null;
			return false;
		}

		return $.ajax({
			url: "activity_graph.php",
			data: {systemID: viewingSystemID, time: span},
			type: "GET",
			dataType: "JSON",
			cache: cache
		}).done(function(json) {
			if (json) {
				json.rows.reverse();
				activity.view = new google.visualization.DataView(new google.visualization.DataTable(json));
				activity.view.setColumns(activity.columns);
				activity.graph.draw(activity.view, activity.options);
			}
		});
	};

	this.selectHandler = function() {
		var selections = activity.graph.getSelection();

		if (selections[0] && selections[0].row == null) {
			var c = selections[0].column;

			if (activity.columns[c].sourceColumn) {
				//activity.columns[c].calc = function() { return null };
				activity.columns[c].label = activity.columns[c].title + " (off)";
				delete activity.columns[c].sourceColumn;
			} else {
				activity.columns[c].sourceColumn = activity.columns[c].column;
				activity.columns[c].label = activity.columns[c].title;
				//delete activity.columns[c].calc;
			}

			activity.view.setColumns(activity.columns);
			activity.options.animation.duration = 0;
			activity.graph.draw(activity.view, activity.options);
			activity.options.animation.duration = 500;
		}
	}
	
	this.buildOptions = function() {
		return {
			isStacked: false,
			backgroundColor: "transparent",
			hAxis: {textStyle: {color: "#999", fontName: "Verdana", fontSize: 10}, showTextEvery: 3},
			vAxis: {textStyle: {color: "#666", fontName: "Verdana", fontSize: 10}, viewWindowMode: "maximized", viewWindow: {min: 0}, maxValue: 5},
			gridlineColor: "#454545",
			pointSize: 2,
			interpolateNulls: false,
			lineWidth: 1,
			height: 150,
			chartArea: {left: "10%", top: "5%", width: "88%", height: "85%"},
			legend: {position: "in", textStyle: {color: "#CCC", fontName: "Verdana", fontSize: 8.5}},
			animation: {duration: 500, easing: "inAndout"},
			tooltip: {showColorCode: true},
			annotations: {style: "line", textStyle: {fontSize: 12, color: "#ccc"}, domain: 0},
			focusTarget: "category"
		};
	}

	this.init = function() {
		activity.graph = new google.visualization.AreaChart(document.getElementById("activityGraph"));
		activity.options = activity.buildOptions();

		google.visualization.events.addListener(activity.graph, "select", activity.selectHandler);

		activity.getData(activity.span);
	}

	this.time = function(span) {
		switch(span) {
			case 24:
				this.options.hAxis.showTextEvery = 3;
				break;
			case 48:
				this.options.hAxis.showTextEvery = 6;
				break;
			case 168:
				this.options.hAxis.showTextEvery = 24;
				break;
		}

		this.span = span;
		this.getData(span);
	}

	this.redraw = function() {
		this.graph.draw(this.view, this.options);
	}

	// The chart reads its colours from the tokens at build time, so a theme
	// switch rebuilds the options -- keeping the fitted height, chart area
	// and tick spacing -- and redraws in place.
	this.retheme = function() {
		if (!this.graph || !this.options) return;
		var keep = {height: this.options.height, chartArea: this.options.chartArea, every: this.options.hAxis.showTextEvery};
		this.options = this.buildOptions();
		this.options.height = keep.height;
		this.options.chartArea = keep.chartArea;
		this.options.legend = {position: "none"};
		this.options.hAxis.showTextEvery = keep.every;
		this.renderLegend();
		if (this.view) this.redraw();
	}

	this.refresh = function(cache) {
		this.getData(this.span, cache);
	}

	google.charts.setOnLoadCallback(this.init);
}
