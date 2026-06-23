# linvortex AppImage v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a single, self-contained, clearly-unofficial AppImage of Nexus Mods' native Linux Vortex build, from a pinned upstream commit, verified by a smoke-test gate.

**Architecture:** A containerized, reproducible pipeline. Stage 1 (M0) builds the native Vortex app from a pinned `Nexus-Mods/Vortex` commit inside a build container derived from upstream's own devcontainer. Stage 2 (M1) assembles an AppDir from that unpacked app, **bundles a .NET 9 runtime** (needed by the FOMOD installer, which upstream only bundles in its Flatpak), adds a custom `AppRun` (sets `DOTNET_ROOT`, handles the Electron sandbox, and pins the `nxm://` handler to the running AppImage path), and runs `appimagetool`. A smoke harness boots the result headlessly and asserts core behavior before it's considered releasable.

**Tech Stack:** Bash, Podman/Docker (build container), Ubuntu 24.04 base, Node (Volta-pinned) + pnpm + nx (Vortex build), .NET 9 SDK (build) + .NET 9 runtime (bundled), `appimagetool`, `xvfb` (headless QA).

**Scope:** This plan covers **M0 + M1** from the design spec (`docs/superpowers/specs/2026-06-23-linvortex-appimage-distribution-design.md`). M1.1 (scripted QA automation) and M2 (CI) are deliberately **out of scope** here and get their own plans.

**Conventions used in this plan:**
- `$REPO` = `/home/buga/Dev/linvortex` (this repo).
- `$ENGINE` = container engine; default `podman`. Every container command below is written `"${ENGINE:-podman}"`; Docker is a drop-in (`ENGINE=docker`).
- Upstream pinned commit (the SHA verified during brainstorming) lives in `$REPO/pinned-commit`. Value for v1: `4c39bbf9da4a8d65c6c5b9f0734cc38465def3c1`.
- "TDD" here means **verification-first for build/packaging**: define the success check, observe it fail (artifact absent / behavior missing), implement, observe it pass, commit. Pure unit tests are used where there is pure logic (there is little; this is release engineering).

---

## File Structure

Files created by this plan, each with one responsibility:

| Path | Responsibility |
|---|---|
| `pinned-commit` | The exact upstream SHA we build. Single source of truth for provenance/version. |
| `.gitignore` | Exclude build artifacts, the cloned upstream checkout, downloaded runtimes, `*.AppImage`. |
| `README.md` | What linvortex is + prominent **unofficial** notice + how to run the AppImage. |
| `docs/UNOFFICIAL-NOTICE.md` | Full legal/branding disclaimer (GPL source offer, trademark/non-affiliation). |
| `build/Containerfile` | Build image: upstream devcontainer deps + `appimagetool` + xvfb. |
| `build/build-upstream.sh` | Clone Vortex @ `pinned-commit`, install deps, run the nx package build, emit the unpacked Linux app to a known `out/` path, and record the real output path. |
| `appimage/fetch-dotnet-runtime.sh` | Download + verify the .NET 9 **runtime** (linux-x64) into a staging dir. |
| `appimage/AppRun` | AppImage entrypoint: set `DOTNET_ROOT`, Electron sandbox handling, nxm handler path-pinning, exec the app. |
| `appimage/linvortex.desktop` | Desktop entry incl. `MimeType=x-scheme-handler/nxm;` and `%u`. |
| `appimage/build-appimage.sh` | Assemble AppDir from unpacked app + bundled .NET + `AppRun` + desktop + icon; run `appimagetool` → versioned `*.AppImage`. |
| `qa/fixtures/steam/` | Minimal fake Steam library (`libraryfolders.vdf` + a fake game) for discovery testing. |
| `qa/smoke.sh` | Headless smoke gate: boot, nxm registration, fake-Steam discovery, hardlink deploy, FOMOD/.NET host start. |
| `build-all.sh` | Top-level orchestrator: build-upstream → build-appimage → smoke. One command, fail-fast. |

---

## Task 0: Repo scaffolding + unofficial notice

**Files:**
- Create: `$REPO/.gitignore`
- Create: `$REPO/pinned-commit`
- Create: `$REPO/docs/UNOFFICIAL-NOTICE.md`
- Create: `$REPO/README.md`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# Cloned upstream checkout (large; never committed)
/upstream/
# Build outputs
/out/
/dist/
*.AppImage
# Downloaded runtimes / tools
/vendor/
/tools/bin/
# OS / editor noise
.DS_Store
```

- [ ] **Step 2: Create `pinned-commit`** (single line, no trailing text)

```
4c39bbf9da4a8d65c6c5b9f0734cc38465def3c1
```

- [ ] **Step 3: Create `docs/UNOFFICIAL-NOTICE.md`**

```markdown
# Unofficial build notice

linvortex is an **unofficial** redistribution of the Linux build of
[Vortex](https://github.com/Nexus-Mods/Vortex) by Nexus Mods (Black Tree Gaming
Ltd.). It is **not affiliated with, endorsed by, or supported by Nexus Mods.**

- **Source code:** Vortex is licensed GPL-3.0. The exact upstream commit packaged
  by this build is recorded in `pinned-commit`. Corresponding source:
  https://github.com/Nexus-Mods/Vortex/tree/<pinned-commit>. The packaging
  scripts in this repository are part of the corresponding source and are
  GPL-compatible.
- **Trademark:** "Vortex" and Nexus Mods names/logos are property of their owners.
  GPL-3.0 grants no trademark rights. This project is distributed under the name
  **linvortex** and does not represent itself as the official product.
- **Support:** Do **not** file Vortex bugs with Nexus for issues caused by this
  packaging. Use this project's issue tracker. Confirmed upstream bugs are
  reported upstream by this project.
- **Status:** Built from a development/beta upstream branch. Expect rough edges.
```

- [ ] **Step 4: Create `README.md`**

```markdown
# linvortex

An **unofficial**, distro-agnostic **AppImage** of Nexus Mods' native Linux build
of [Vortex](https://github.com/Nexus-Mods/Vortex), for Linux users who want a
no-compile binary. See [`docs/UNOFFICIAL-NOTICE.md`](docs/UNOFFICIAL-NOTICE.md).

> Not affiliated with or endorsed by Nexus Mods. GPL-3.0. Beta quality.

## Run

```bash
chmod +x linvortex-*-x86_64.AppImage
./linvortex-*-x86_64.AppImage
```

## Build from source

```bash
ENGINE=podman ./build-all.sh   # builds upstream, assembles the AppImage, runs smoke QA
```

Requires Podman (or Docker via `ENGINE=docker`). See
`docs/superpowers/plans/2026-06-23-linvortex-appimage-v1.md` for details.
```

- [ ] **Step 5: Commit**

```bash
cd $REPO
git add .gitignore pinned-commit docs/UNOFFICIAL-NOTICE.md README.md
git commit -m "chore: scaffold linvortex repo + unofficial notice"
```

---

## Task 1: Build container (derived from upstream devcontainer)

**Files:**
- Create: `$REPO/build/Containerfile`

The upstream devcontainer (`Nexus-Mods/Vortex:docker/linux/Dockerfile.devcontainer`)
already encodes the correct build deps. We extend it with `appimagetool` (for AppDir
packaging) and `xvfb` (for the headless smoke gate), and bake in Node+pnpm so the
image is build-ready without a `postCreateCommand`.

- [ ] **Step 1: Write `build/Containerfile`**

```dockerfile
# linvortex build image — derived from Vortex's official devcontainer
# (docker/linux/Dockerfile.devcontainer), plus AppImage + headless-QA tooling.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

# Upstream build deps + our additions (xvfb for QA, fuse/file for appimagetool,
# desktop-file-utils + xdg-utils for nxm-handler checks).
RUN apt-get update && apt-get install -y \
    curl git ca-certificates xz-utils file \
    python3 python3-setuptools build-essential \
    libfontconfig1-dev libicu-dev \
    xvfb libfuse2 desktop-file-utils xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# .NET SDK 9.0 (required to build fomod-installer)
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 9.0
ENV DOTNET_ROOT=/root/.dotnet
ENV PATH="${PATH}:${DOTNET_ROOT}:${DOTNET_ROOT}/tools"

# Volta + pinned Node + Corepack/pnpm, baked in (not deferred to postCreate).
ENV VOLTA_HOME=/root/.volta
ENV PATH="${VOLTA_HOME}/bin:${PATH}"
RUN curl https://get.volta.sh | bash -s -- --skip-setup \
    && volta install node@22 yarn@1 \
    && npm install --global corepack@latest \
    && corepack enable

# appimagetool (pinned continuous release; --appimage-extract-and-run avoids needing FUSE in CI)
RUN curl -fsSL -o /usr/local/bin/appimagetool \
      https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage \
    && chmod +x /usr/local/bin/appimagetool

WORKDIR /workspace
```

> NOTE: `node@22` follows upstream `docs/install-instructions/shared.md`. `package.json`
> `engines` says `24.15.0`. If the M0 build (Task 2) rejects Node 22, change this line to
> `node@24` and rebuild the image. The exact pin is **verified, not assumed** in Task 2 Step 4.

- [ ] **Step 2: Build the image**

```bash
cd $REPO
"${ENGINE:-podman}" build -t linvortex-build:latest -f build/Containerfile build/
```
Expected: image builds successfully; final line shows a tag/ID for `linvortex-build:latest`.

- [ ] **Step 3: Sanity-check the toolchain inside the image**

```bash
"${ENGINE:-podman}" run --rm linvortex-build:latest bash -lc \
  'node --version; corepack pnpm --version; dotnet --list-sdks; appimagetool --version 2>&1 | head -1'
```
Expected: a Node version prints, a pnpm version prints, a `9.0.x` SDK is listed, and appimagetool prints a version/usage line (no command-not-found).

- [ ] **Step 4: Commit**

```bash
cd $REPO
git add build/Containerfile
git commit -m "build: add linvortex build container (upstream devcontainer + appimage/qa tooling)"
```

---

## Task 2: Build the native Vortex app (M0 spike → locked script)

This is the **highest-risk task** (upstream build system is mid-migration from yarn to
pnpm/nx). The script is written defensively: it discovers the unpacked-output path rather
than hardcoding a guessed one, and **fails loudly** if zero or multiple candidates are found.

**Files:**
- Create: `$REPO/build/build-upstream.sh`

- [ ] **Step 1: Write `build/build-upstream.sh`**

```bash
#!/usr/bin/env bash
# Clone Vortex @ pinned-commit, build the native Linux app, and stage the unpacked
# app at out/vortex-unpacked/. Runs INSIDE the linvortex-build container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINNED="$(tr -d '[:space:]' < "$REPO_ROOT/pinned-commit")"
SRC="$REPO_ROOT/upstream"
OUT="$REPO_ROOT/out"

echo ">> Pinned upstream commit: $PINNED"
rm -rf "$OUT" && mkdir -p "$OUT"

# 1. Fetch source at the exact pinned commit, with submodules.
if [ ! -d "$SRC/.git" ]; then
  git clone --recurse-submodules https://github.com/Nexus-Mods/Vortex.git "$SRC"
fi
git -C "$SRC" fetch --depth 1 origin "$PINNED"
git -C "$SRC" checkout -q "$PINNED"
git -C "$SRC" submodule update --init --recursive --depth 1

# 2. Install deps + build + package (current upstream flow).
cd "$SRC"
corepack pnpm install --frozen-lockfile
corepack pnpm nx run @vortex/main:package:nosign

# 3. Discover the unpacked Linux app dir (electron-builder output; path not hardcoded
#    because the nx/electron-builder output location is in flux upstream).
mapfile -t CANDIDATES < <(find "$SRC" -type d -name 'linux*unpacked' -not -path '*/node_modules/*' 2>/dev/null)
if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "!! No linux*-unpacked dir found. The build target may emit only a zip." >&2
  echo "!! Searching for a linux zip to extract instead..." >&2
  ZIP="$(find "$SRC" -type f -name '*linux*.zip' -not -path '*/node_modules/*' | head -1 || true)"
  [ -n "$ZIP" ] || { echo "!! No linux app artifact found at all. Build flow changed; inspect $SRC." >&2; exit 1; }
  mkdir -p "$OUT/vortex-unpacked"
  ( cd "$OUT/vortex-unpacked" && unzip -q "$ZIP" )
else
  [ "${#CANDIDATES[@]}" -eq 1 ] || { printf '!! Multiple unpacked dirs:\n%s\n' "${CANDIDATES[@]}" >&2; exit 1; }
  cp -a "${CANDIDATES[0]}/." "$OUT/vortex-unpacked/"
fi

# 4. Record provenance + the located main binary for later stages.
BIN="$(find "$OUT/vortex-unpacked" -maxdepth 1 -type f -name 'vortex' | head -1 || true)"
[ -n "$BIN" ] || BIN="$(find "$OUT/vortex-unpacked" -maxdepth 1 -type f -perm -u+x | head -1)"
echo "$PINNED" > "$OUT/BUILT_FROM"
echo "${BIN#$OUT/vortex-unpacked/}" > "$OUT/MAIN_BINARY"
echo ">> Unpacked app at: $OUT/vortex-unpacked"
echo ">> Main binary (relative): $(cat "$OUT/MAIN_BINARY")"
```

- [ ] **Step 2: Make it executable + write the in-container runner usage**

```bash
cd $REPO
chmod +x build/build-upstream.sh
```

- [ ] **Step 3: Run the build inside the container (the M0 spike)**

```bash
cd $REPO
"${ENGINE:-podman}" run --rm -v "$PWD":/workspace -w /workspace \
  linvortex-build:latest bash -lc './build/build-upstream.sh'
```
Expected: completes with `>> Unpacked app at: .../out/vortex-unpacked` and a non-empty `MAIN_BINARY`. This may take many minutes (large Electron + .NET build).

- [ ] **Step 4: Verify the build output + lock the Node version finding**

```bash
cd $REPO
test -f out/vortex-unpacked/$(cat out/MAIN_BINARY) && echo "MAIN BINARY OK"
find out/vortex-unpacked -name '*.dll' -path '*fomod*' -o -name '*.exe' -path '*fomod*' | head
ls -la out/vortex-unpacked/resources/ 2>/dev/null | head
```
Expected: "MAIN BINARY OK"; the FOMOD installer's `.dll`/`.exe` are present under `resources/` (these are the .NET artifacts that make Task 3 necessary). **If the build failed because of Node version,** update `build/Containerfile` Step 1 to `node@24`, rebuild the image (Task 1 Step 2), and re-run.

- [ ] **Step 5: Commit**

```bash
cd $REPO
git add build/build-upstream.sh
git commit -m "build: clone+build native Vortex from pinned commit into out/vortex-unpacked"
```

> **GO/NO-GO:** If Task 2 cannot produce a runnable unpacked app after reasonable build-flow
> adjustment, STOP and reassess (the build system may have changed incompatibly). Do not
> proceed to packaging a non-existent artifact.

---

## Task 3: Bundle the .NET 9 runtime

The FOMOD installer is a framework-dependent .NET tool. Upstream bundles a runtime only in
its Flatpak. For a self-contained AppImage we vendor a .NET **runtime** (not SDK) into the
AppDir.

**Files:**
- Create: `$REPO/appimage/fetch-dotnet-runtime.sh`

- [ ] **Step 1: Write `appimage/fetch-dotnet-runtime.sh`**

```bash
#!/usr/bin/env bash
# Download the .NET 9 runtime (linux-x64) into vendor/dotnet/. Idempotent.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/vendor/dotnet"

if [ -x "$DEST/dotnet" ]; then echo ">> .NET runtime already present at $DEST"; exit 0; fi
mkdir -p "$DEST"
# dotnet-install.sh places a self-contained runtime tree under --install-dir.
curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 9.0 --runtime dotnet --install-dir "$DEST"
test -x "$DEST/dotnet" || { echo "!! .NET runtime missing after install" >&2; exit 1; }
echo ">> .NET runtime staged at $DEST"
"$DEST/dotnet" --info | head -5
```

- [ ] **Step 2: Make executable + run it (inside the container, for a clean linux-x64 tree)**

```bash
cd $REPO
chmod +x appimage/fetch-dotnet-runtime.sh
"${ENGINE:-podman}" run --rm -v "$PWD":/workspace -w /workspace \
  linvortex-build:latest bash -lc './appimage/fetch-dotnet-runtime.sh'
```
Expected: `>> .NET runtime staged at .../vendor/dotnet`; `dotnet --info` prints a `Microsoft.NETCore.App 9.0.x` runtime.

- [ ] **Step 3: Verify the runtime is a runtime (not SDK) and runs**

```bash
cd $REPO
"${ENGINE:-podman}" run --rm -v "$PWD":/workspace -w /workspace linvortex-build:latest \
  bash -lc './vendor/dotnet/dotnet --list-runtimes'
```
Expected: lists `Microsoft.NETCore.App 9.0.x` (a runtime line); no SDK required.

- [ ] **Step 4: Commit** (the script; `vendor/` is gitignored)

```bash
cd $REPO
git add appimage/fetch-dotnet-runtime.sh
git commit -m "appimage: vendor .NET 9 runtime for self-contained FOMOD installer"
```

---

## Task 4: AppRun entrypoint

`AppRun` is the AppImage's entrypoint. It must: point Vortex's .NET probe at the bundled
runtime (`DOTNET_ROOT`), handle the Electron sandbox (the bundled `chrome-sandbox` needs
root-SUID, which AppImages can't guarantee → fall back to `--no-sandbox`), and repair the
`nxm://` handler to point at the *current* AppImage path (AppImages are movable).

**Files:**
- Create: `$REPO/appimage/AppRun`

- [ ] **Step 1: Write `appimage/AppRun`**

```bash
#!/usr/bin/env bash
# linvortex AppImage entrypoint.
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"

# 1. Bundled .NET runtime for the FOMOD installer.
export DOTNET_ROOT="$HERE/usr/lib/dotnet"
export PATH="$DOTNET_ROOT:$PATH"
# Vortex's dotnetprobe also respects an explicit hint if DOTNET_ROOT isn't picked up:
export VORTEX_DOTNET_ROOT="$DOTNET_ROOT"

# 2. Re-pin the nxm:// handler to THIS AppImage on every launch (AppImages move).
#    $APPIMAGE is set by the AppImage runtime to the absolute path of the running image.
if [ -n "${APPIMAGE:-}" ] && command -v xdg-mime >/dev/null 2>&1; then
  DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$DESKTOP_DIR"
  sed "s|@APPIMAGE@|$APPIMAGE|g" "$HERE/linvortex.desktop" > "$DESKTOP_DIR/linvortex.desktop"
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  xdg-mime default linvortex.desktop x-scheme-handler/nxm >/dev/null 2>&1 || true
fi

# 3. Electron sandbox: a bundled chrome-sandbox needs SUID-root, which an AppImage cannot
#    guarantee. If it's not correctly owned, disable the sandbox to stay runnable.
MAIN="$HERE/usr/lib/vortex/$(cat "$HERE/usr/lib/vortex/.main-binary")"
SANDBOX="$HERE/usr/lib/vortex/chrome-sandbox"
SANDBOX_ARG=""
if [ ! -u "$SANDBOX" ] 2>/dev/null; then SANDBOX_ARG="--no-sandbox"; fi

exec "$MAIN" $SANDBOX_ARG "$@"
```

- [ ] **Step 2: Make executable**

```bash
cd $REPO
chmod +x appimage/AppRun
```

- [ ] **Step 3: Commit**

```bash
cd $REPO
git add appimage/AppRun
git commit -m "appimage: AppRun with DOTNET_ROOT, sandbox fallback, nxm re-pinning"
```

---

## Task 5: Desktop entry + AppImage assembly

**Files:**
- Create: `$REPO/appimage/linvortex.desktop`
- Create: `$REPO/appimage/build-appimage.sh`

- [ ] **Step 1: Write `appimage/linvortex.desktop`** (note `@APPIMAGE@` placeholder, substituted at runtime by AppRun, and at packaging time for the in-AppDir copy)

```ini
[Desktop Entry]
Type=Application
Name=linvortex (unofficial Vortex)
Comment=Unofficial AppImage of Nexus Mods' Vortex mod manager
Exec=@APPIMAGE@ %u
Icon=linvortex
Categories=Network;Game;Utility;
Terminal=false
MimeType=x-scheme-handler/nxm;
```

- [ ] **Step 2: Write `appimage/build-appimage.sh`**

```bash
#!/usr/bin/env bash
# Assemble AppDir from out/vortex-unpacked + vendored .NET, then appimagetool it.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO_ROOT/out"
APPDIR="$OUT/AppDir"
APP="$OUT/vortex-unpacked"
DOTNET="$REPO_ROOT/vendor/dotnet"

test -d "$APP" || { echo "!! Missing $APP — run build-upstream.sh first" >&2; exit 1; }
test -x "$DOTNET/dotnet" || { echo "!! Missing vendored .NET — run fetch-dotnet-runtime.sh" >&2; exit 1; }

PINNED="$(tr -d '[:space:]' < "$REPO_ROOT/pinned-commit")"
SHORT="${PINNED:0:7}"
DATE="$(date +%Y%m%d)"   # NOTE: executor stamps this at run time; not reproducible-pinned.

rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib/vortex" "$APPDIR/usr/lib/dotnet" "$APPDIR/usr/share/icons/hicolor/256x256/apps"

# App payload
cp -a "$APP/." "$APPDIR/usr/lib/vortex/"
cp -a "$OUT/MAIN_BINARY" "$APPDIR/usr/lib/vortex/.main-binary"
# .NET runtime
cp -a "$DOTNET/." "$APPDIR/usr/lib/dotnet/"
# AppRun + desktop + icon
install -m755 "$REPO_ROOT/appimage/AppRun" "$APPDIR/AppRun"
sed 's|@APPIMAGE@|linvortex|g' "$REPO_ROOT/appimage/linvortex.desktop" > "$APPDIR/linvortex.desktop"
cp "$REPO_ROOT/appimage/linvortex.desktop" "$APPDIR/linvortex.desktop.template"
ICON_SRC="$(find "$APP" -name 'vortex.png' | head -1 || true)"
[ -n "$ICON_SRC" ] && cp "$ICON_SRC" "$APPDIR/usr/share/icons/hicolor/256x256/apps/linvortex.png" \
                   && cp "$ICON_SRC" "$APPDIR/linvortex.png"

OUTFILE="$OUT/linvortex-${DATE}-g${SHORT}-x86_64.AppImage"
ARCH=x86_64 appimagetool --appimage-extract-and-run "$APPDIR" "$OUTFILE"
echo ">> Built: $OUTFILE"
```

- [ ] **Step 3: Make executable + run inside the container**

```bash
cd $REPO
chmod +x appimage/build-appimage.sh
"${ENGINE:-podman}" run --rm -v "$PWD":/workspace -w /workspace \
  linvortex-build:latest bash -lc './appimage/build-appimage.sh'
```
Expected: `>> Built: .../out/linvortex-<date>-g4c39bbf-x86_64.AppImage`.

- [ ] **Step 4: Verify the artifact exists, is executable, and is self-describing**

```bash
cd $REPO
ls -la out/linvortex-*-x86_64.AppImage
file out/linvortex-*-x86_64.AppImage
```
Expected: a multi-hundred-MB ELF/AppImage file; `file` reports an executable.

- [ ] **Step 5: Commit**

```bash
cd $REPO
git add appimage/linvortex.desktop appimage/build-appimage.sh
git commit -m "appimage: assemble AppDir (app + bundled .NET) and package via appimagetool"
```

---

## Task 6: Headless smoke gate

Verifies the AppImage actually works before it's considered releasable. Each check is an
assertion; any failure exits non-zero (gate fails → no release).

**Files:**
- Create: `$REPO/qa/fixtures/steam/config/libraryfolders.vdf`
- Create: `$REPO/qa/fixtures/steam/steamapps/common/FakeGame/.keep`
- Create: `$REPO/qa/smoke.sh`

- [ ] **Step 1: Write the fake Steam fixture** `qa/fixtures/steam/config/libraryfolders.vdf`

```
"libraryfolders"
{
	"0"
	{
		"path"		"@STEAMROOT@"
		"apps"
		{
			"480"		"1000000"
		}
	}
}
```
And create the placeholder game dir file `qa/fixtures/steam/steamapps/common/FakeGame/.keep` (empty).

- [ ] **Step 2: Write `qa/smoke.sh`**

```bash
#!/usr/bin/env bash
# Headless smoke gate for the built AppImage. Run inside the build container (has xvfb).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE="$(ls "$REPO_ROOT"/out/linvortex-*-x86_64.AppImage | head -1)"
test -n "$APPIMAGE" || { echo "!! No AppImage to test" >&2; exit 1; }
chmod +x "$APPIMAGE"

PASS=0; FAIL=0
check(){ if eval "$2"; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1"; FAIL=$((FAIL+1)); fi; }

# Extract once for static structural checks (no GUI needed).
WORK="$(mktemp -d)"; cd "$WORK"
"$APPIMAGE" --appimage-extract >/dev/null
SQ='squashfs-root'

# 1. Bundled .NET runtime present and runnable.
check ".NET runtime bundled" "[ -x $SQ/usr/lib/dotnet/dotnet ] && $SQ/usr/lib/dotnet/dotnet --list-runtimes | grep -q 'NETCore.App 9'"
# 2. FOMOD installer .NET artifacts shipped.
check "FOMOD installer present" "find $SQ/usr/lib/vortex -iname '*fomod*' | grep -q ."
# 3. Desktop entry registers the nxm scheme.
check "nxm mimetype declared" "grep -q 'x-scheme-handler/nxm' $SQ/linvortex.desktop"
# 4. Main binary resolvable from AppRun's pointer.
check "main binary present" "[ -f $SQ/usr/lib/vortex/\$(cat $SQ/usr/lib/vortex/.main-binary) ]"

# 5. App boots headlessly to an Electron process (GUI smoke).
export HOME="$WORK/home"; mkdir -p "$HOME"
# Point fixture's STEAMROOT at our temp library so discovery has something to find.
STEAMROOT="$WORK/home/.local/share/Steam"
mkdir -p "$STEAMROOT/config" "$STEAMROOT/steamapps/common/FakeGame"
sed "s|@STEAMROOT@|$STEAMROOT|g" "$REPO_ROOT/qa/fixtures/steam/config/libraryfolders.vdf" > "$STEAMROOT/config/libraryfolders.vdf"
set +e
timeout 60 xvfb-run -a "$APPIMAGE" --no-sandbox >"$WORK/boot.log" 2>&1 &
APP_PID=$!
sleep 35
pgrep -f 'usr/lib/vortex' >/dev/null; BOOTED=$?
kill "$APP_PID" 2>/dev/null; pkill -f 'usr/lib/vortex' 2>/dev/null
set -e
check "app booted under xvfb" "[ $BOOTED -eq 0 ]"
check "no fatal error in boot log" "! grep -qiE 'cannot find module|segfault|FATAL' $WORK/boot.log"

echo "----"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

> NOTE on coverage: checks 1–4 are static and deterministic. Check 5 is a best-effort GUI
> boot (Electron headless boots are timing-sensitive). Deep behavioral checks (actual nxm
> handoff, real hardlink deploy into a game, FOMOD running an install) require a real
> desktop session and a real mod; those are **manual M1 acceptance** (Task 7) and become
> automated in the M1.1 plan.

- [ ] **Step 3: Make executable + run the gate**

```bash
cd $REPO
chmod +x qa/smoke.sh
"${ENGINE:-podman}" run --rm -v "$PWD":/workspace -w /workspace \
  linvortex-build:latest bash -lc './qa/smoke.sh'
```
Expected: ends with `PASS=6 FAIL=0` and exit code 0.

- [ ] **Step 4: Commit**

```bash
cd $REPO
git add qa/fixtures qa/smoke.sh
git commit -m "qa: headless smoke gate (dotnet bundle, fomod, nxm, boot)"
```

---

## Task 7: Orchestrator + manual acceptance + first release

**Files:**
- Create: `$REPO/build-all.sh`

- [ ] **Step 1: Write `build-all.sh`**

```bash
#!/usr/bin/env bash
# One-command pipeline: build upstream -> fetch dotnet -> assemble AppImage -> smoke gate.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="${ENGINE:-podman}"
IMG=linvortex-build:latest

"$ENGINE" build -t "$IMG" -f build/Containerfile build/
run(){ "$ENGINE" run --rm -v "$REPO_ROOT":/workspace -w /workspace "$IMG" bash -lc "$1"; }

run './build/build-upstream.sh'
run './appimage/fetch-dotnet-runtime.sh'
run './appimage/build-appimage.sh'
run './qa/smoke.sh'

echo ">> SUCCESS:"; ls -la "$REPO_ROOT"/out/linvortex-*-x86_64.AppImage
```

- [ ] **Step 2: Make executable + run the full pipeline end to end**

```bash
cd $REPO
chmod +x build-all.sh
ENGINE="${ENGINE:-podman}" ./build-all.sh
```
Expected: image builds, all four stages pass, smoke gate prints `FAIL=0`, and a single `out/linvortex-*-x86_64.AppImage` is listed under `>> SUCCESS:`.

- [ ] **Step 3: Manual acceptance on the real desktop (CachyOS)** — record results in the commit message

Run the AppImage directly (not in a container) and verify by hand:
```bash
cd $REPO
./out/linvortex-*-x86_64.AppImage
```
Acceptance checklist (note pass/fail for each):
1. Window opens to the Vortex UI.
2. A Steam-installed game is auto-detected (or "Add Search Directory" finds one).
3. After launch, `xdg-mime query default x-scheme-handler/nxm` returns `linvortex.desktop`.
4. Clicking "Download with Manager" on a nexusmods.com mod page hands off to this app.
5. Deploying a mod into a game on the **same partition** succeeds via hardlink.
6. A FOMOD-based mod opens the FOMOD installer dialog (validates the bundled .NET).

- [ ] **Step 4: Commit the orchestrator + acceptance notes**

```bash
cd $REPO
git add build-all.sh
git commit -m "build: one-command pipeline (build->appimage->smoke)

Manual acceptance on CachyOS:
- [x/ ] window opens
- [x/ ] steam game detected
- [x/ ] nxm handler registered
- [x/ ] download-with-manager handoff
- [x/ ] hardlink deploy on same partition
- [x/ ] FOMOD installer opens"
```

- [ ] **Step 5: Tag + draft the unofficial release** (only if all acceptance items pass)

```bash
cd $REPO
PINNED="$(cat pinned-commit)"; SHORT="${PINNED:0:7}"
git tag -a "v0.1.0-g${SHORT}" -m "linvortex v0.1.0 (unofficial) — Vortex @ ${PINNED}"
```
Release notes draft (paste into the GitHub Release body when publishing):
```
linvortex v0.1.0 — UNOFFICIAL build of Vortex (Nexus Mods), packaged as an AppImage.
Not affiliated with or endorsed by Nexus Mods. GPL-3.0. Beta quality.

Upstream commit: <PINNED>
Source: https://github.com/Nexus-Mods/Vortex/tree/<PINNED>
See docs/UNOFFICIAL-NOTICE.md for licensing/trademark details.

Known limitations: x86_64 only; built from an upstream development branch.
Report packaging issues here; confirmed Vortex bugs are reported upstream.
```

> Publishing the GitHub Release (uploading the `.AppImage` asset) is an explicit,
> outward-facing step — do it only on the user's go-ahead.

---

## Self-Review (against the spec)

**Spec coverage:**
- §4(A) AppImage packaging → Tasks 4–5. ✓
- §4(B) bundle .NET runtime → Task 3 + AppRun `DOTNET_ROOT` (Task 4) + smoke check (Task 6). ✓
- §5 pipeline stages 1–6 → Tasks 2 (source/build), 3 (.NET), 5 (assembly), 6 (QA gate), 7 (publish). ✓
- §6 nxm path-pinning → AppRun re-pin logic (Task 4) + desktop `@APPIMAGE@` (Task 5) + manual check (Task 7). ✓
- §7 versioning anchored to SHA → `pinned-commit` (Task 0), filename + tag use short SHA (Tasks 5, 7). ✓ (NOTE: build date is stamped at run time, so the AppImage is provenance-pinned but not byte-reproducible; full reproducibility is a future concern, flagged here, not silently dropped.)
- §8 branding/legal → `docs/UNOFFICIAL-NOTICE.md` + README (Task 0) + release notes (Task 7). ✓
- §11 risks: build drift → defensive output discovery + GO/NO-GO (Task 2); .NET → Task 3 + smoke; sandbox → AppRun fallback; trademark → Task 0. ✓
- Out of scope (correctly deferred): §5 CI automation, full behavioral QA automation → M1.1/M2 plans.

**Placeholder scan:** No "TBD/TODO/implement later". `@APPIMAGE@`/`@STEAMROOT@`/`<PINNED>` are intentional substitution tokens with defined substitution points, not placeholders. The `node@22` vs `node@24` question is resolved by an explicit verify-and-switch step (Task 2 Step 4), not left open.

**Type/name consistency:** `out/vortex-unpacked`, `out/MAIN_BINARY`, `.main-binary`, `vendor/dotnet`, `usr/lib/vortex`, `usr/lib/dotnet`, `linvortex.desktop` are used consistently across Tasks 2→7. AppRun reads `.main-binary`; build-appimage writes it. ✓

**Known honest gaps (called out, not hidden):**
- Exact upstream build command (`nx run @vortex/main:package:nosign`) and output path are verified-at-runtime, not assumed — the script discovers the path and fails loudly on surprise.
- Vortex's `.NET` probe env var name (`VORTEX_DOTNET_ROOT`) is set defensively alongside `DOTNET_ROOT`; Task 7 Step 3 item 6 is the real proof it works. If FOMOD fails to start, the probe mechanism must be re-inspected in `tools/dotnetprobe` / `installer_dotnet`.
