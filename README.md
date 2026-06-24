# linvortex

An **unofficial**, distro-agnostic **AppImage** of Nexus Mods' native Linux build of
[Vortex](https://github.com/Nexus-Mods/Vortex) — for Linux users who want a no-compile
binary. See [`docs/UNOFFICIAL-NOTICE.md`](docs/UNOFFICIAL-NOTICE.md).

> Not affiliated with or endorsed by Nexus Mods. GPL-3.0. Beta quality (built from an
> upstream development branch).

## Download & run

Grab the latest `linvortex-*-x86_64.AppImage` from the [**Releases**](../../releases) page,
then:

```bash
chmod +x linvortex-*-x86_64.AppImage
./linvortex-*-x86_64.AppImage
```

If it won't start with `failed to load libfuse.so.2`, either install FUSE 2
(`libfuse2` / `fuse2`) or run it without FUSE:

```bash
./linvortex-*-x86_64.AppImage --appimage-extract-and-run
```

## Requirements

- **64-bit desktop Linux** with the usual GUI libraries (GTK3, NSS, libgbm, …) — present on
  any normal desktop install. Nothing to set up.
- **FUSE** to self-mount the AppImage — or use `--appimage-extract-and-run` (above).
- **Self-contained otherwise:** Electron and the **.NET 9 runtime are bundled**. No system
  .NET, Node, or Electron needed.
- **Wine is NOT required** to run Vortex or to download/deploy mods. It's only needed for
  **game-specific Windows modding tools** (e.g. *Fluffy Mod Manager* for RE Engine games) —
  exactly as a Windows user would still install those tools.

## What works / what doesn't

The packaging is solid; the upstream Linux port is still a dev build:

- ✅ Runs natively, Nexus login, download mods, **deploy mods** (hardlink), nxm:// one-click,
  FOMOD installers, Steam game detection.
- ⚠️ Many non-Steam / Windows-only-detection games aren't auto-detected yet (upstream), and
  Bethesda plugin load-order (LOOT/`libloot`) isn't available on Linux yet (upstream).

## Build from source

```bash
ENGINE=docker ./build-all.sh   # build image -> build Vortex -> assemble AppImage -> smoke
```

Requires Docker (or Podman via `ENGINE=podman`). Details and design notes:
[`docs/AS-BUILT.md`](docs/AS-BUILT.md).

## Releases

Pushing a version tag builds and publishes the AppImage automatically
(`.github/workflows/release.yml`):

```bash
git tag v0.1.0 && git push origin v0.1.0
```
