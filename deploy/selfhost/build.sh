#!/bin/sh
# Builds what the self-hosted stack serves. Runs in the bun image with the repo
# at /src, the output directory at /www and the build-time env (VITE_PUBLIC_*,
# PROD_*, RIPTIDE_DAEMON_*) set. See the humanlayer_stack Ansible role in infra.
#
# Each output is keyed on the git trees it is built from and goes to
# /www/<name>-<key>. /www/<name> is a symlink to the live one, swapped only
# after a build succeeds, so the site never serves a half-built bundle and an
# unchanged app is not rebuilt.
set -eu
cd /src
bun install --frozen-lockfile

shared="HEAD:packages HEAD:contracts HEAD:bun.lock HEAD:package.json"

# build <name> <git paths...> -- <command; $out is the output directory>
build() {
	name=$1; shift
	paths=""
	while [ "$1" != "--" ]; do paths="$paths $1"; shift; done
	shift
	key=$(git rev-parse $paths $shared | sha1sum | cut -c1-12)
	dir="/www/$name-$key"
	if [ ! -d "$dir" ]; then
		echo "building $name ($key)"
		rm -rf "$dir.tmp"
		out="$dir.tmp" sh -c "$*"
		mv "$dir.tmp" "$dir"
	fi
	ln -sfn "$name-$key" "/www/$name.new"
	mv -T "/www/$name.new" "/www/$name"
	# Keep the live build and the one before it.
	ls -dt /www/"$name"-* | grep -v '\.tmp$' | tail -n +3 | xargs -r rm -rf
}

build ui HEAD:apps/riptide-ui -- 'cd apps/riptide-ui && bun --bun vite build --outDir "$out" --emptyOutDir'
build cloud HEAD:apps/riptide-cloud -- 'cd apps/riptide-cloud && bun --bun vite build --outDir "$out" --emptyOutDir'
build downloads HEAD:apps/cli HEAD:apps/riptide-daemon -- 'cd apps/cli && bun run ./build.ts --target linux-x64 && bun run ./build.ts --target darwin-arm64 && mkdir -p "$out" && cp dist/humanlayer-linux-x64 dist/humanlayer-darwin-arm64 "$out"/'
