# Making "Run Fluffy" work for Resident Evil Requiem on Linux

> Game-specific helper, separate from the core AppImage. Documents the two changes
> applied so they can be re-applied after the RE Requiem extension updates (updates
> overwrite the user plugin at `~/.config/Vortex/plugins/Resident Evil Requiem Vortex Extension-*/`).

## The problem
RE Engine games need **Fluffy Mod Manager** (`Modmanager.exe`, a Windows tool) to activate
mods after Vortex stages them. On Linux the extension's "Run Fluffy" button crashed with
`Cannot read properties of undefined (reading 'path')` because:
1. **Case-sensitivity** — the extension's tool `requiredFiles: ["modmanager.exe"]` didn't
   match the deployed `Modmanager.exe`, so Vortex never discovered the tool (`tool` undefined).
2. **No Proton routing** — `runFluffy` calls `api.runExecutable(tool.path)` directly, and
   `api.runExecutable` does *not* route `.exe` through Proton/Wine (only `StarterInfo.run`,
   i.e. Dashboard tiles, does).

The host already has Wine (`/usr/bin/wine`, `wine-11.11`) and the kernel `DOSWin` binfmt;
Fluffy launches fine via `WINEPREFIX=<game proton prefix> wine Modmanager.exe`.

## Fix 1 — discovery symlink (case)
```bash
GAMEDIR="$HOME/.local/share/Steam/steamapps/common/RESIDENT EVIL requiem BIOHAZARD requiem"
ln -sf "Modmanager.exe" "$GAMEDIR/modmanager.exe"
```

## Fix 2 — patch the extension's `runFluffy`
In `…/Resident Evil Requiem Vortex Extension-*/index.js`, replace the `try { … } catch`
body of `runFluffy(api)` with a version that resolves the exe from the game folder and, on
Linux, launches it through Wine in the game's Proton prefix (appid `3764200`):

```js
  try {
    const nodefs = require('fs');
    const gamePath = util.getSafe(state, ['settings', 'gameMode', 'discovered', GAME_ID, 'path'], undefined);
    let exePath = (tool && tool.path) ? tool.path : undefined;
    if (!exePath && gamePath) {
      exePath = [path.join(gamePath, 'Modmanager.exe'), path.join(gamePath, 'modmanager.exe')]
        .find(p => nodefs.existsSync(p));
    }
    if (!exePath) {
      return api.showErrorNotification(`Failed to run ${TOOL_NAME}`, `Path to ${TOOL_NAME} executable could not be found. Ensure ${TOOL_NAME} is installed through Vortex.`);
    }
    // [linvortex patch] On Linux, launch the Windows tool via Wine in the game's Proton prefix.
    if (process.platform === 'linux' && gamePath) {
      const winePrefix = path.join(path.resolve(gamePath, '..', '..'), 'compatdata', STEAMAPP_ID, 'pfx');
      const env = Object.assign({}, process.env, { WINEPREFIX: winePrefix, WINEDEBUG: '-all' });
      return api.runExecutable('/usr/bin/wine', [exePath], { cwd: gamePath, env, suggestDeploy: false })
        .catch(err => api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err, { allowReport: false }));
    }
    return api.runExecutable(exePath, [], { suggestDeploy: false })
      .catch(err => api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err,
        { allowReport: ['EPERM', 'EACCESS', 'ENOENT'].indexOf(err.code) !== -1 })
      );
  } catch (err) {
    return api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err, { allowReport: false });
  }
```

Then **restart Vortex** and click **Run Fluffy**. Validated: Fluffy launches under Wine in
the Proton prefix (`rc=124`, window opens).

## Notes / limitations
- Uses **system Wine** against the game's **Proton** prefix — worked in testing; if Fluffy
  misbehaves, run it through the game's actual Proton instead.
- Re-apply both fixes after the extension or Fluffy is updated.
- This is upstream-extension behaviour (missing null-check + no Linux/Proton path), worth
  reporting to the extension author (ChemBoy1).
