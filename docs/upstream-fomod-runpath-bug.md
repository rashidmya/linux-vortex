# Upstream bug report (draft) — FOMOD native addon not portable in Linux packages

> Ready-to-post draft for `Nexus-Mods/Vortex` (or the `@nexusmods/fomod-installer-native`
> repo). Not yet submitted. Verify the package-repo before posting.

---

**Title:** FOMOD native addon (`fomod-installer-native`) is not relocatable on Linux — absolute build-tree `RUNPATH` + missing `ModInstaller.Native.so` in the package

**Environment**
- Vortex `master` @ `4c39bbf` (2026-06-23), native Linux build (`nx run @vortex/main:package`)
- `@nexusmods/fomod-installer-native@0.13.2`, Ubuntu 24.04 build, x86_64

**Summary**
After packaging the native Linux build (electron-builder unpacked dir / AppImage), the FOMOD
native backend cannot load on an end-user machine. Two issues compound:

1. **Absolute build-tree `RUNPATH`.** The shipped `bin/linux-x64-146/fomod-installer-native.node`
   has:
   ```
   NEEDED   ModInstaller.Native.so
   RUNPATH  /build/upstream/node_modules/.pnpm/@nexusmods+fomod-installer-native@0.13.2/node_modules/@nexusmods/fomod-installer-native
   ```
   The `RUNPATH` is the *build machine's* absolute path, which does not exist at runtime, so the
   loader cannot find `ModInstaller.Native.so`.

2. **`ModInstaller.Native.so` is not co-located with the `.node` in the package.** It exists in
   the build tree at `prebuilds/linux-x64/`, the package root, and `build/Release/`, but only
   `bin/linux-x64-146/fomod-installer-native.node` is included in the packaged app — the `.so`
   is absent from `bin/linux-x64-146/`.

**Impact**
FOMOD-scripted installers (a large fraction of major mods) fail in any relocated/packaged Linux
build, because the native addon's required `ModInstaller.Native.so` can't be resolved.

**Repro**
1. Build the native Linux app and inspect the packaged
   `resources/app.asar.unpacked/node_modules/@nexusmods/fomod-installer-native/bin/linux-x64-146/`.
2. `readelf -d fomod-installer-native.node | grep -E 'NEEDED|RUNPATH'` → absolute build path.
3. `ldd fomod-installer-native.node` → `ModInstaller.Native.so => not found`.

**Suggested fix (one or more)**
- Set the addon's `RUNPATH`/`RPATH` to `$ORIGIN` at build/publish time so it finds a co-located `.so`.
- Ensure `ModInstaller.Native.so` is shipped **next to** the `.node` in `bin/<platform>-<arch>-<abi>/`,
  and that Vortex's electron-builder `files`/`asarUnpack` globs include it.
- (Workaround used downstream in `linux-vortex`: copy `ModInstaller.Native.so` next to the `.node`
  and `patchelf --set-rpath '$ORIGIN'` the `.node` during packaging.)
