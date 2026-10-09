<?php

try {
    $mysql = new PDO(
        'mysql:host=mysql;dbname=tripwire_database;charset=utf8',
        'usernamefromdockercompose',
        'userpasswordfromdockercompose',
        Array(
            PDO::ATTR_PERSISTENT     => true
        )
    );
} catch (PDOException $error) {
    error_log($error->getMessage());
}
