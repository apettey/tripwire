docker compose --env-file .env up -d traefik php-fpm mysql
sleep 5
docker compose --env-file .env up -d nginx adminer
