# Self-contained Tripwire image: nginx + php-fpm + cron in one container.
# Configured entirely through environment variables (see docker/README.md).
#
# Build from the repo root:
#   docker build -f docker/Dockerfile -t tripwire .

############################################################
# Stage 1: build front-end bundles (public/js/app.min.js, public/css/app.min.css)
############################################################
# Bundles are plain JS/CSS, so this stage runs natively on the build host even for linux/arm64
FROM --platform=$BUILDPLATFORM node:25-bookworm-slim AS assets

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY gulpfile.js ./
COPY docker/gulpfile.dev.js ./docker/
COPY app ./app
RUN mkdir -p public/js public/css
ENV DISABLE_NOTIFIER=true
# The fork's gulpfile wrapper: script order matters and upstream's gulpfile leaves it to the file system
RUN npx gulp --gulpfile docker/gulpfile.dev.js --cwd . js css

############################################################
# Stage 2: app files only (no repo/dev files in /opt/app)
############################################################
# Starts from the full build context and deletes what the running app doesn't need. Removed:
# - fork/dev files: docs, change log, agent files, compose files, CI, docker/ (the runtime stage copies
#   what it needs from the build context), .env.example, scripts/
# - upstream dev/deploy files: example configs, bitbucket-pipelines.yml, crontab-tw.txt (docker/crontab
#   replaces it), composer.json (vendor/ is committed), 403/404.html (copied to nginx below)
# - front-end sources and tooling: app/ (bundles are built into public/ by the assets stage), gulpfile.js,
#   package*.json, node_modules
# - tools/: upstream admin scripts that regenerate public/js/combine.js from the EVE SDE; nothing at
#   runtime reads them, they are outside the docroot and json_builder.php needs a web session anyway
# - upstream's analytics.inc.php / donation_panel.inc (replaced by docker/ versions below) and
#   public/donate.html (unlinked upstream PayPal redirect page)
# - .docker/ except mysql/tripwire.sql, which the entrypoint imports
FROM --platform=$BUILDPLATFORM php:8.5.12-fpm-alpine3.24 AS src

WORKDIR /src
COPY . .
RUN rm -rf \
      AGENTS.md CLAUDE.md README.md docs changes .claude .github .idea docker \
      docker-compose*.yml .env.example .gitattributes .gitignore scripts traefik-data \
      bitbucket-pipelines.yml crontab-tw.txt composer.json 403.html 404.html \
      config.example.php db.inc.example.php db.inc.docker.example.php config.php db.inc.php \
      analytics.inc.php donation_panel.inc public/donate.html \
      app gulpfile.js package.json package-lock.json node_modules tools tests zkill/tests zkill/tools discord/tests discord/tools esi/tests intel/tests intel/tools watchlist/tests jumprange/tests jumprange/tools fight/tests structures/tests \
 && mv .docker/mysql/tripwire.sql /tmp/tripwire.sql \
 && rm -rf .docker \
 && mkdir -p .docker/mysql \
 && mv /tmp/tripwire.sql .docker/mysql/tripwire.sql
# Upstream's settings.php only defines VERSION; docker/settings.php replaces it (fork version as VERSION)
# and reads upstream's version from settings.upstream.php. Fail if upstream starts defining anything else,
# which the override would silently drop.
RUN defines=$(grep -o 'define(' settings.php | wc -l) \
 && if [ "$defines" -ne 1 ] || ! grep -q "define('VERSION'" settings.php; then \
      echo "settings.php has $defines define() calls (expected only VERSION): update docker/settings.php" >&2; \
      exit 1; \
    fi \
 && mv settings.php settings.upstream.php

############################################################
# Stage 3: runtime
# PHP patch version is pinned so a cached base layer can never ship an unpatched PHP; bump it for each
# PHP security release (Dependabot proposes them). CI's "PHP syntax" job reads the version from here and fails
# when docker-compose.dev.yml's PHP image differs
############################################################
FROM php:8.5.12-fpm-alpine3.24 AS runtime

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
COPY docker/php-security.ini /usr/local/etc/php/conf.d/tripwire-security.ini

COPY docker/nginx.conf /etc/nginx/http.d/default.conf
COPY docker/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
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
COPY --from=src /src /opt/app
COPY --from=assets /src/public/js/app.min.js /src/public/js/app.min.js.map /opt/app/public/js/
COPY --from=assets /src/public/css/app.min.css /src/public/css/app.min.css.map /opt/app/public/css/
COPY docker/config.php /opt/app/config.php
COPY docker/db.inc.php /opt/app/db.inc.php
# VERSION = TRIPWIRE_FORK_VERSION, UPSTREAM_VERSION from settings.upstream.php (see docker/README.md#versions)
COPY docker/settings.php /opt/app/settings.php
# Replace upstream's Google Analytics property and PayPal panel/pixel with opt-in versions
# (GA_MEASUREMENT_ID, DONATION_PANEL_HTML_FILE; see docker/README.md)
COPY docker/analytics.inc.php /opt/app/analytics.inc.php
COPY docker/donation_panel.inc /opt/app/donation_panel.inc

RUN chown -R www-data:www-data /opt/app/cache

# Fork release version (CI passes the vX.Y.Z tag without the v). docker/settings.php makes it the app's
# VERSION at runtime (PHP-FPM sees it: upstream's www.conf has clear_env = no). Also written, from the same
# settings.php, to public/version.json for the What's New dialog; generated in the image only, the dev
# stack bind-mounts the repo over it.
ARG TRIPWIRE_FORK_VERSION=dev
ENV TRIPWIRE_FORK_VERSION=$TRIPWIRE_FORK_VERSION
RUN php -r 'require "settings.php"; if (UPSTREAM_VERSION === "unknown") { fwrite(STDERR, "Could not read the upstream version from settings.upstream.php\n"); exit(1); } echo json_encode(["version" => VERSION, "upstream" => UPSTREAM_VERSION], JSON_UNESCAPED_SLASHES), "\n";' > public/version.json \
 && cat public/version.json

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

ENTRYPOINT ["tripwire-entrypoint"]
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
