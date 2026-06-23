# linvortex — Unofficial Native-Vortex AppImage Distribution

- **Status:** Implemented 2026-06-23 (M0+M1) — see [`docs/AS-BUILT.md`](../../AS-BUILT.md) for what actually shipped and the deviations (notably: .NET bundling dropped — FOMOD native is NativeAOT; FOMOD fixed via co-located `.so` + `patchelf`)
- **Date:** 2026-06-23
- **Owner:** Rashid (packaging) — built on Nexus Mods' GPL-3.0 native Linux Vortex
- **Upstream anchor:** `Nexus-Mods/Vortex` @ `4c39bbf` (master, 2026-06-23)

## 1. Summary

`linvortex` packages **Nexus Mods' native Linux build of Vortex** — which already
exists in the Vortex `master` source tree under GPL-3.0 — as a **single,
distro-agnostic, clearly-unofficial AppImage**, produced by a reproducible build +
QA pipeline that tracks a **pinned upstream commit**.

It fills the one gap upstream has not: there is **no published, no-compile binary**
for everyday (non-Arch, non-SteamOS) Linux users. We do **not** fork Vortex,
reimplement it, or present it as official. We package what exists and feed fixes
upstream.

## 2. Background (verified against the repo, not second-hand)

Confirmed by direct inspection of `Nexus-Mods/Vortex` @ `4c39bbf`:

- Vortex is **GPL-3.0**, an Electron + React + TypeScript app. The FOMOD installer
  is a bundled **.NET** component (`@nexusmods/fomod-installer-native` /
  `-ipc`, shipping `.dll`/`.exe`).
- A **native Linux build is real and active**: distro build docs in
  `docs/install-instructions/` (Arch/Debian/Fedora/NixOS/generic), the Arch guide
  "Validated 13 April 2026 (CachyOS 26.03)"; Linux source
  (`src/renderer/src/util/linux/{steamPaths,proton}.ts`,
  `*/filesystem/paths.linux.ts`, native
  `src/renderer/src/util/protocolRegistration/linux/nxm.ts`); and an official
  **native Flatpak** manifest (`flatpak/com.nexusmods.vortex.yaml`) — **no Wine**.
- Upstream already provides, for free: launcher-agnostic **game discovery**
  (Steam native/Flatpak/Snap/Debian + Proton `compatdata`/`pfx` + GOG/Epic), the
  **`nxm://` handler**, and same-volume/**hardlink deployment**.
- **The gap:** the only release metadata is `1.16.0-beta.1` (2026-02-05,
  "Development build"). **No AppImage/Flatpak/.deb/.rpm is published.** The AUR
  package builds from source and lags. Official support is scoped to **SteamOS**,
  though the code is plainly distro-agnostic.

### Build reality (important, and a live risk)

- The current build is `pnpm nx run @vortex/main:package` (the in-repo Flatpak
  manifest still references an older `yarn` + `electron-builder-config.json` flow —
  i.e. **the build system is mid-migration**).
- The electron-builder config (`src/main/electron-builder.config.json`) Linux
  `target` is **`zip`** (Flatpak uses `--linux dir`). **No AppImage target exists
  upstream.**
- The **.NET runtime is not bundled for Linux** in electron-builder (only Windows
  runtimes are in `extraResources`). The Flatpak bundles a `.NET` runtime
  separately into `/app/lib/dotnet` with `DOTNET_ROOT`. Vortex locates a runtime
  via `tools/dotnetprobe`.

## 3. Goals / Non-goals

**Goals**

- Produce a working, **self-contained AppImage** of native Vortex from a pinned
  upstream commit, runnable on mainstream distros without compilation.
- **Reproducible, scripted** build with a **QA smoke gate** before any publish.
- Clear **unofficial** labeling and **GPL source-availability** compliance.
- A lightweight **upstream contribution** loop for bugs found.

**Non-goals (v1)**

- No Flatpak (Nexus owns it), no AUR (already exists), no `.deb`/`.rpm`.
- No fork, no feature development, no custom bridge/extension (upstream already has
  discovery / nxm / deployment).
- No Wine/Windows path.
- No long-term maintenance guarantee — this is explicitly a **short-window** effort
  that ends when Nexus ships official binaries.

## 4. The two pieces of real engineering

Most of this project is "drive the upstream build," but two parts are genuine work:

**(A) AppImage packaging.** Upstream emits a `zip`/unpacked `dir`, not an AppImage.
We add an AppImage step: either extend electron-builder's Linux `target` to include
`appImage`, or take the unpacked dir → `appimagetool`. electron-builder already
emits the `nxm` `.desktop` `mimeType`, so handler metadata is covered.

**(B) Bundling the .NET runtime.** The FOMOD installer is a .NET tool; upstream
bundles a runtime only in the Flatpak. For a self-contained AppImage we must bundle
a **.NET runtime** inside the AppDir and ensure Vortex's `dotnetprobe` / `DOTNET_ROOT`
resolves it. Without this, FOMOD (a core install path) breaks. **This is the main
technical risk.**

## 5. Architecture — the build pipeline

1. **Source acquisition** — clone Vortex at a **pinned commit SHA** with submodules
   (`--recurse-submodules`). The SHA is the provenance/version anchor.
2. **Toolchain** — provision the documented stack (Node via Volta/pinned, `yarn v1`,
   `pnpm` via corepack, **.NET 9 SDK**, python, base-devel). Build inside a
   **container** (repo ships `docker/linux/`, `Dockerfile.devcontainer`, and a Nix
   flake — reuse one for reproducibility).
3. **Build** — `pnpm install` → `pnpm nx run @vortex/main:package` to produce the
   unpacked Linux app.
4. **AppImage assembly** — assemble AppDir from the unpacked app; **inject the .NET
   runtime**; add an `AppRun` that (a) sets `DOTNET_ROOT` to the bundled runtime,
   (b) handles the Electron sandbox (`chrome-sandbox` SUID, else `--no-sandbox`
   fallback), and (c) runs the nxm path-pinning shim (§6); then `appimagetool` →
   `linvortex-<date>-g<shortSHA>-x86_64.AppImage`.
5. **QA smoke gate** (must pass before publish; under `xvfb`):
   - app boots to the main window;
   - `nxm://` handler registers via `xdg-settings`;
   - a **seeded fake Steam library** is discovered;
   - a minimal mod deploy (**hardlink**) into a temp game dir succeeds;
   - the **FOMOD .NET host** starts (validates the .NET bundle).
   Any failure → **no publish**.
6. **Publish** — GitHub Release, labeled **unofficial beta**; release body references
   the upstream SHA, the unofficial/legal disclaimer, and a link to corresponding
   source (GPL compliance).

## 6. nxm:// + AppImage path wrinkle

AppImages can be moved/renamed, but the `xdg-settings`/`.desktop` handler needs a
stable absolute path with `%u`. `AppRun` resolves the running AppImage's real path
(`$APPIMAGE`) and registers/repairs the handler to point at it on each launch;
document optional `AppImageLauncher` integration. We must confirm Vortex's `nxm.ts`
registration respects an injected exec path (vs. hardcoding `process.execPath`).

## 7. Versioning & upstream tracking

- Version string = `linvortex-<date>-g<shortSHA>`, anchored to the pinned upstream
  commit. **Never** present an official Vortex version number as ours.
- **Re-pin deliberately** (do not auto-follow HEAD): bump SHA → rebuild → QA →
  release-notes diff. Because the upstream build invocation itself is changing
  (`yarn` → `pnpm`/`nx`), the build script must be **re-validated each bump** —
  treat build breakage as expected, not exceptional.

## 8. Branding / legal posture

- GPL-3.0 permits redistributing binaries **provided we offer corresponding source**
  (link the exact pinned commit + our packaging scripts, which are GPL-compatible).
- **Trademark ≠ copyright.** "Vortex" and Nexus logos may be trademarked; GPL grants
  no trademark rights. Therefore: ship under our own name (**linvortex**), mark
  builds **"unofficial — not affiliated with or endorsed by Nexus Mods,"** avoid
  implying endorsement, and keep clear upstream attribution. *(Not legal advice;
  this is the cautious posture.)*
- Disclaimer in README + release notes (and in-app/about where feasible).

## 9. Upstream contribution loop

A bug from QA or a user → reproduce on a **clean upstream build** (rule out our
packaging) → if upstream: file issue / PR; if packaging: fix in our scripts. Keep
our patch set **packaging-only**; avoid carrying functional forks.

## 10. Repository layout (`/home/buga/Dev/linvortex`)

```
build/        build scripts + container/nix definition
appimage/     AppDir template, AppRun, .NET runtime fetch, appimagetool wrapper
qa/           smoke-test harness + fake Steam library fixtures
docs/         this spec, README, unofficial/legal notice
.github/      (v1.1) CI: build + QA + release on SHA bump
pinned-commit the upstream SHA we build
```

## 11. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Obsolescence** — Nexus ships official binaries | High | AppImage-only, thin effort; pivot to pure upstream contribution when it lands |
| **Beta support burden** — bugs we didn't write | Med-High | Clear "unofficial/beta" labels; issue template splitting packaging vs upstream bugs; manage expectations |
| **Build breakage** from moving `master` | Med-High | Pin SHAs; containerize; expect to fix the build each bump |
| **.NET/FOMOD bundling** | Med | Primary technical spike; validate FOMOD in the QA gate |
| **Electron sandbox in AppImage** | Med | Handle `chrome-sandbox`/`--no-sandbox` in `AppRun` |
| **Trademark** | Med | Unofficial branding + own name + disclaimer |

## 12. Milestones

- **M0 — Build spike:** build native Vortex from the pinned SHA in a container and
  launch it on CachyOS. *De-risks the build before any packaging.*
- **M1 — v1 AppImage:** AppDir + bundled .NET + `AppRun` → an AppImage that boots,
  registers nxm, discovers Steam, deploys a mod, and runs FOMOD; manual QA on 2
  distros; **first unofficial release**.
- **M1.1 — Scripted QA gate:** automate the smoke tests from §5.
- **M2 — CI:** build + QA + release automation on deliberate SHA bumps.

## 13. Open questions

1. Pin to a `master` SHA, or to the latest green tag/beta? (Stability vs. freshness.)
2. Bundle the **full** .NET runtime, or a trimmed/self-contained FOMOD publish for a
   smaller AppImage?
3. **x86_64 only** for v1 (recommended), or also `aarch64`?
4. Hosting/discovery — GitHub Releases assumed; how do users find it?
