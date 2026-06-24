#!/usr/bin/env bash
# Assemble an AppDir from out/vortex-unpacked and package it as an AppImage.
# No .NET bundling: the FOMOD native backend is NativeAOT (self-contained); the
# .NET runtime is a build-only dependency. Runs INSIDE the linux-vortex-build container.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO_ROOT/out"
APP="$OUT/vortex-unpacked"
APPDIR="$OUT/AppDir"
BUILD_HOME="${BUILD_HOME:-/build}"

test -d "$APP" || { echo "!! Missing $APP — run build-upstream.sh first" >&2; exit 1; }

PINNED="$(tr -d '[:space:]' < "$REPO_ROOT/pinned-commit")"
SHORT="${PINNED:0:7}"
DATE="$(date +%Y%m%d)"   # stamped at run time; provenance is the pinned SHA below.

echo ">> Assembling AppDir at $APPDIR ..."
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"

# App payload at AppDir root (electron-builder convention: vortex binary + resources/).
cp -a "$APP/." "$APPDIR/"

# --- FOMOD native backend fix ---
# Upstream ships the FOMOD .node with an absolute build-tree RUNPATH and omits its
# companion ModInstaller.Native.so from the package, so scripted FOMOD installs break.
# Co-locate the .so next to the .node and rewrite the RUNPATH to $ORIGIN -> portable.
FOMOD_NODE="$(find "$APPDIR" -name 'fomod-installer-native.node' 2>/dev/null | head -1 || true)"
if [ -n "$FOMOD_NODE" ]; then
  FOMOD_SO="$(find "$BUILD_HOME/upstream" -path '*fomod-installer-native*' -name 'ModInstaller.Native.so' 2>/dev/null | head -1 || true)"
  if [ -n "$FOMOD_SO" ]; then
    cp -a "$FOMOD_SO" "$(dirname "$FOMOD_NODE")/"
    patchelf --set-rpath '$ORIGIN' "$FOMOD_NODE"
    echo ">> FOMOD: co-located $(basename "$FOMOD_SO") + set RUNPATH=\$ORIGIN on $(basename "$FOMOD_NODE")"
  else
    echo "!! FOMOD: ModInstaller.Native.so not found in build tree; scripted installs may not work." >&2
  fi
else
  echo "!! FOMOD: fomod-installer-native.node not found in AppDir; skipping FOMOD fix." >&2
fi
# --- end FOMOD fix ---

# --- .NET runtime + dotnetprobe ---
# Vortex spawns resources/app.asar.unpacked/assets/dotnetprobe at startup (a
# framework-dependent .NET tool) and treats a missing/failing .NET as FATAL. Upstream
# builds+copies the probe to src/main/build/assets but electron-builder doesn't carry it
# into app.asar.unpacked/assets, so it's absent. Inject the probe and bundle the .NET 9
# runtime; AppRun points DOTNET_ROOT at it so the probe runs and reports success.
DOTNET_SRC="$REPO_ROOT/vendor/dotnet"
test -x "$DOTNET_SRC/dotnet" || { echo "!! Missing vendored .NET runtime — run fetch-dotnet-runtime.sh" >&2; exit 1; }
echo ">> Bundling .NET runtime -> AppDir/dotnet"
mkdir -p "$APPDIR/dotnet"
cp -a "$DOTNET_SRC/." "$APPDIR/dotnet/"

PROBE_SRC="$(find "$BUILD_HOME/upstream/tools/dotnetprobe/dist" -maxdepth 1 -name 'dotnetprobe' -type f 2>/dev/null | head -1 || true)"
[ -n "$PROBE_SRC" ] || { echo "!! dotnetprobe not found in build tree (tools/dotnetprobe/dist)" >&2; exit 1; }
ASSETS_UNPACKED="$APPDIR/resources/app.asar.unpacked/assets"
mkdir -p "$ASSETS_UNPACKED"
install -m755 "$PROBE_SRC" "$ASSETS_UNPACKED/dotnetprobe"
echo ">> dotnetprobe -> resources/app.asar.unpacked/assets/dotnetprobe + .NET 9 bundled"
# --- end .NET ---

# AppRun entrypoint.
install -m755 "$REPO_ROOT/appimage/AppRun" "$APPDIR/AppRun"

# Desktop entry: the in-AppDir copy uses a static Exec (required by appimagetool);
# AppRun re-pins a host copy to the real $APPIMAGE path at runtime, so keep the
# template available inside the image too.
sed 's|@EXEC@|linux-vortex|g' "$REPO_ROOT/appimage/linux-vortex.desktop" > "$APPDIR/linux-vortex.desktop"
cp "$REPO_ROOT/appimage/linux-vortex.desktop" "$APPDIR/linux-vortex.desktop.template"

# Icon: not present in the unpacked app; take it from the upstream source tree.
ICON="$(find "$BUILD_HOME/upstream/assets" -name 'vortex.png' 2>/dev/null | head -1 || true)"
[ -n "$ICON" ] || { echo "!! Could not find vortex.png in $BUILD_HOME/upstream/assets" >&2; exit 1; }
cp "$ICON" "$APPDIR/linux-vortex.png"
cp "$ICON" "$APPDIR/usr/share/icons/hicolor/256x256/apps/linux-vortex.png"

OUTFILE="$OUT/linux-vortex-${DATE}-g${SHORT}-x86_64.AppImage"
rm -f "$OUT"/linux-vortex-*-x86_64.AppImage
echo ">> Packaging with appimagetool -> $OUTFILE"
ARCH=x86_64 appimagetool --appimage-extract-and-run "$APPDIR" "$OUTFILE"
echo ">> APPIMAGE BUILT: $OUTFILE"
ls -la "$OUTFILE"
