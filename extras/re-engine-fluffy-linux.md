# Making "Run Fluffy" work for RE Engine games on Linux

> Game-tool helper, separate from the core AppImage. Applies to **RE Engine games modded
> with Fluffy Mod Manager** through the ChemBoy1-style Vortex extensions — e.g. **Resident
> Evil 2 / 3 / 4 Remake, RE7, RE8 Village, RE5, RE Requiem**, and similar. The fix is the
> same for all of them.

## The problem
RE Engine games need **Fluffy Mod Manager** (`Modmanager.exe`, a **Windows** tool) to
activate mods after Vortex stages them. On Linux the extension's **"Run Fluffy"** button
crashes:

- `TypeError: Cannot read properties of undefined (reading 'path')` — Vortex's tool discovery
  is **case-sensitive** on Linux, so the registered tool (`modmanager.exe`) doesn't match the
  deployed `Modmanager.exe`, and the tool object is `undefined`.
- Even when discovered, the extension's `runFluffy()` calls `api.runExecutable(<exe>)`
  **directly**, which does **not** route `.exe` through Proton/Wine (only Vortex's Dashboard
  "starter" path does).

## The fix (automated)
Run the patcher — it finds every installed RE/Fluffy extension and rewrites its `runFluffy()`
to resolve `Modmanager.exe` from the game folder and launch it via **Wine in the game's
Steam/Proton prefix**. It's game-agnostic (uses each extension's own `GAME_ID` + `STEAMAPP_ID`),
idempotent, and won't touch extensions whose code differs.

```bash
node ~/Dev/linvortex/extras/patch-re-fluffy.cjs
# then fully restart Vortex
```

Re-run it whenever the RE extensions update (updates overwrite the user plugin under
`~/.config/Vortex/plugins/<...>/index.js`).

**Requirements**
- **Wine** installed (`/usr/bin/wine`). Only needed for the Fluffy *tool* — not for Vortex.
- The game installed via **Steam** (so it has a Proton prefix at
  `steamapps/compatdata/<appid>/pfx`). For non-Steam installs the patch falls back to the
  default Wine prefix.

## The workflow (important)
**Fluffy manages mods; Steam launches the game.** Do **not** use Fluffy's own *Launch Game*
button on Linux — Fluffy runs under plain Wine and can't launch the game with Proton's DXVK /
Steam runtime, so the game won't start. Instead:

1. Vortex → install / deploy mods.
2. **Run Fluffy** (now works) → enable/arrange your mods → close Fluffy.
3. Launch the game **from Steam** (Proton). Your enabled mods + REFramework load normally.

## Manual patch (if the patcher reports `needs-manual` for an extension)
If an extension's `runFluffy()` template differs, replace its `try { ... } catch` body with:

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
    // [linux-vortex] On Linux, launch the Windows tool via Wine in the game's Proton prefix.
    if (process.platform === 'linux' && gamePath) {
      const winePrefix = path.join(path.resolve(gamePath, '..', '..'), 'compatdata', STEAMAPP_ID, 'pfx');
      const env = Object.assign({}, process.env, { WINEDEBUG: '-all' });
      if (nodefs.existsSync(winePrefix)) { env.WINEPREFIX = winePrefix; }
      return api.runExecutable('/usr/bin/wine', [exePath], { cwd: gamePath, env, suggestDeploy: false })
        .catch(err => api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err, { allowReport: false }));
    }
    return api.runExecutable(exePath, [], { suggestDeploy: false })
      .catch(err => api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err,
        { allowReport: ['EPERM', 'EACCESS', 'ENOENT'].indexOf(err.code) !== -1 }));
  } catch (err) {
    return api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err, { allowReport: false });
  }
```

## Notes
- Uses **system Wine** against the game's **Proton** prefix — works in practice; if a tool
  misbehaves, run it through the game's actual Proton instead.
- This is upstream-extension behaviour (missing null-check + no Linux/Proton path) — worth
  reporting to the extension author (ChemBoy1).
- Validated on **RE Requiem** (Steam, Proton): Fluffy launches and mods apply in-game.
