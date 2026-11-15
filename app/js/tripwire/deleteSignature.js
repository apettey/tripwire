// Handles removing from Signatures section
tripwire.deleteSig = function(key) {
    var tr = $("#sigTable tr[data-id='"+key+"']");

    //Append empty space to prevent non-coloring
    $(tr).find('td:empty, a:empty').append("&nbsp;");

    // The row is only actually removed by the animation's completion callback,
    // and jQuery animates off requestAnimationFrame, which browsers suspend for
    // hidden tabs. Animating here would leave deleted signatures on screen for
    // as long as the tab stays in the background.
    var removeRow = function() {
        $(tr).find('span[data-age]').countdown("destroy");
        $(tr).remove();
        $("#sigTable").trigger("update");
    };

    if (document.hidden) {
        removeRow();
        return;
    }

    $(tr)
        .find('td')
        .wrapInner('<div />')
        .parent()
        .find('td > div').animate({backgroundColor: "#4D0000"}, 1000).delay(1000).animate({backgroundColor: "#111"}, 1000)
        .slideUp(700, removeRow);
}
