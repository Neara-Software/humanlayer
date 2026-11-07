#!/bin/sh
# Builds what the self-hosted stack serves. Runs in the oven/bun image with the
# repo at /src and the build-time env (VITE_PUBLIC_*, PROD_*, RIPTIDE_DAEMON_*)
# set. See the humanlayer_stack Ansible role in infra.
set -eu
cd /src
bun install --frozen-lockfile
(cd apps/riptide-ui && bun --bun vite build)
(cd apps/riptide-cloud && bun --bun vite build)
(cd apps/cli && bun run ./build.ts --target linux-x64 && bun run ./build.ts --target darwin-arm64)
