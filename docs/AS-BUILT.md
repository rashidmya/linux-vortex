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

## Proton game paths (2026-09-07; supersedes the Witcher 3-only fix of 2026-09-06)

A game running under Steam Proton reads its per-user Windows folders from *inside* its
compatdata prefix:

```
<library>/steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/Documents
<library>/steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/AppData/Local
```

Upstream resolves both through `util.getVortexPath('documents' | 'localAppData')`, i.e. the
host's `~/Documents` and a Windows-only `~/Local` on Linux, so anything Vortex writes there
for the game lands where the game never looks. For The Witcher 3 that was `mods.settings`
(mod priority and enable/disable had no in-game effect) and the `witcher3menumoddocuments`
mod type; for the gamebryo games it is `plugins.txt` itself.

`build/patch-linux-game-paths.cjs` installs `build/patches/vortex/gamePaths.ts` as
`src/renderer/src/util/linux/gamePaths.ts` and exports it from `util/api.ts`, so extensions
get `util.getGameDocumentsPath(gamePath)` / `util.getGameLocalAppDataPath(gamePath)` /
`util.getProtonUserDir(gamePath)`. Resolution, all synchronous: not Linux or no path → host
fallback; the path must be `<library>/steamapps/common/<dir>`; the app id is the
`appmanifest_*.acf` whose `installdir` matches `<dir>` (case-insensitive — no per-game id
lists; manifests are scanned in sorted order and the first with an existing prefix wins);
`compatdata/<id>/pfx/drive_c/users/steamuser` must exist. Any miss falls back to
`getVortexPath`, so GOG/Epic/Heroic installs, native Linux builds and Windows are unchanged,
and a `debug`-level log line records the fallback for Steam-looking paths. The patch refuses
to overwrite a file upstream might ship at that path (unless it is our own leftover from a
previous build in the persistent volume), and fails the build on any anchor drift.
`qa/test-game-paths.cjs` (14 cases, run in the build right after `pnpm install`, using
upstream's TypeScript compiler) covers each branch against a fake Steam library.

Converted consumers:

- **The Witcher 3** (`build/patch-witcher3-proton-docs.cjs`): every documents-path site in
  the extension — the load order file (`iniParser`, `index`, `mergeBackup`), the menu mod
  deployment target, the settings mergers (`mergers.ts`, not registered upstream today) and
  the "open documents folder" toolbar action, which the first fix had missed. The
  extension-local wrapper is named `getWitcher3DocumentsPath` (it appends the game folder;
  the core helper returns the Documents root). After patching, the script scans the whole
  extension for a bare `getLoadOrderFilePath()` / `getWitcher3DocumentsPath()` call and fails
  the build if an upstream bump adds one. Real-install verification is recorded at the end
  of this section. Menu mods deployed to `~/Documents` before the first fix are orphaned
  there and need removing by hand.
- **gamebryo-savegame-management** and **local-gamesettings** (`My Games`): converted by
  the core patch. *Fixture-verified only* — no Bethesda game was available to test on.
  Windows behaviour is unchanged: the helper delegates to `getVortexPath("documents")` off
  Linux.
- **gamebryo-plugin-management** (`plugins.txt`): also converted, but that extension is
  not built on Linux today — its `build` script is win32-gated because libloot has no Linux
  build (see the libloot notes below). The edit is carried so the fix is already in place if
  that ever changes; the anchor check fails the build if upstream moves it. Its Windows code
  path is byte-for-byte upstream's, behind an early return.

Deferred, deliberately:

- `ini_prep`: `genIniFormat('winapi')` returns `undefined` off Windows
  (`src/renderer/src/extensions/ini_prep/index.ts:58`), so ini tweaks are inert on Linux
  regardless of path. Lifting that gate is a separate change.
- `open-directory` (cosmetic "open folder" buttons) and the per-game extensions that
  hand-roll `getVortexPath("documents")` (or `"localAppData"`, for bg3) (sims3/4, teso,
  dragonage/2, bg3, divinity2, x4,
  torchlight2, battletech, nwn/2, galciv3, grimrock, dawnofman, modtype-dazip): one small
  edit each, to be done when someone can verify the game in question.

Smoke (`qa/smoke.sh`) checks the helper's debug-log string in `app.asar` and the
`util.getGameDocumentsPath` call in the Witcher 3 bundle and in the two gamebryo bundles
that ship on Linux (a property access on the external vortex-api namespace, which the
extension bundler never mangles).

Real-install verification: _pending — open item until run on the CachyOS host's Steam
Witcher 3: toggle a mod and change a priority and confirm `mods.settings` is rewritten under
the prefix (not `~/Documents`), deploy a menu mod there, and check the toolbar button opens
that folder._

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

## Witcher 3 Script Merger paths (2026-09-07)

Vortex sets the merger up for the user: `setMergerConfig()` (`scriptmerger.ts`) rewrites
`GameDirectory`, `VanillaScriptsDirectory` and `ModsDirectory` inside
`WitcherScriptMerger.exe.config`, building them with node's `path.join`. On Linux that
writes POSIX paths — but Script Merger is a Windows .NET tool running in the game's Proton
prefix, where the files it enumerates come back as `Z:\home\...`.

The merger does not reject the mismatch. It resolves a file's location inside its mod with

```csharp
var startIndex = fullPath.IndexOfIgnoreCase(basePath) + basePath.Length + 1;
return fullPath.Substring(startIndex);          // Paths.GetRelativePath
```

`IndexOfIgnoreCase` is separator- and drive-sensitive, so it misses, returns `-1`, and the
helper strips `basePath.Length` characters instead of erroring. That garbage relative path
goes straight into `_outputPath = Path.Combine(ModsDirectory, mergedModName, relPath)`
(`FileMerger.cs`), so the merge is written where the game never reads. Observed on a real
install: merging *Fast Travel from Anywhere* with *MapQuestObjectives* (both patch
`mapMenu.ws`) produced
`Mods/mod0000_MergedFiles/ywhere/content/scripts/game/gui/menus/mapMenu.ws` — `ywhere`
being the tail of `modFastTravelFromAnywhere`. The game only loads
`mod0000_MergedFiles/content/scripts/...`, so the script conflict the merge was meant to
resolve persisted, `MergeInventory.xml` was left empty (blank Merges panel), and Vortex
logged `[game-witcher] failed to retrieve merged mod names`. Merging appeared to succeed
and did nothing.

`build/patch-witcher3-scriptmerger-paths.cjs` converts those three values on Linux: Wine
maps the `Z:` drive to `/`, so an absolute POSIX path becomes a valid Windows path by
prefixing `Z:` and flipping the separators. Naming the drive explicitly matters — Proton
also maps the Steam library to `S:`, and a bare `/home/...` resolves against the process's
*current* drive, so once that mapping appears the merger can stop finding the game at all.
The mods directory also moves from `mods` to `Mods`: the casing this extension creates and
reads everywhere else, and the only one that exists on a case-sensitive filesystem.

Verified on the CachyOS host both ways. With the POSIX config the merge landed under
`ywhere/`; with `Z:\...\Mods` it landed at
`Mods/mod0000_MergedFiles/content/scripts/game/gui/menus/mapMenu.ws`, carrying 14 lines
unique to one mod and 13 unique to the other, and `MergeInventory.xml` recorded the merge
with both `IncludedMod` entries. `qa/test-scriptmerger-paths.cjs` lifts the real
`setMergerConfig` out of the packaged extension and runs it (5 cases, including that
Windows is left untouched) instead of grepping for `Z:`, which could not tell a correct
conversion from a backwards one.

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
