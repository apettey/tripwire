# Self-contained Tripwire image: nginx + php-fpm + cron in one container.
# Configured entirely through environment variables (see docker/README.md).
#
# Build from the repo root:
#   docker build -f docker/Dockerfile -t tripwire .

############################################################
# Stage 1: build front-end bundles (public/js/app.min.js, public/css/app.min.css)
############################################################
FROM node:20-bookworm-slim AS assets

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY gulpfile.js ./
COPY app ./app
RUN mkdir -p public/js public/css
ENV DISABLE_NOTIFIER=true
RUN npx gulp js css

############################################################
# Stage 2: runtime
############################################################
FROM php:8.3-fpm-alpine3.24 AS runtime

ADD --chmod=0755 https://github.com/mlocati/docker-php-extension-installer/releases/download/2.7.24/install-php-extensions /usr/local/bin/
RUN apk add --no-cache nginx supervisor mariadb-client mariadb-connector-c bash tzdata \
    icu-libs libpng libjpeg-turbo freetype libwebp libavif libxpm
RUN install-php-extensions pdo_mysql gd intl mbstring \
 && php -m 2>&1 | grep -qx gd && ! php -m 2>&1 | grep -q Warning \
 && mkdir -m 700 -p /var/lib/php/session \
 && chown www-data /var/lib/php/session

# Reuse upstream's PHP / FPM tuning so their changes flow in on merge
COPY .docker/php-fpm/php.ini /usr/local/etc/php/php.ini
COPY .docker/php-fpm/www.conf /usr/local/etc/php-fpm.d/www.conf
COPY docker/php-fpm-local.conf /usr/local/etc/php-fpm.d/zz-local.conf

COPY docker/nginx.conf /etc/nginx/http.d/default.conf
COPY docker/50x.html 404.html 403.html /usr/share/nginx/tripwire-errors/
COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/crontab /etc/crontabs/www-data
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/tripwire-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/tripwire-entrypoint /etc/crontabs/www-data \
 && chmod 600 /etc/crontabs/www-data \
 && ln -sf /dev/stdout /var/log/nginx/access.log \
 && ln -sf /dev/stderr /var/log/nginx/error.log \
 && touch /etc/nginx/http.d/realip.conf

WORKDIR /opt/app
COPY . /opt/app
COPY --from=assets /src/public/js/app.min.js /src/public/js/app.min.js.map /opt/app/public/js/
COPY --from=assets /src/public/css/app.min.css /src/public/css/app.min.css.map /opt/app/public/css/
COPY docker/config.php /opt/app/config.php
COPY docker/db.inc.php /opt/app/db.inc.php

RUN chown -R www-data:www-data /opt/app/cache

# Fork release version (CI passes the vX.Y.Z tag without the v), shown in the What's New dialog via
# public/version.json. Generated in the image only; the dev stack bind-mounts the repo over it ("dev").
ARG TRIPWIRE_FORK_VERSION=dev
ENV TRIPWIRE_FORK_VERSION=$TRIPWIRE_FORK_VERSION
RUN upstream=$(sed -n "s/.*define('VERSION', *'\([^']*\)').*/\1/p" settings.php | head -n1) \
 && UPSTREAM="${upstream:-unknown}" php -r 'echo json_encode(["version" => getenv("TRIPWIRE_FORK_VERSION") ?: "dev", "upstream" => getenv("UPSTREAM")], JSON_UNESCAPED_SLASHES), "\n";' > public/version.json \
 && cat public/version.json

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

ENTRYPOINT ["tripwire-entrypoint"]
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
