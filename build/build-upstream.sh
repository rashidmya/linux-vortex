#!/usr/bin/env bash
# Clone Vortex @ pinned-commit, build the native Linux app, and stage the unpacked
# app at out/vortex-unpacked/. Runs INSIDE the linux-vortex-build container.
#
# Heavy I/O (git clone, node_modules, build) happens in $BUILD_HOME — a persistent
# Docker *named volume* on the fast container fs — NOT on the slow Docker Desktop
# bind mount (virtiofs), where pnpm's 100k-file node_modules would crawl.
# Only the final unpacked app is copied back to the bind-mounted repo (out/).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINNED="$(tr -d '[:space:]' < "$REPO_ROOT/pinned-commit")"
BUILD_HOME="${BUILD_HOME:-/build}"
SRC="$BUILD_HOME/upstream"
OUT="$REPO_ROOT/out"

# Node heap headroom, but stay under the ~8 GiB Docker Desktop VM.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
# nx daemon is unhelpful in an ephemeral container; disable for determinism.
export NX_DAEMON=false

echo ">> Pinned upstream commit: $PINNED"
echo ">> Build work area:        $BUILD_HOME (persistent volume)"
echo ">> Node options:           $NODE_OPTIONS"
mkdir -p "$BUILD_HOME"
rm -rf "$OUT" && mkdir -p "$OUT"

# 1. Fetch source at the exact pinned commit, with submodules. Clone once into the
#    persistent volume; subsequent runs just re-fetch/checkout.
if [ ! -d "$SRC/.git" ]; then
  echo ">> Cloning Vortex into $SRC ..."
  git clone --recurse-submodules https://github.com/Nexus-Mods/Vortex.git "$SRC"
fi
echo ">> Checking out $PINNED ..."
git -C "$SRC" fetch --depth 1 origin "$PINNED"
git -C "$SRC" checkout -q "$PINNED"
git -C "$SRC" submodule update --init --recursive --depth 1

# 2. Install deps, then build + package.
#    NOTE: we deliberately do NOT use upstream's `package:nosign` wrapper, which runs
#    `nx run-many -t build lint typecheck` concurrently across 151 projects. On the
#    ~8 GiB Docker Desktop VM that OOM-kills (eslint --concurrency auto spawns one
#    worker per CPU; webpack + many parallel tsc pile on). For PACKAGING we only need
#    the `build` target + assets + electron-builder; lint/typecheck are irrelevant.
#    We also force --parallel=1 so a single heavy build (webpack renderer) fits in RAM.
cd "$SRC"
echo ">> pnpm install ..."
corepack pnpm install --frozen-lockfile

export NODE_ENV=production
echo ">> nx build (serial, no lint/typecheck) ..."
corepack pnpm nx run-many -t build --parallel=1
echo ">> assets ..."
corepack pnpm run assets
echo ">> package (electron-builder, nosign) ..."
corepack pnpm nx run @vortex/main:package:nosign --parallel=1

# 3. Discover the unpacked Linux app dir (output path NOT hardcoded; the
#    nx/electron-builder output location is in flux upstream).
echo ">> Locating unpacked Linux app ..."
mapfile -t CANDIDATES < <(find "$SRC" -type d -name 'linux*unpacked' -not -path '*/node_modules/*' 2>/dev/null)
if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "!! No linux*-unpacked dir; looking for a linux zip to extract instead ..." >&2
  ZIP="$(find "$SRC" -type f -name '*linux*.zip' -not -path '*/node_modules/*' | head -1 || true)"
  [ -n "$ZIP" ] || { echo "!! No linux app artifact found at all. Build flow changed; inspect $SRC." >&2; exit 1; }
  echo ">> Extracting $ZIP"
  mkdir -p "$OUT/vortex-unpacked"
  ( cd "$OUT/vortex-unpacked" && unzip -q "$ZIP" )
else
  [ "${#CANDIDATES[@]}" -eq 1 ] || { printf '!! Multiple unpacked dirs found:\n%s\n' "${CANDIDATES[@]}" >&2; exit 1; }
  echo ">> Copying ${CANDIDATES[0]} -> $OUT/vortex-unpacked"
  mkdir -p "$OUT/vortex-unpacked"
  cp -a "${CANDIDATES[0]}/." "$OUT/vortex-unpacked/"
fi

# 4. Record provenance + the located main binary for later stages.
BIN="$(find "$OUT/vortex-unpacked" -maxdepth 1 -type f -name 'vortex' | head -1 || true)"
[ -n "$BIN" ] || BIN="$(find "$OUT/vortex-unpacked" -maxdepth 1 -type f -perm -u+x | head -1)"
[ -n "$BIN" ] || { echo "!! Could not locate a main executable in the unpacked app." >&2; exit 1; }
echo "$PINNED" > "$OUT/BUILT_FROM"
echo "${BIN#$OUT/vortex-unpacked/}" > "$OUT/MAIN_BINARY"
echo ">> Unpacked app at:        $OUT/vortex-unpacked"
echo ">> Main binary (relative): $(cat "$OUT/MAIN_BINARY")"
echo ">> BUILD-UPSTREAM OK"
