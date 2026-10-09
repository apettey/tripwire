// Firefox (and some other browsers) don't support 'zoom' CSS
// This snippet hooks up a variant using transform(scale) to JQuery
// See e.g. https://medium.com/@sai_prasanna/simulating-css-zoom-with-css3-transform-scale-461d1b9762d6
if (document.createElement("detect").style.zoom != ""){
	$.cssNumber.zoom = true;
    $.cssHooks.zoom = {
        get: function(elem, computed, extra) {
            var value = $(elem).data('zoom');
            return value != null ? value : 1;
        },
        set: function(elem, scale) {
            var $e = $(elem);
            var e = $e[0];
            var data = $e.data('zoom');
            if (data == null) {
                $e.data('origWidth', e.clientWidth);
                $e.data('origHeight', e.clientHeight);
            }
            $e.data('zoom', scale);
            const width = $e.data('origWidth');
            const height = $e.data('origHeight');
            e.style.transform = 'scale(' + scale + ')';
            e.style.transformOrigin = '0 0';
            const bot = (height/scale - height);
            const right = (width/scale - width);
            e.style.marginBottom = (-bot) + 'px';
            e.style.marginRight = (-right) + 'px';
        }
    };
}