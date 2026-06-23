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
ENGINE=docker ./build-all.sh   # builds upstream, assembles the AppImage, runs smoke QA
```

Requires Docker (or Podman via `ENGINE=podman`). See
`docs/superpowers/plans/2026-06-23-linvortex-appimage-v1.md` for details.
