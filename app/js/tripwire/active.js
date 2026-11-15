tripwire.active = function(data) {
    var editSigs = [];
    var editComments = [];

    for (var x in data) {
        var activity = JSON.parse(data[x].activity);
        editSigs.push(parseInt(activity.editSig));
        editComments.push(parseInt(activity.editComment));

        if (activity.editSig) {
            var $row = $("#sigTable tr[data-id='"+activity.editSig+"']");

            // Only animate when the row is newly marked. This runs on every
            // refresh, so animating unconditionally queued one more 1s
            // animation per poll for as long as somebody kept the signature
            // open -- and the queue only drains while the tab is visible.
            if (!$row.hasClass("editing")) {
                $row.addClass("editing");
                if (!document.hidden) {
                    $row.find("td").stop(true, true)
                        .animate({backgroundColor: "#001b47"}, 1000); //35240A - Yellow
                }
            }
        }

        if (activity.editComment && $("#commentWrapper .comment[data-id='"+activity.editComment+"'] .cke").length > 0) {
            $("#commentWrapper .comment[data-id='"+activity.editComment+"']")
                .addClass("editing")
                .find(".commentStatus").text(data[x].characterName + " is editing").fadeIn();
        }
    }

    $("#sigTable tr.editing").each(function() {
        if ($.inArray($(this).data("id"), editSigs) == -1) {
            $("#sigTable tr[data-id='"+$(this).data("id")+"']")
                //.attr('data-tooltip', '')
                //.removeAttr("title")
                .removeClass("editing")
                .find("td")
                .stop(true, true)
                .animate({backgroundColor: "#111"}, document.hidden ? 0 : 1000, null, function() {$(this).css({backgroundColor: ""});});
        }
    });

    $("#commentWrapper .editing").each(function() {
        if ($.inArray($(this).data("id"), editComments) == -1) {
            $("#commentWrapper .editing[data-id='"+$(this).data("id")+"']")
                .removeClass("editing")
                .find(".commentStatus").fadeOut(function() {$(this).text("")});
        }
    });
}
