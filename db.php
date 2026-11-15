<?php

function create_db_connection($connection_string, $user, $password) {
	try {
		return new PDO($connection_string, $user, $password,
			Array(
				PDO::ATTR_PERSISTENT     => true,
				PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION	
			)
		);
	} catch (PDOException $error) {		
		error_log($error->getMessage());
		die("Couldn't make database connection for $user");
	}
}

include 'db.inc.php';