<?php

$characterIDs = ( isset( $_REQUEST['characterID'] ) ) ? (array) $_REQUEST['characterID'] : [];

if ( ! empty( $characterIDs ) && $maskID ) {
	$characterIN = implode( ", ", $characterIDs );
	$query = 'SELECT * FROM statistics WHERE characterID IN ( :characterIN ) AND maskID = :maskID';
	$stmt = $mysql->prepare( $query );
	$stmt->bindValue( ':characterIN', $characterIN );
	$stmt->bindValue( ':maskID', $maskID );
	$stmt->execute();
	$rows = $stmt->fetchAll( PDO::FETCH_CLASS );
	foreach ( $rows as $row ) {
		$output[] = $row;
	}
} else if ( $maskID ) {
	$query = 'SELECT * FROM statistics WHERE maskID = :maskID';
	$stmt = $mysql->prepare( $query );
	$stmt->bindValue( ':maskID', $maskID );
	$stmt->execute();
	$rows = $stmt->fetchAll( PDO::FETCH_CLASS );
	foreach ( $rows as $row ) {
		$output[] = $row;
	}
}