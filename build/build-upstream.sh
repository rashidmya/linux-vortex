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
# -f: the persistent volume keeps the tree from the previous run, which carries our
# downstream source patches. Discard them and re-apply below, so a build is repeatable
# and a pinned-commit bump doesn't fail on "local changes would be overwritten".
git -C "$SRC" checkout -f -q "$PINNED"
git -C "$SRC" submodule update --init --recursive --depth 1

# 1b. Downstream Linux source fix: games running under Proton read "Documents" and
#     "%LOCALAPPDATA%" from inside their compatdata prefix, not from the host's XDG dirs
#     util.getVortexPath() reports. Install a helper that resolves the prefix from the
#     discovered game path and convert the shared gamebryo modules. See docs/AS-BUILT.md.
echo ">> Patching core (Proton game paths helper + gamebryo modules) ..."
node "$REPO_ROOT/build/patch-linux-game-paths.cjs" "$SRC"

# 1c. Downstream Linux source fix: the Witcher 3 extension's load order file, menu mods and
#     "open documents" action all resolve through the helper from 1b (must run after it).
#     See docs/AS-BUILT.md.
echo ">> Patching witcher3 extension (Proton documents path) ..."
node "$REPO_ROOT/build/patch-witcher3-proton-docs.cjs" "$SRC"

# 1d. Downstream Linux source fix: api.runExecutable spawns Windows executables directly,
#     which fails on Linux (EACCES, reported as a bogus firewall error). Route them through
#     Proton the way StarterInfo already does. See docs/AS-BUILT.md.
echo ">> Patching core (run Windows tools through Proton) ..."
node "$REPO_ROOT/build/patch-linux-proton-tools.cjs" "$SRC"

# 1e. Downstream Linux source fix: Vortex writes the W3 Script Merger's config for the user
#     with POSIX paths, but the merger is a Windows .NET tool running in the game's Proton
#     prefix. It does not reject them - it silently merges to a junk path, so merges appear
#     to work and do nothing. See docs/AS-BUILT.md.
echo ">> Patching witcher3 extension (script merger paths) ..."
node "$REPO_ROOT/build/patch-witcher3-scriptmerger-paths.cjs" "$SRC"

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

# The helper is plain TypeScript; verify it with the compiler pnpm just installed, before
# spending an hour on the full build.
echo ">> Verifying the Proton game paths helper ..."
node "$REPO_ROOT/qa/test-game-paths.cjs" "$REPO_ROOT/build/patches/vortex/gamePaths.ts" \
  --typescript "$SRC/node_modules/typescript"

export NODE_ENV=production
echo ">> nx build (serial, no lint/typecheck) ..."
corepack pnpm nx run-many -t build --parallel=1
echo ">> assets ..."
corepack pnpm run assets
# Follow upstream's exact packaging sequence (.github/actions/package): publish a CLEAN
# dist (the publish script rimrafs ./dist, then pnpm-deploys into it, with electron-rebuild
# skipped), rebuild native modules ONCE, then run electron-builder. Our previous shortcut
# (the nx `package:nosign` TARGET) rebuilt + packaged together on a tree that already had
# the natives -> electron-builder "EEXIST: link winapi.node" on a clean build.
echo ">> publish clean dist package ..."
VORTEX_ELECTRON_REBUILD=skip corepack pnpm nx run @vortex/main:publish
# Downstream Linux dependency fix: vortex-parse-ini's only ini backend calls Win32 profile
# functions that winapi-bindings doesn't provide off Windows, so every ini read/write in
# Vortex throws on Linux. src/main/dist is the tree electron-builder packs into app.asar,
# and :publish re-materialises its node_modules, so this has to happen AFTER publish.
echo ">> Patching vortex-parse-ini (pure-JS ini backend for Linux) ..."
node "$REPO_ROOT/build/patch-linux-ini.cjs" "$SRC/src/main/dist/node_modules"
echo ">> Verifying the patched ini backend ..."
node "$REPO_ROOT/qa/test-linux-ini.cjs" "$SRC/src/main/dist/node_modules/vortex-parse-ini"
echo ">> electron-rebuild native modules in dist ..."
( cd "$SRC/src/main/dist" && npx --yes electron-rebuild )
# Strip node-gyp's build/Release/obj.target/ dirs: each holds a HARDLINKED duplicate of
# its *.node (same inode), which electron-builder's `**/*.node` unpack rule double-links
# to the same app.asar.unpacked destination -> "EEXIST: link winapi.node" on clean builds.
# (Cached local builds lacked the obj.target copy, so this only surfaced on a fresh CI runner.)
echo ">> stripping node-gyp obj.target duplicates ..."
find "$SRC/src/main/dist/node_modules" -type d -name obj.target -exec rm -rf {} + 2>/dev/null || true
# USE_HARD_LINKS=false makes electron-builder COPY (overwrite) instead of hardlink, so the
# duplicate native-module paths in pnpm's deployed node_modules (obj.target + the .pnpm
# store copy) no longer fail with "EEXIST: link winapi.node". This is the real clean-build
# fix; the obj.target strip above just trims bloat. Validated locally with duplicates present.
echo ">> package (electron-builder, nosign) ..."
USE_HARD_LINKS=false corepack pnpm -F @vortex/main run package:nosign

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
