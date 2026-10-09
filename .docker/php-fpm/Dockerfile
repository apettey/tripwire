FROM php:8-fpm-alpine

ADD https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/
RUN chmod +x /usr/local/bin/install-php-extensions && \
    install-php-extensions pdo_mysql gd intl mbstring

# Session path must exist when session.save_handler is set to "files"
RUN mkdir -m 700 -p /var/lib/php/session \
 && chown www-data /var/lib/php/session

# Customize PHP and PHP-FPM through configuration files
COPY php.ini /usr/local/etc/php/php.ini
COPY www.conf /usr/local/etc/php-fpm.d/www.conf
