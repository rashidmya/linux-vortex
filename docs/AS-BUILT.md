# linux-vortex — As-Built Notes (M0 + M1, executed 2026-06-23)

What actually shipped, and where it deviated from the original design and plan and why
(the brainstorming spec and implementation plan are kept internal, not in this repo). This
file is the source of truth for the *built* result.

## Deliverable

- **`out/linux-vortex-<date>-g<shortSHA>-x86_64.AppImage`** (~219 MB), built from
  upstream `Nexus-Mods/Vortex` @ `4c39bbf` (pinned in `pinned-commit`).
- Build it: `ENGINE=docker ./build-all.sh`
- Run it: `./out/linux-vortex-*-x86_64.AppImage --appimage-extract-and-run`

## Pipeline (as built)

`build-all.sh` → 1) `docker build` the image (`build/Containerfile`) →
2) `build/build-upstream.sh` (native Vortex build) → 3) `appimage/build-appimage.sh`
(AppDir + AppImage) → 4) `qa/smoke.sh` (static gate, 10 checks).

## Deviations from the plan, with rationale

1. **.NET runtime IS bundled — but for `dotnetprobe`, not FOMOD.** FOMOD's Linux backend
   is `fomod-installer-native` (NativeAOT `.node` linking only `libstdc++`/`libgcc`/`libc` —
   no .NET runtime needed). *However*, Vortex spawns a framework-dependent `dotnetprobe` at
   startup and treats missing/failing .NET as **fatal**. So the AppImage bundles the .NET 9
   runtime (`AppDir/dotnet`, ~30 MB compressed), ships `dotnetprobe` into
   `resources/app.asar.unpacked/assets/`, and `AppRun` sets `DOTNET_ROOT` → the probe reports
   `Success: Found .NET 9.x`. (The plan's Task 3 was first dropped on the FOMOD analysis, then
   reinstated when real-machine testing surfaced the probe crash.)

2. **Build command: NOT upstream's `package:nosign` wrapper.** That wrapper runs
   `nx run-many -t build lint typecheck` concurrently across 151 projects, which OOM-killed
   the ~8 GiB Docker Desktop VM (eslint `--concurrency auto` = one worker per CPU; webpack +
   many parallel `tsc`). `build-upstream.sh` instead runs only what packaging needs —
   `nx run-many -t build --parallel=1` + `assets` + `nx run @vortex/main:package:nosign` —
   skipping lint/typecheck and forcing serial tasks.

3. **Heavy I/O on a persistent Docker named volume**, not the bind mount. `node_modules`
   over Docker Desktop's virtiofs bind mount is pathologically slow, so the clone + install +
   build live in the `linux-vortex-build-cache` volume; only the unpacked app is copied to `out/`.

4. **AppDir layout: app-at-root** (electron-builder convention: `vortex` + `resources/` at
   AppDir root), not the `usr/lib/vortex` nesting the plan sketched.

5. **Smoke test is static + in-container; GUI boot is host-side.** The build container has no
   Electron GUI runtime libs, so `qa/smoke.sh` does deterministic structural checks (incl. the
   FOMOD `ldd` resolution). The window-boot was verified on the CachyOS host.

## FOMOD fix (the real engineering)

Upstream ships the FOMOD native `.node` with an **absolute build-tree `RUNPATH`**
(`/build/upstream/...`, dead on a user's machine) and **omits its `ModInstaller.Native.so`**
from the package. `build-appimage.sh` injects the `.so` next to the `.node` and rewrites
`RUNPATH=$ORIGIN` via `patchelf`. This is an upstream packaging bug, reported at
https://github.com/Nexus-Mods/Vortex/issues/23565.

## Verification (2026-06-23, CachyOS host)

- ✅ Image builds; toolchain present (node 22.23, pnpm 11.9, .NET SDK 9.0.315, appimagetool, patchelf).
- ✅ Native build succeeds → `out/vortex-unpacked` (740 MB, binary `vortex`).
- ✅ AppImage assembles (219 MB).
- ✅ **Boots and renders a window** on the host (native Wayland/X).
- ✅ **`nxm://` handler registers** (`xdg-mime` → `linux-vortex.desktop`, Exec re-pinned to `$APPIMAGE %u`).
- ✅ **FOMOD native lib resolves** (`ldd`, `RUNPATH=$ORIGIN`, `.so` co-located). Smoke 10/10.

## Known limitations — real-machine testing (2026-06-23), mostly UPSTREAM gaps

The native build is a Nexus **development build**, SteamOS-scoped; its Linux port is
incomplete. Confirmed from `~/.config/Vortex/vortex.log` on CachyOS:

- **Game detection is partial.** Steam scanning *works* (`found steam install folders
  ["~/.local/share/Steam"]`, found Team Fortress 2). But many game-support plugins throw
  **`"Currently only discovered on windows"`** (dragonage2, witcher/witcher2, sims3/4, nwn,
  neverwinter2, worldoftanks, …) and others call **`winapi.RegGetValue`** (registry, stubbed
  on Linux) or hit `findByAppId` gaps on GOG/Epic/Xbox stores. These need upstream code, not
  packaging.
- **Bethesda load-order (`gamebryo-plugin-management`) fails to load.** It depends on the
  `loot` native module, whose `libloot` C++ library is not built/available for Linux
  (`ld: cannot find -l../loot_api/libloot`). Upstream gap; a downstream fix would mean
  building libloot for Linux.
- **Fixed (ours):** the fatal `dotnetprobe ENOENT` startup crash — see deviation #1.
- Cosmetic Wayland warnings (Vulkan/color-management); consider `--ozone-platform-hint=auto`.
- Still not exercised on a real game: hardlink mod **deploy** (same-partition), a real
  **FOMOD-scripted install**, one-click **`nxm://`** from a browser.
- x86_64 only; upstream development branch (beta).

## Follow-ups

- Report the FOMOD RUNPATH/.so packaging bug upstream.
- Real-game acceptance pass.
- Decide distribution (GitHub Release of the AppImage) — outward-facing, not yet done.
