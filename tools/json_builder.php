<?php

/**
 ToDo:
	- Button to create womrhole effects JSON file & include in combine.json
	- Button to create pirates JSON file & include in combine.json
	- Create a way to crawl for statics and include run from here
**/

session_start();

if(!isset($_SESSION['super']) || $_SESSION['super'] != 1) {
	echo 'Security Failure!';
	exit();
}

require_once('../config.php');
require_once('../db.inc.php');

if(isset($_REQUEST['map'])) {
	$shortest = array();
	$maps = array('shortest' => $shortest);

	// Systems
	$query = 'SELECT j.fromSolarSystemID, j.toSolarSystemID FROM '. EVE_DUMP .'.mapSolarSystemJumps j';
	$stmt = $mysql->prepare($query);
	$stmt->execute();
	while ($row = $stmt->fetchObject()) {	
		$id = '' . ($row->fromSolarSystemID - 30000000);
		if(!isset($shortest[$id])) {
			$shortest[$id] = array();
		}
		$shortest[$id][$row->toSolarSystemID - 30000000] = 0;
	}

	if ($file = fopen(dirname(__FILE__).'/map.json', 'w')) {
		fwrite($file, json_encode(array('shortest' => $shortest), JSON_PRETTY_PRINT));
		fclose($file);
	}
}

if(isset($_REQUEST['mass'])) {
	$query = 'SELECT t.typeID, t.typeName, t.mass FROM '. EVE_DUMP .'.invtypes t inner join '. EVE_DUMP .'.invgroups g on g.groupID=t.groupID inner join '. EVE_DUMP .'.invcategories c on c.categoryID=g.categoryID where c.categoryID=6';
	$stmt = $mysql->prepare($query);
	$stmt->execute();

	$mass = $stmt->fetchAll(PDO::FETCH_UNIQUE | PDO::FETCH_ASSOC);
	if ($file = fopen(dirname(__FILE__).'/mass.json', 'w')) {
		fwrite($file, json_encode($mass, JSON_PRETTY_PRINT));
		fclose($file);
	}
}

if (isset($_REQUEST['combine'])) {
	$output = null;

	if ($file = fopen(dirname(dirname(__FILE__)).'/public/js/combine.js', 'w')) {
		// Statics
		$statics = json_decode(file_get_contents(dirname(__FILE__).'/statics.json'), true);

		// Systems
		$query = 'SELECT s.solarSystemID, s.solarSystemName, s.security, s.constellationID, s.regionID, s.factionID, wormholeClassID, typeName FROM '. EVE_DUMP .'.mapSolarSystems s LEFT JOIN '. EVE_DUMP .'.mapLocationWormholeClasses ON regionID = locationID OR s.solarSystemID = locationID LEFT JOIN '. EVE_DUMP .'.mapDenormalize d ON d.solarSystemID = s.solarSystemID AND d.groupID = 995 LEFT JOIN '. EVE_DUMP .'.invTypes t ON t.typeID = d.typeID';
		$stmt = $mysql->prepare($query);
		$stmt->execute();
		while ($row = $stmt->fetchObject()) {
			$output['systems'][$row->solarSystemID]['name'] = $row->solarSystemName;
			$output['systems'][$row->solarSystemID]['security'] = $row->security;
			$output['systems'][$row->solarSystemID]['constellationID'] = $row->constellationID;
			$output['systems'][$row->solarSystemID]['regionID'] = $row->regionID;
			if ($row->factionID) $output['systems'][$row->solarSystemID]['factionID'] = $row->factionID;
			if ((int)$row->regionID > 11000000) $output['systems'][$row->solarSystemID]['class'] = $row->wormholeClassID;
			if ((int)$row->regionID > 11000000 && $row->typeName) $output['systems'][$row->solarSystemID]['effect'] = $row->typeName;
			if ((int)$row->regionID > 11000000 && isset($statics[$row->solarSystemName])) $output['systems'][$row->solarSystemID]['statics'] = $statics[$row->solarSystemName];
		}

		// Regions
		$query = 'SELECT regionID, regionName FROM '. EVE_DUMP .'.mapRegions';
		$stmt = $mysql->prepare($query);
		$stmt->execute();
		while ($row = $stmt->fetchObject()) {
			$output['regions'][$row->regionID]['name'] = $row->regionName;
		}

		// Factions
		$query = 'SELECT factionID, factionName FROM '. EVE_DUMP .'.chrFactions';
		$stmt = $mysql->prepare($query);
		$stmt->execute();
		while ($row = $stmt->fetchObject()) {
			$output['factions'][$row->factionID]['name'] = $row->factionName;
		}

		// Wormholes
		$output['wormholes'] = json_decode(file_get_contents(dirname(__FILE__).'/wormholes.json'));

		// Map
		$output['map'] = json_decode(file_get_contents(dirname(__FILE__).'/map.json'));

		// Effects
		$output['effects'] = json_decode(file_get_contents(dirname(__FILE__).'/effects.json'));

		// Ship mass
		$output['mass'] = json_decode(file_get_contents(dirname(__FILE__).'/mass.json'));

		fwrite($file, 'var appData = ');
		fwrite($file, json_encode($output, JSON_PRETTY_PRINT));
		fclose($file);
	}
}

?>

<div style="margin: 0 auto; width: 50%; text-align: center">
	<p>
		<input type="button" value="Generate map.json" onclick="window.location.href='?map=true';" />
		<input type="button" value="Generate mass.json" onclick="window.location.href='?mass=true';" />
	</p>
	<p><input type="button" value="Generate combine.js" onclick="window.location.href='?combine=true';" /></p>
</div>
