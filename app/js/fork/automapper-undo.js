// Automapper undo bookkeeping (pure, used by app/js/tripwire/automapper.js).
const automapperUndo = {
	/** Which system's undo stack an automapper change belongs to: the one being viewed when it is one of the two
		systems of the jump, otherwise the system jumped into (where the follower takes the view). It used to be
		whatever system was viewed, so an automap while looking elsewhere put the undo on the wrong system. */
	system: function(viewingSystemID, from, to) {
		return viewingSystemID == from || viewingSystemID == to ? viewingSystemID : to;
	}
};
