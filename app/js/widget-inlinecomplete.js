// Custom inlinecomplete + dropdown input
$.widget("custom.inlinecomplete", $.ui.autocomplete, {
	_create: function() {
		this.options.source = this._coerceSource(this.options.source);
		
		if (!this.element.is("input")) {
			this._selectInit();
		}

		// Invoke the parent function
		return this._super();
	},
	_value: function() {
		// Invoke the parent function
		var originalReturn = this._superApply(arguments);

		this.element.change();

		return originalReturn;
	},
	_suggest: function(items) {
		// if (this.element.val() != items[0].value) {
			// this.element.val(items[0].value.substr(0, this.element.val().length));
		// }

		// Invoke the parent function
		return this._super(items);
	},
	_coerceSource: function(source) {
		// Allow an object source like tripwire.systems - coerce it to an array
		return $.isArray(source) ? source :
			Object.keys(source).map(function(k) { return Object.assign({ key: k }, source[k]); }.bind(this) );
	},
	_initSource: function() {
		this.source = function(request, response) {
			var matcher = new RegExp("^" + $.ui.autocomplete.escapeRegex(request.term), "i");
			var results = new Array(); // results array
			const dataSource = this.options.source;
			var maxSize = this.options.maxSize || 25; // maximum result size
			// simple loop for the options
			const extraMatchFunction = typeof this.options.extraMatch === 'function' ? this.options.extraMatch : function(x) { return false; }
			for (var i = 0, l = dataSource.length; i < l; i++) {
				const value = dataSource[i];
				const target = value.name || value.key || value;
				if (matcher.test(target) || extraMatchFunction(request.term, value)) {
					results.push( { value: target, label: target, content: typeof value === 'object' ? value : undefined });

					if (maxSize && request.term !== '' && results.length > maxSize) {
						break;
					}
				}
			}
			 // send response
			 response(results);
		}
	},	
	_renderItem: function( ul, item ) {
		if(item.content && this.options.renderer) {
			const renderFunction = typeof this.options.renderer === 'function' ? this.options.renderer : renderers[this.options.renderer];
			const renderResult = renderFunction(item.content);
			return $( "<li>" )
			.html( '<span>' + renderResult + '</span>')
			.appendTo( ul );
		} else return this._super(ul, item);
	},
	_close: function(event) {
		this.options.source = this.options.input_source ? this.options.input_source : this.options.source;

		// Invoke the parent function
		return this._super(event);
	},
	addToSelect: function(value) {
		this.options.select_added_value = value;
		this.options.select_source.unshift(value);
	},
	removeFromSelect: function(value) {
		if (value) {
			this.options.select_source.splice(value, 1);
		} else if (this.options.select_added_value) {
			this.options.select_source.splice(this.options.select_added_value, 1);
		}
		this.options.select_added_value = null;
	},
	_selectInit: function() {
		this.element.addClass("custom-combobox");
		this.wrapper = this.element;
		this.element = this.wrapper.find("input:first") || this.element;
		this.select = this.wrapper.find("select:first").remove();

		this.options.input_source = this.options.source;
		const selectItemMapper = this.options.select_item_mapper || function(x) { return x; };
		this.options.select_source = selectItemMapper(this.select.children("option[value!='']").map(function() { return $.trim(this.text); }).toArray());

		this._createShowAllButton();
	},
	_createShowAllButton: function() {
        var that = this,
          wasOpen = false;

        $("<a>")
			.attr("tabIndex", that.element.prop("tabindex"))
			.attr("title", "")
			.appendTo(that.wrapper)
			.button({icons: {primary: "ui-icon-triangle-1-s"}, text: false})
			.removeClass("ui-corner-all")
			.addClass("custom-combobox-toggle ui-corner-right")
			.on("mousedown", function() {
				wasOpen = that.widget().is(":visible");
			})
			.on("click", function() {
				that.element.trigger("focus");

				// Close if already visible
				if (wasOpen) {
				  return;
				}

				// Pass empty string as value to search for, displaying all results
				if(that.options.customDropdown) {
					that.options.select_source = that._coerceSource(that.options.customDropdown())
				}
				that.options.source = that.options.select_source;
				that._search("");
			});
	},
});

const renderers =  {
	system: function(system) {
		return systemRendering.renderSystem(systemAnalysis.analyse(undefined, system), 'span');
	},
	wormholeType: wormholeRendering.renderWormholeType
};
