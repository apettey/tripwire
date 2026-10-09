<?php

ini_set('display_errors', 'On');

require('config.php');
require('db.inc.php');
require('esi.class.php');

$esi = new esi();

$query = 'SELECT c.characterID FROM active a INNER JOIN characters c ON a.userID = c.userID';
$stmt = $mysql->prepare($query);
$stmt->execute();
$characterIDs = $stmt->fetchAll(PDO::FETCH_COLUMN);


if ($characterIDs && count($characterIDs) > 0) {
    $affiliation = $esi->getAffilitation($characterIDs);
    $corporationIDs = array();
    foreach($affiliation as $affil){
        $corporationIDs[] = $affil->corporation_id;
    }

    $names = $esi->getNames($corporationIDs);
    $query = 'UPDATE characters SET corporationID = :corporationID, corporationName = :corporationName, ban = 0, admin = 0 WHERE characterID = :characterID AND corporationID <> :corporationID';
    $stmt = $mysql->prepare($query);
    foreach ($characterIDs AS $characterID) {
        // $character = $esi->getCharacter($characterID);
        // $corporation = $esi->getCorporation($character->corporation_id);
        if (isset($affiliation[$characterID]) && isset($names[$affiliation[$characterID]->corporation_id])) {
            $stmt->bindValue(':characterID', $characterID);
    		$stmt->bindValue(':corporationID', $affiliation[$characterID]->corporation_id);
    		$stmt->bindValue(':corporationName', $names[$affiliation[$characterID]->corporation_id]->name);
            $stmt->execute();
        }
    }
}
