#!/bin/sh
# Builds "HumanLayer Neara.app": the desktop app pointed at the self-hosted
# instance, with its own name, bundle id and deep-link scheme so it can sit next
# to the official HumanLayer.app. Unsigned (ad-hoc). Its updater asks the
# self-hosted host, which answers "no update".
# Run on an Apple Silicon Mac from the repo root.
set -eu
origin=${SELFHOST_ORIGIN:-https://nearabeast.tail9bf356.ts.net}
host=${origin#https://}
export BUILD_TYPE=prod
export VITE_PUBLIC_BUILD_TYPE=prod VITE_PUBLIC_REMOTE_DAEMON_BUILD_TYPE=prod VITE_PUBLIC_ENVIRONMENT=prod
export VITE_PUBLIC_DEEP_LINK_SCHEME=humanlayer-neara
export VITE_PUBLIC_RIPTIDE_API_ORIGIN=$origin/api VITE_PUBLIC_SYNC_ORIGIN=$origin/sync
export VITE_PUBLIC_APP_ORIGIN=$origin VITE_PUBLIC_CLOUD_ORIGIN=$origin:8443
export VITE_PUBLIC_WORKOS_CLIENT_ID=client_humanlayer_selfhost VITE_PUBLIC_WORKOS_API_HOSTNAME=$host
export VITE_PUBLIC_BLOCK_NEW_ORG_CREATION=true
export RIPTIDE_DAEMON_API_ORIGIN=$origin/api RIPTIDE_DAEMON_SYNC_ORIGIN=$origin/sync
export RIPTIDE_DAEMON_APP_ORIGIN=$origin RIPTIDE_DAEMON_CLOUD_ORIGIN=$origin:8443
export NODE_OPTIONS=--max-old-space-size=24576
bun install --frozen-lockfile
cd apps/riptide-native
bun run tauri build --bundles app --config tauri.selfhost.conf.json
