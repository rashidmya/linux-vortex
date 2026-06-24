#!/usr/bin/env node
/*
 * patch-re-fluffy.cjs — make "Run Fluffy" work on Linux for RE Engine games in Vortex.
 *
 * RE Engine games (RE2/3/4 Remake, RE7, RE8 Village, RE5, RE Requiem, ...) use the
 * ChemBoy1-style Vortex extensions, whose "Run Fluffy" button calls
 * api.runExecutable(<Modmanager.exe>) directly. On Linux that crashes ("Cannot read
 * properties of undefined (reading 'path')" when the tool isn't discovered, and even when
 * discovered api.runExecutable doesn't route .exe through Proton).
 *
 * This rewrites each extension's runFluffy() to resolve Modmanager.exe from the game folder
 * and launch it via Wine in the game's Steam/Proton prefix. The patch is game-agnostic: it
 * uses each extension's own GAME_ID + STEAMAPP_ID constants.
 *
 * Idempotent + safe: skips already-patched extensions and refuses to touch any whose
 * runFluffy template differs (it tells you to patch those by hand — see re-engine-fluffy-linux.md).
 *
 * Usage:  node extras/patch-re-fluffy.cjs     (then restart Vortex)
 * Re-run after the extensions update (updates overwrite the patch).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const pluginsDir = path.join(os.homedir(), '.config', 'Vortex', 'plugins');

// The original runFluffy try/catch (ChemBoy1 template) -> our Wine/Proton version.
const OLD = [
  "  try {",
  "    const TOOL_PATH = tool.path;",
  "    if (TOOL_PATH !== undefined) {",
  "      return api.runExecutable(TOOL_PATH, [], { suggestDeploy: false })",
  "        .catch(err => api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err,",
  "          { allowReport: ['EPERM', 'EACCESS', 'ENOENT'].indexOf(err.code) !== -1 })",
  "        );",
  "    }",
  "    else {",
  "      return api.showErrorNotification(`Failed to run ${TOOL_NAME}`, `Path to ${TOOL_NAME} executable could not be found. Ensure ${TOOL_NAME} is installed through Vortex.`);",
  "    }",
  "  } catch (err) {",
  "    return api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err, { allowReport: ['EPERM', 'EACCESS', 'ENOENT'].indexOf(err.code) !== -1 });",
  "  }",
].join("\n");

const NEW = [
  "  try {",
  "    const nodefs = require('fs');",
  "    const gamePath = util.getSafe(state, ['settings', 'gameMode', 'discovered', GAME_ID, 'path'], undefined);",
  "    // Resolve Fluffy: discovered tool path, else the game folder (Linux is case-sensitive;",
  "    // the deployed file is usually 'Modmanager.exe').",
  "    let exePath = (tool && tool.path) ? tool.path : undefined;",
  "    if (!exePath && gamePath) {",
  "      exePath = [path.join(gamePath, 'Modmanager.exe'), path.join(gamePath, 'modmanager.exe')].find(p => nodefs.existsSync(p));",
  "    }",
  "    if (!exePath) {",
  "      return api.showErrorNotification(`Failed to run ${TOOL_NAME}`, `Path to ${TOOL_NAME} executable could not be found. Ensure ${TOOL_NAME} is installed through Vortex.`);",
  "    }",
  "    // [linux-vortex] On Linux, launch the Windows tool via Wine in the game's Proton prefix",
  "    // (api.runExecutable does not route .exe through Proton).",
  "    if (process.platform === 'linux' && gamePath) {",
  "      const winePrefix = path.join(path.resolve(gamePath, '..', '..'), 'compatdata', STEAMAPP_ID, 'pfx');",
  "      const env = Object.assign({}, process.env, { WINEDEBUG: '-all' });",
  "      if (nodefs.existsSync(winePrefix)) { env.WINEPREFIX = winePrefix; }",
  "      return api.runExecutable('/usr/bin/wine', [exePath], { cwd: gamePath, env, suggestDeploy: false })",
  "        .catch(err => api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err, { allowReport: false }));",
  "    }",
  "    return api.runExecutable(exePath, [], { suggestDeploy: false })",
  "      .catch(err => api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err,",
  "        { allowReport: ['EPERM', 'EACCESS', 'ENOENT'].indexOf(err.code) !== -1 }));",
  "  } catch (err) {",
  "    return api.showErrorNotification(`Failed to run ${TOOL_NAME}`, err, { allowReport: false });",
  "  }",
].join("\n");

let dirs;
try { dirs = fs.readdirSync(pluginsDir); }
catch { console.error('No Vortex plugins dir at ' + pluginsDir + ' — is Vortex installed/run once?'); process.exit(1); }

let patched = 0, already = 0, manual = 0, seen = 0;
for (const d of dirs) {
  const idx = path.join(pluginsDir, d, 'index.js');
  let s;
  try { s = fs.readFileSync(idx, 'utf8'); } catch { continue; }
  // Only RE-engine / Fluffy extensions.
  if (!/function runFluffy/.test(s) || !/fluffy|modmanager/i.test(s)) continue;
  seen++;
  if (s.includes("'/usr/bin/wine'")) { console.log('already patched: ' + d); already++; continue; }
  if (!s.includes(OLD)) { console.warn('!! runFluffy differs (patch by hand): ' + d); manual++; continue; }
  fs.writeFileSync(idx, s.replace(OLD, NEW));
  console.log('patched: ' + d);
  patched++;
}

console.log('\n' + seen + ' RE/Fluffy extension(s) found — patched=' + patched +
  ', already=' + already + ', needs-manual=' + manual);
if (patched > 0) console.log('Restart Vortex for the patch to take effect.');
process.exit(manual > 0 ? 2 : 0);
