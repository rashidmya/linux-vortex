#!/usr/bin/env bash
# One-command pipeline: build image -> build native Vortex -> assemble AppImage -> smoke.
# Requires Docker (default) or Podman via ENGINE=podman.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${ENGINE:-docker}"
IMG=linvortex-build:latest
VOL=linvortex-build-cache

echo ">> [1/4] build image"
"$ENGINE" build -t "$IMG" -f build/Containerfile build/
"$ENGINE" volume create "$VOL" >/dev/null

run(){ "$ENGINE" run --rm -v "$REPO_ROOT":/workspace -v "$VOL":/build -w /workspace "$IMG" bash -lc "$1"; }

echo ">> [2/4] build native Vortex (pinned commit)"; run 'bash ./build/build-upstream.sh'
echo ">> [3/4] assemble AppImage";                   run 'bash ./appimage/build-appimage.sh'
echo ">> [4/4] smoke (static checks)";               run 'bash ./qa/smoke.sh'

echo
echo ">> SUCCESS:"
ls -la "$REPO_ROOT"/out/linvortex-*-x86_64.AppImage
echo
echo "GUI boot is verified on the HOST (the build container lacks Electron runtime libs):"
echo "  ./out/linvortex-*-x86_64.AppImage --appimage-extract-and-run   # (host needs FUSE3; or fuse2)"
echo "  # or run the extracted payload directly:  ./out/AppDir/vortex --no-sandbox"
