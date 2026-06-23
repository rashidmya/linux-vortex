#!/usr/bin/env bash
# Download the .NET 9 runtime (linux-x64) into vendor/dotnet/. Idempotent.
# Vortex spawns a framework-dependent `dotnetprobe` at startup and treats a missing/
# failing .NET as a FATAL error, so the AppImage bundles this runtime and points
# DOTNET_ROOT at it (see appimage/AppRun). (FOMOD's native backend is NativeAOT and
# does NOT need this; the probe does.)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/vendor/dotnet"

if [ -x "$DEST/dotnet" ]; then
  echo ">> .NET runtime already present at $DEST"
  "$DEST/dotnet" --list-runtimes
  exit 0
fi

mkdir -p "$DEST"
curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 9.0 --runtime dotnet --install-dir "$DEST"

test -x "$DEST/dotnet" || { echo "!! .NET runtime missing after install" >&2; exit 1; }
echo ">> .NET runtime staged at $DEST"
"$DEST/dotnet" --list-runtimes
