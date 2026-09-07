# linux-vortex — As-Built Notes (M0 + M1, executed 2026-06-23)

What actually shipped, and where it deviated from the original design and plan and why
(the brainstorming spec and implementation plan are kept internal, not in this repo). This
file is the source of truth for the *built* result.

## Deliverable

- **`out/linux-vortex-<date>-g<shortSHA>-x86_64.AppImage`** (~219 MB), built from
  upstream `Nexus-Mods/Vortex` at the commit in `pinned-commit`, which is the release
  tag recorded in `pinned-version`.
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

## Linux ini fix (2026-09-06)

Everything in Vortex that reads or writes an `.ini` file was broken on Linux.
`winapi-bindings/index.js` short-circuits to `module.exports = {}` on any non-`win32`
platform, and `vortex-parse-ini` ships exactly one backend — `WinapiFormat`, which calls
`winapi.GetPrivateProfileSectionNames` / `GetPrivateProfileSection` /
`WritePrivateProfileString` unconditionally. So every ini operation threw
`TypeError: winapi.GetPrivateProfileSectionNames is not a function`.

Reported as: Witcher 3 spraying "Failed to load INI structure" + "Failed to modify load
order file" on every mod enable/disable — every deploy calls `writeToModSettings()`, which
truncates `mods.settings`, then throws before rewriting it, so the load order file was left
at 0 bytes. Ten bundled extensions use the same backend (witcher3, morrowind + morrowind
plugin management, both gamebryo ini extensions, bepinex, mo-import, sims4, msfs,
vtmbloodlines) plus Vortex core's own game-settings handling.

`build/patch-linux-ini.cjs` installs `build/patches/vortex-parse-ini/WinapiFormat.js` into
the packaged dependency tree: the Windows code path is unchanged, and when the native
profile functions are absent it falls back to a pure-JS implementation with Win32 profile
semantics (case-insensitive lookup, first occurrence wins, per-key edits that preserve
comments/order/unrelated sections, encoding and line endings kept). The patch refuses to
apply unless upstream's backend still hashes to the reviewed version, so a dependency bump
fails the build instead of silently dropping the fix. `qa/test-linux-ini.cjs` (8 cases,
run in the build) exercises it through the real `IniParser`/`IniFile` API, including the
Witcher 3 enable/disable sequence.

## Witcher 3 Proton documents fix (2026-09-06)

The Witcher 3 has no native Linux build; it runs in a Steam Proton prefix and reads its
`Documents` folder from *inside* that prefix. Upstream's extension uses
`util.getVortexPath('documents')`, i.e. `~/Documents` on Linux, so `mods.settings` and the
`witcher3menumoddocuments` mod type were written where the game never looks — mod priority
and enable/disable flags had no in-game effect (mods still loaded, because deployment puts
them in `<game>/Mods` and the game defaults to loading everything there).

`build/patch-witcher3-proton-docs.cjs` rewrites the extension's two documents-path helpers
to resolve `<library>/steamapps/compatdata/<appid>/pfx/drive_c/users/<user>/Documents` from
the discovered game path (app ids 292030 and 499450; `steamuser` then `$USER`), falling
back to Vortex's documents path on Windows or when no prefix is found — so GOG/Epic/Heroic
installs keep the old behaviour. Note that menu mods deployed to the old `~/Documents`
location before this change are orphaned there and need removing by hand.

## Windows tools through Proton (2026-09-06)

Vortex already runs Windows executables on Linux: `StarterInfo.runDirectly` calls
`shouldRunWithProton()` and hands off to `Steam.runToolWithProton()`, which runs
`<proton>/proton run <exe>` in the game's compatibility prefix. But extensions that call
`api.runExecutable()` directly bypass all of it — among the bundled ones, `game-witcher3`
(the script merger's "Run tool" notification action, `eventHandlers.ts:runScriptMerger`),
`fnis-integration` and `gamestore-gog`, plus most community game extensions. Spawning a PE
binary on Linux fails with `EACCES`, which Vortex renders as
"Network connect was not permitted, please check your firewall settings".

`build/patch-linux-proton-tools.cjs` makes two source changes:

1. **`ExtensionManager.ts`** — `api.runExecutable` applies the same Proton routing: on
   non-Windows, if the executable is a Windows one and lives inside a Steam game folder that
   has a compatdata prefix, it goes through `Steam.runToolWithProton`. No recursion — the
   Proton launcher isn't a Windows executable. Note this deliberately does *not* require the
   discovery `store` field that `shouldRunWithProton` checks; the executable sitting inside a
   Steam game folder is the actual evidence.
2. **`util/linux/proton.ts`** — when Steam has no `CompatToolMapping` entry for the game
   (i.e. it's on the default), prefer the Proton build recorded in the prefix's own
   `compatdata/<appid>/config_info` over "newest installed". Running a different build against
   a prefix makes Proton upgrade or downgrade it behind the user's back.

Verified by hand before building: `STEAM_COMPAT_DATA_PATH=… STEAM_COMPAT_CLIENT_INSTALL_PATH=…
"<proton>/proton" run WitcherScriptMerger.exe` starts the merger (Proton bundles wine-mono,
so the .NET tool runs). The wine-based `extras/patch-re-fluffy.cjs` workaround is superseded
by this for Steam/Proton games, though it remains valid for non-Steam installs.

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

- ~~Report the FOMOD RUNPATH/.so packaging bug upstream.~~ Filed 2026-06-24 as
  [Nexus-Mods/Vortex#23565](https://github.com/Nexus-Mods/Vortex/issues/23565); no upstream
  response as of 2026-09-06. Further fixes are carried downstream, not reported upstream.
- ~~Real-game acceptance pass.~~ Done: The Witcher 3 and RE Requiem verified on CachyOS.
- ~~Decide distribution.~~ Done: pushing a `v*` tag publishes the AppImage to Releases.
- `.github/workflows/upstream-bump.yml` checks daily for a new upstream *release* and opens
  a bump PR, building it in the same run and commenting the verdict. Bumps track the release
  tag, not `master`, which has diverged from the release line.
- A bump PR is never merged on green alone: the smoke gate is static, so the AppImage
  artifact gets a host pass (launch, scripted FOMOD install, `nxm://`, deploy) first.
- The anchors in all three `build/patch-*.cjs` scripts and the ini backend's sha256 guard
  hard-fail the build by design. On a bump that means a red PR, which is the point - do not
  loosen a guard to make one pass.
