# linvortex — As-Built Notes (M0 + M1, executed 2026-06-23)

What actually shipped, and where it deviated from the spec/plan and why. The spec
(`docs/superpowers/specs/2026-06-23-...`) and plan (`docs/superpowers/plans/2026-06-23-...`)
capture the *intended* design; this file is the source of truth for the *built* result.

## Deliverable

- **`out/linvortex-<date>-g<shortSHA>-x86_64.AppImage`** (~219 MB), built from
  upstream `Nexus-Mods/Vortex` @ `4c39bbf` (pinned in `pinned-commit`).
- Build it: `ENGINE=docker ./build-all.sh`
- Run it: `./out/linvortex-*-x86_64.AppImage --appimage-extract-and-run`

## Pipeline (as built)

`build-all.sh` → 1) `docker build` the image (`build/Containerfile`) →
2) `build/build-upstream.sh` (native Vortex build) → 3) `appimage/build-appimage.sh`
(AppDir + AppImage) → 4) `qa/smoke.sh` (static gate, 10 checks).

## Deviations from the plan, with rationale

1. **.NET runtime bundling DROPPED (plan Task 3 removed).** The plan assumed the FOMOD
   installer needed a bundled .NET runtime at runtime. Inspection showed the Linux FOMOD
   backend is `fomod-installer-native` — a **NativeAOT** `.node` whose `ModInstaller.Native.so`
   links only `libstdc++`/`libgcc`/`libc` (no coreclr/hostfxr). .NET 9 is a **build-only**
   dependency. The framework-dependent `-ipc` variant (`ModInstallerIPC` + `.runtimeconfig.json`)
   is not the Linux path. So no ~80 MB .NET runtime is shipped.

2. **Build command: NOT upstream's `package:nosign` wrapper.** That wrapper runs
   `nx run-many -t build lint typecheck` concurrently across 151 projects, which OOM-killed
   the ~8 GiB Docker Desktop VM (eslint `--concurrency auto` = one worker per CPU; webpack +
   many parallel `tsc`). `build-upstream.sh` instead runs only what packaging needs —
   `nx run-many -t build --parallel=1` + `assets` + `nx run @vortex/main:package:nosign` —
   skipping lint/typecheck and forcing serial tasks.

3. **Heavy I/O on a persistent Docker named volume**, not the bind mount. `node_modules`
   over Docker Desktop's virtiofs bind mount is pathologically slow, so the clone + install +
   build live in the `linvortex-build-cache` volume; only the unpacked app is copied to `out/`.

4. **AppDir layout: app-at-root** (electron-builder convention: `vortex` + `resources/` at
   AppDir root), not the `usr/lib/vortex` nesting the plan sketched.

5. **Smoke test is static + in-container; GUI boot is host-side.** The build container has no
   Electron GUI runtime libs, so `qa/smoke.sh` does deterministic structural checks (incl. the
   FOMOD `ldd` resolution). The window-boot was verified on the CachyOS host.

## FOMOD fix (the real engineering)

Upstream ships the FOMOD native `.node` with an **absolute build-tree `RUNPATH`**
(`/build/upstream/...`, dead on a user's machine) and **omits its `ModInstaller.Native.so`**
from the package. `build-appimage.sh` injects the `.so` next to the `.node` and rewrites
`RUNPATH=$ORIGIN` via `patchelf`. This is an upstream packaging bug — see
`docs/upstream-fomod-runpath-bug.md`.

## Verification (2026-06-23, CachyOS host)

- ✅ Image builds; toolchain present (node 22.23, pnpm 11.9, .NET SDK 9.0.315, appimagetool, patchelf).
- ✅ Native build succeeds → `out/vortex-unpacked` (740 MB, binary `vortex`).
- ✅ AppImage assembles (219 MB).
- ✅ **Boots and renders a window** on the host (native Wayland/X).
- ✅ **`nxm://` handler registers** (`xdg-mime` → `linvortex.desktop`, Exec re-pinned to `$APPIMAGE %u`).
- ✅ **FOMOD native lib resolves** (`ldd`, `RUNPATH=$ORIGIN`, `.so` co-located). Smoke 10/10.

## Known limitations / not yet verified

- Not exercised on a real game: **game auto-detection**, **actual hardlink mod deploy**
  (same-partition), a **real FOMOD-scripted install**, **one-click `nxm://` from a browser**.
- Cosmetic Wayland warnings (Vulkan/color-management); consider `--ozone-platform-hint=auto`.
- `loot` native module failed to build during install (non-fatal; LOOT plugin sorting may be
  unavailable). Not investigated.
- x86_64 only; built from an upstream development branch (beta quality).

## Follow-ups

- Report the FOMOD RUNPATH/.so packaging bug upstream.
- Real-game acceptance pass.
- Decide distribution (GitHub Release of the AppImage) — outward-facing, not yet done.
