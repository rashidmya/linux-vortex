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

## Proton game paths (2026-09-30: every game; supersedes the per-game fixes of 2026-09-06/07)

A game running under Steam Proton reads its per-user Windows folders from *inside* its
compatdata prefix:

```
<library>/steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/Documents
<library>/steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/AppData/Local
<library>/steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/AppData/Roaming
```

Game extensions resolve these through `util.getVortexPath('documents' | 'localAppData' |
'appData')`, which on Linux reports the host's `~/Documents`, `~/.config` and a nonexistent
`~/Local`. So anything Vortex wrote there for the game landed where the game never looks: The
Witcher 3's `mods.settings` (mod priority and enable/disable had no in-game effect), menu mods,
`plugins.txt` and `My Games` for the gamebryo games, and every game whose mods deploy into
Documents (The Sims, TESO, Dragon Age, Neverwinter Nights, BattleTech, ...). Patching game
extensions one by one could never cover the downloadable ones from Nexus Mods, which is most
games.

`build/patch-linux-game-paths.cjs` fixes it in core, once:

1. **Helper.** Installs `build/patches/vortex/gamePaths.ts` as
   `src/renderer/src/util/linux/gamePaths.ts` and exports `util.getGameDocumentsPath(gamePath)`
   / `util.getGameLocalAppDataPath(gamePath)` / `util.getProtonUserDir(gamePath)`. Resolution,
   all synchronous: not Linux or no path → host fallback; the path must be
   `<library>/steamapps/common/<dir>`; the app id is the `appmanifest_*.acf` whose
   `installdir` matches `<dir>` (case-insensitive — no per-game id lists; manifests are
   scanned in sorted order and the first with an existing prefix wins);
   `compatdata/<id>/pfx/drive_c/users/steamuser` must exist. Any miss falls back to
   `getVortexPath`, so GOG/Epic/Heroic installs, native Linux builds and Windows are unchanged.
   The answer is cached per game folder: a found prefix is re-checked with one `stat`, a miss
   is retried after 10 s, so a game first launched through Proton while Vortex runs is picked
   up without a restart.
2. **Every extension.** Upstream's require hook (`util/extensionRequire.ts`) already hands
   each extension its own proxy of `vortex-api` (to prefix its log lines). The patch adds
   `util` to that proxy: the extension's `util.getVortexPath` answers `documents`,
   `localAppData` and `appData` inside the prefix of **the game the extension works for**, and
   everything else as before. That game is:
   - for a game extension, its own game (matched through the `extensionPath` Vortex records
     for every registered game) — also while another game is managed, which matters because
     a game's `setup` runs before a switch to it is recorded as active. An extension that
     registered several games uses the managed one if it's among them, else none;
   - for a shared extension (registered no game: `gamebryo-archive-invalidation`,
     `open-directory`, community helpers), the managed game — the one being switched *to*
     while a switch is in progress. Shared extensions keep the host `appData`: roaming AppData
     is where Vortex and extensions keep their own data, so for them it may not mean the game's.

   Vortex core keeps calling the real `getVortexPath`, so its own data never moves. `home` is
   never redirected (extensions use it for native Linux paths such as `~/.factorio`).
   The same edit makes the hook attribute a file to its extension exactly. Upstream's
   `filename.startsWith(ext.path)` hands every file in `game-fallout4vr` to `game-fallout4`
   (and `darksouls2` to `darksouls`, `dragonage2` to `dragonage`, ...), whichever loads first —
   which would have resolved Fallout 4 VR's paths in Fallout 4's prefix.
3. **Shared gamebryo modules**, which work for a game they're told about rather than the
   managed one (`local-gamesettings` swaps ini files for the game being switched *away from*
   too): `gamebryo-savegame-management`, `gamebryo-test-settings` and `local-gamesettings`
   (`My Games`) pass the game's discovered path to `util.getGameDocumentsPath`;
   `gamebryo-plugin-management` (`plugins.txt`) to `util.getGameLocalAppDataPath`. The last is
   not built on Linux today — its `build` script is win32-gated because libloot has no Linux
   build (see the libloot notes below); the edit is carried so the fix is already in place if
   that ever changes. Their Windows code paths are byte-for-byte upstream's.

The Witcher 3-only documents patch (`build/patch-witcher3-proton-docs.cjs`, 12+ anchors
across the extension) was retired: every site it rewrote calls `util.getVortexPath` from the
Witcher 3 extension at run time, which (2) now resolves in The Witcher 3's prefix.

Not covered, by design or for now:

- **Values an extension computes while it loads** resolve to host paths, as before: at that
  point no game is registered and there is no store to find one in. Among bundled extensions:
  `game-masterchiefcollection`, `game-pillarsofeternity2`, `game-prisonarchitect`,
  `game-daggerfallunity` (module-level `LocalLow`/`Local` constants), `modtype-dazip` and
  `script-extender-error-check` (module-level tables).
- **Extensions that read `process.env.LOCALAPPDATA` / `APPDATA` / `USERPROFILE`** directly:
  undefined on Linux, and per-game environment variables aren't possible.
- **Core's own game paths**: `ini_prep` (inert on Linux anyway — `genIniFormat('winapi')`
  returns `undefined` off win32) and the FOMOD installer's ini conditions for Bethesda games
  (`installer_fomod_shared/utils/gameSupport.ts`).
- **A native Linux game with a leftover prefix** (run through Proton once, then switched back)
  resolves to the prefix; nothing synchronous says which of the two Steam will run.

`qa/test-game-paths.cjs` (33 cases, run in the build right after `pnpm install`, using
upstream's TypeScript compiler, a fresh helper per case) covers the resolution, the cache and
the extension-to-game rules against a fake Steam library. `qa/test-extension-require.cjs`
(8 cases) transpiles the *patched* upstream `extensionRequire.ts` and requires `vortex-api`
through it the way an extension does; against unpatched upstream it fails, including on the
`game-fallout4vr` attribution. Smoke (`qa/smoke.sh`) checks the helper's debug-log string in
`app.asar`, the `utilForExtension` call in the packaged renderer, and the
`util.getGameDocumentsPath` call in the three gamebryo bundles that ship on Linux.

Real-install verification: _pending — run on the CachyOS host's Steam Witcher 3: toggle a
mod and change a priority and confirm `mods.settings` is rewritten under the prefix (not
`~/Documents`), deploy a menu mod there, and check the toolbar button opens that folder._
Menu mods deployed to `~/Documents` before any of these fixes are orphaned there and need
removing by hand.

## Windows tools through Proton (2026-09-06)

Vortex already runs Windows executables on Linux: `StarterInfo.runDirectly` calls
`shouldRunWithProton()` and hands off to `Steam.runToolWithProton()`, which runs
`<proton>/proton run <exe>` in the game's compatibility prefix. But extensions that call
`api.runExecutable()` directly bypass all of it — among the bundled ones, `game-witcher3`
(the script merger's "Run tool" notification action, `eventHandlers.ts:runScriptMerger`),
`fnis-integration` and `gamestore-gog`, plus most community game extensions. Spawning a PE
binary on Linux fails with `EACCES`, which Vortex renders as
"Network connect was not permitted, please check your firewall settings".

`build/patch-linux-proton-tools.cjs` makes three source changes:

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
3. **`util/StarterInfo.ts`** (2026-09-30), and the same rule in (1) — a tool belongs to a game
   when its path or working directory is the game folder or below it. Upstream's
   `shouldRunWithProton` tested for a plain string prefix, so everything in
   `common/Fallout 4 VR` also matched `common/Fallout 4` (and `SkyrimVR` /
   `Skyrim Special Edition` matched `Skyrim`). With both installed, F4SE VR's loader ran in
   whichever of the two prefixes Steam listed first — reproduced against the packaged
   bundle before the fix.

`qa/test-proton-matching.cjs` lifts both `findProtonGameFor` and `shouldRunWithProton` out of
the packaged renderer bundle and runs them against stub Steam entries (12 cases, including the
Fallout 4 / Fallout 4 VR pair); the smoke gate runs it.

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
- The code anchors in `build/patch-*.cjs` and the ini backend's sha256 guard hard-fail
  the build when reviewed code changes. No patch can safely accommodate arbitrary future
  upstream changes; keeping game fixes in core rather than in each game extension keeps the
  number of anchors an upstream bump can break small.
