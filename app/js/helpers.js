Object.sort = function(obj, prop) {
	var swapped, prev;
	do {
		swapped = false, prev = null;
		for (var i in obj) {
			if (prev && Number(obj[i][prop]) < Number(obj[prev][prop])) {
				var tmp = obj[i];
				obj[i] = obj[prev];
				obj[prev] = tmp;
				swapped = true;
			}
			prev = i;
		}
	} while (swapped);
}

Object.index = function(obj, prop, val, cs) {
	for (var key in obj) {
		if (!cs && obj[key][prop] == val) {
			return key;
		} else if (obj[key][prop] && obj[key][prop].toLowerCase() == val.toLowerCase()) {
			return key;
		}
	}
}

Object.find = function(obj, prop, val, cs) {
	for (var key in obj) {
		if (!cs && obj[key][prop] == val) {
			return obj[key];
		} else if (obj[key][prop] && obj[key][prop].toLowerCase && obj[key][prop].toLowerCase() == val.toLowerCase()) {
			return obj[key];
		}
	}

	return false;
};

(function($){
    $.fn.serializeObject = function(){

        var self = this,
            json = {},
            push_counters = {},
            patterns = {
                "validate": /^[a-zA-Z][a-zA-Z0-9_]*(?:\[(?:\d*|[a-zA-Z0-9_]+)\])*$/,
                "key":      /[a-zA-Z0-9_]+|(?=\[\])/g,
                "push":     /^$/,
                "fixed":    /^\d+$/,
                "named":    /^[a-zA-Z0-9_]+$/
            };


        this.build = function(base, key, value){
            base[key] = value;
            return base;
        };

        this.push_counter = function(key){
            if(push_counters[key] === undefined){
                push_counters[key] = 0;
            }
            return push_counters[key]++;
        };

        $.each($(this).serializeArray(), function(){

            // skip invalid keys
            if(!patterns.validate.test(this.name)){
                return;
            }

            var k,
                keys = this.name.match(patterns.key),
                merge = this.value,
                reverse_key = this.name;

            while((k = keys.pop()) !== undefined){

                // adjust reverse_key
                reverse_key = reverse_key.replace(new RegExp("\\[" + k + "\\]$"), '');

                // push
                if(k.match(patterns.push)){
                    merge = self.build([], self.push_counter(reverse_key), merge);
                }

                // fixed
                else if(k.match(patterns.fixed)){
                    merge = self.build([], k, merge);
                }

                // named
                else if(k.match(patterns.named)){
                    merge = self.build({}, k, merge);
                }
            }

            json = $.extend(true, json, merge);
        });

        return json;
    };
})(jQuery);

var letterToNumbers = function(string) {
    string = string.toUpperCase();
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', sum = 0, i;
    for (i = 0; i < string.length; i++) {
        sum += Math.pow(letters.length, i) * (letters.indexOf(string.substr(((i + 1) * -1), 1)) + 1);
    }
    return sum;
};

/** Find the relative position of one element within the hierarchy tree of another.
The client position should be in the coordinate space of the ancestor, i.e. top/left values for a position:absolute overlay */
function positionRelativeTo(elem, ancestor) {
	const elemPos = elem.getBoundingClientRect(),
		ancestorPos = ancestor.getBoundingClientRect(),
		ancestorZoom = 1 * (window.getComputedStyle(ancestor).getPropertyValue('zoom') || '1');
	return { 
		left: ((elemPos.left - ancestorPos.left) / ancestorZoom) + ancestor.scrollLeft,
		top: ((elemPos.top - ancestorPos.top) / ancestorZoom) + ancestor.scrollTop
	};
}

/** Look up one or more values in a comma separated string as keys in a data map, and return a property from the results in a new comma separated string.
Convenience function for UI mapping.
Will throw a failure message, unless suppress=true in which case it will return undefined, if 
any of the lookups fail to resolve. */
function lookupMultiple(map, propertyName, lookupString, suppress) {
	const values = lookupString.split(',');
	const results = [];
	for(var i = 0; i < values.length; i++) {
		const v = values[i];
		const r = map[v];
		if(!r) { 
			if(suppress) { return undefined;}
			else { throw 'Value ' + v + ' did not match anything in ' + map; }
		}
		results.push(r[propertyName]);
	}
	return results.join(',');
}

// Global CSS class change event
(function($) {
    var originalAddClassMethod = $.fn.addClass;
	var originalRemoveClassMethod = $.fn.removeClass;

    $.fn.addClass = function(className) {
        // Execute the original method.
        var result = originalAddClassMethod.apply(this, arguments);

        // trigger a custom event
        this.trigger('classchange', className);

        // return the original result
        return result;
    }

	$.fn.removeClass = function(className) {
        // Execute the original method.
        var result = originalRemoveClassMethod.apply(this, arguments);

        // trigger a custom event
        this.trigger('classchange', className);

        // return the original result
        return result;
    }
})(jQuery);

