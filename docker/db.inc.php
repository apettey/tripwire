<?php
// Docker DB connection: settings come from environment variables.

try {
    $mysql = new PDO(
        sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
            getenv('DB_HOST') ?: 'mysql',
            getenv('DB_PORT') ?: '3306',
            getenv('DB_NAME') ?: 'tripwire_database'),
        getenv('DB_USER') ?: 'tripwire',
        getenv('DB_PASSWORD') ?: '',
        Array(
            PDO::ATTR_PERSISTENT     => true
        )
    );
} catch (PDOException $error) {
    error_log($error->getMessage());
}
