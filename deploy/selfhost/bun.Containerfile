# Bun plus the toolchain native modules (node-pty) need to build. Used for the
# self-hosted builds and to run the bun services.
FROM docker.io/oven/bun:1.3.14
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
