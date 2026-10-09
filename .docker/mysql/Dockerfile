FROM debian:bullseye

WORKDIR /seed

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        wget \
        bzip2 \
        curl \
        mariadb-client \
        ca-certificates \
        tar && \
    rm -rf /var/lib/apt/lists/*

COPY seed.sh .
COPY tripwire.sql ./tripwire.sql

RUN chmod +x seed.sh

ENTRYPOINT ["/seed/seed.sh"]
