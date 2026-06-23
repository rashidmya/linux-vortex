#!/usr/bin/env bash
# Assemble an AppDir from out/vortex-unpacked and package it as an AppImage.
# No .NET bundling: the FOMOD native backend is NativeAOT (self-contained); the
# .NET runtime is a build-only dependency. Runs INSIDE the linvortex-build container.
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

# AppRun entrypoint.
install -m755 "$REPO_ROOT/appimage/AppRun" "$APPDIR/AppRun"

# Desktop entry: the in-AppDir copy uses a static Exec (required by appimagetool);
# AppRun re-pins a host copy to the real $APPIMAGE path at runtime, so keep the
# template available inside the image too.
sed 's|@EXEC@|linvortex|g' "$REPO_ROOT/appimage/linvortex.desktop" > "$APPDIR/linvortex.desktop"
cp "$REPO_ROOT/appimage/linvortex.desktop" "$APPDIR/linvortex.desktop.template"

# Icon: not present in the unpacked app; take it from the upstream source tree.
ICON="$(find "$BUILD_HOME/upstream/assets" -name 'vortex.png' 2>/dev/null | head -1 || true)"
[ -n "$ICON" ] || { echo "!! Could not find vortex.png in $BUILD_HOME/upstream/assets" >&2; exit 1; }
cp "$ICON" "$APPDIR/linvortex.png"
cp "$ICON" "$APPDIR/usr/share/icons/hicolor/256x256/apps/linvortex.png"

OUTFILE="$OUT/linvortex-${DATE}-g${SHORT}-x86_64.AppImage"
rm -f "$OUT"/linvortex-*-x86_64.AppImage
echo ">> Packaging with appimagetool -> $OUTFILE"
ARCH=x86_64 appimagetool --appimage-extract-and-run "$APPDIR" "$OUTFILE"
echo ">> APPIMAGE BUILT: $OUTFILE"
ls -la "$OUTFILE"
