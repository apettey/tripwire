<?php

$mysql = create_db_connection('mysql:host=localhost;dbname=tripwire_database;charset=utf8',
	'username',
	'password'
);

// Allowing Tripwire to self update:
// Option 1: Run a separate update script. If you don't set a $mysql_update, attempting to access pages will fail if you need to update. You'll have to run that script as part of upgrade deployment.

// Option 2: Use the same connection, giving that user update rights. This is fine, but would allow an injection attack to do more damage.
// $mysql_update = $mysql;

// Option 3 (recommended): Create a second account with update rights. This will only be used for the update itself, and the main tripwire account can use minimal select/update/delete permissions
$mysql_update = create_db_connection('mysql:host=localhost;dbname=tripwire_database;charset=utf8',
	'username-for-update',
	'password'
);
