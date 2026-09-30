#!/usr/bin/env bash
# Static smoke gate for the built AppImage / AppDir. Runs INSIDE the build container.
#
# NOTE: the build container has no Electron GUI runtime libs, so the actual window boot
# is verified on the host (see README / build-all.sh). These checks are deterministic
# structural assertions, including the FOMOD native-library resolution fix.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO_ROOT/out"
APPDIR="$OUT/AppDir"

PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
no(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }

APPIMAGE="$(ls "$OUT"/linux-vortex-*-x86_64.AppImage 2>/dev/null | head -1 || true)"
# The FOMOD .node that actually gets loaded is chosen by node-gyp-build, which prefers
# build/Release/ over prebuilds/ (see node-gyp-build.js). Resolve it the same way instead
# of hardcoding a filename: upstream repackages this module between releases, and v2.6.3
# dropped the bin/<platform>-<abi>/ copy an earlier filename check relied on.
FOMOD_PKG="$(find "$APPDIR" -type d -path '*@nexusmods/fomod-installer-native' 2>/dev/null | head -1 || true)"
NODE=""
if [ -n "$FOMOD_PKG" ]; then
  NODE="$(find "$FOMOD_PKG/build/Release" -name '*.node' 2>/dev/null | head -1 || true)"
  [ -n "$NODE" ] || NODE="$(find "$FOMOD_PKG" -name '*.node' 2>/dev/null | head -1 || true)"
fi

{ [ -n "$APPIMAGE" ] && [ -f "$APPIMAGE" ]; } && ok "AppImage artifact exists" || no "AppImage artifact exists"
{ [ -n "$APPIMAGE" ] && [ -x "$APPIMAGE" ]; } && ok "AppImage is executable"   || no "AppImage is executable"
[ -f "$APPDIR/vortex" ]    && ok "main binary 'vortex' present" || no "main binary 'vortex' present"
[ -x "$APPDIR/AppRun" ]    && ok "AppRun present + executable"  || no "AppRun present + executable"
grep -q 'x-scheme-handler/nxm' "$APPDIR/linux-vortex.desktop" 2>/dev/null \
                           && ok "nxm scheme declared in desktop" || no "nxm scheme declared in desktop"
[ -f "$APPDIR/linux-vortex.png" ] && ok "icon present" || no "icon present"

# FOMOD native backend (the fix): .node present, .so co-located, RUNPATH=$ORIGIN, resolves.
if [ -n "$NODE" ]; then
  ok "FOMOD .node present"
  [ -f "$(dirname "$NODE")/ModInstaller.Native.so" ] \
    && ok "ModInstaller.Native.so co-located" || no "ModInstaller.Native.so co-located"
  readelf -d "$NODE" 2>/dev/null | grep -q 'RUNPATH.*ORIGIN' \
    && ok "FOMOD .node RUNPATH = \$ORIGIN" || no "FOMOD .node RUNPATH = \$ORIGIN"
  if ldd "$NODE" 2>/dev/null | grep -q 'ModInstaller.Native.so => not found'; then
    no "FOMOD .node resolves its .so (ldd)"
  else
    ok "FOMOD .node resolves its .so (ldd)"
  fi
else
  no "FOMOD .node present"
fi

# .NET: bundled runtime + dotnetprobe present and actually runnable (the startup fix).
PROBE="$APPDIR/resources/app.asar.unpacked/assets/dotnetprobe"
[ -x "$APPDIR/dotnet/dotnet" ] && ok "bundled .NET runtime present" || no "bundled .NET runtime present"
[ -x "$PROBE" ] && ok "dotnetprobe present + executable" || no "dotnetprobe present + executable"
if [ -x "$PROBE" ] && [ -x "$APPDIR/dotnet/dotnet" ]; then
  if DOTNET_ROOT="$APPDIR/dotnet" "$PROBE" 9 2>/dev/null | grep -q '^Success'; then
    ok "dotnetprobe runs under bundled runtime (exit 0)"
  else
    no "dotnetprobe runs under bundled runtime (exit 0)"
  fi
else
  no "dotnetprobe runs under bundled runtime (exit 0)"
fi

# Linux ini backend: vortex-parse-ini's Win32-only ini backend replaced with the pure-JS
# one (build/patch-linux-ini.cjs), packed inside app.asar.
ASAR="$APPDIR/resources/app.asar"
grep -aq 'NATIVE_INI_FUNCS' "$ASAR" 2>/dev/null \
  && ok "Linux ini backend present in app.asar" || no "Linux ini backend present in app.asar"

# Proton game paths helper (build/patch-linux-game-paths.cjs): present in core (checked by
# its debug-log string, which survives minification), and the converted extensions call it
# through the external vortex-api namespace - a property access, which the extension
# bundler never mangles.
grep -aq 'no Proton prefix found for game' "$ASAR" 2>/dev/null \
  && ok "Proton game paths helper present in app.asar" || no "Proton game paths helper present in app.asar"
# Every extension's util.getVortexPath resolves in its game's prefix: the require hook
# (util/extensionRequire.ts) must call the helper's utilForExtension. A module export, so the
# property name survives minification, and only the call site is followed by "(".
RENDERER="$(mktemp -d)/renderer.js"
python3 "$REPO_ROOT/qa/extract-asar-file.py" "$ASAR" /renderer.js "$RENDERER" >/dev/null 2>&1
grep -q 'utilForExtension)(' "$RENDERER" 2>/dev/null \
  && ok "extensions get Proton game paths (per-extension util)" \
  || no "extensions get Proton game paths (per-extension util)"
W3="$APPDIR/resources/app.asar.unpacked/bundledPlugins/game-witcher3/index.cjs"
# gamebryo-plugin-management is not built on Linux (win32-gated build script; no libloot),
# so check the converted extensions that do ship.
for EXT in gamebryo-savegame-management gamebryo-test-settings local-gamesettings; do
  BUNDLE="$APPDIR/resources/app.asar.unpacked/bundledPlugins/$EXT/index.cjs"
  grep -aq 'getGameDocumentsPath' "$BUNDLE" 2>/dev/null \
    && ok "$EXT resolves My Games through the helper" \
    || no "$EXT resolves My Games through the helper"
done

# Windows tools launched by extensions are routed through Proton
# (build/patch-linux-proton-tools.cjs).
grep -aq 'running Windows executable through Proton' "$ASAR" 2>/dev/null \
  && ok "api.runExecutable routes Windows tools through Proton" \
  || no "api.runExecutable routes Windows tools through Proton"
grep -aq 'Could not read compatdata config_info' "$ASAR" 2>/dev/null \
  && ok "Proton build resolved from the game's prefix" || no "Proton build resolved from the game's prefix"

# Proton routing picks the tool's own game: it matches on the working directory as well as
# the executable path, and on whole folders ("Fallout 4 VR" is not inside "Fallout 4"), for
# api.runExecutable and dashboard launches (qa/test-proton-matching.cjs, run against the
# packaged renderer bundle).
if [ -s "$RENDERER" ] && node "$REPO_ROOT/qa/test-proton-matching.cjs" "$RENDERER" >/dev/null 2>&1; then
  ok "Proton routing picks the tool's own game"
else
  no "Proton routing picks the tool's own game"
fi

# W3 Script Merger is configured with Windows paths, not POSIX ones
# (build/patch-witcher3-scriptmerger-paths.cjs). Handed a POSIX path the merger doesn't
# fail, it merges to a junk folder the game never reads - so this runs the real
# setMergerConfig lifted out of the packaged extension rather than grepping for "Z:".
if node "$REPO_ROOT/qa/test-scriptmerger-paths.cjs" "$W3" >/dev/null 2>&1; then
  ok "script merger configured with Proton (Z:) paths"
else
  no "script merger configured with Proton (Z:) paths"
fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
