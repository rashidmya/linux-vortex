#!/usr/bin/env node
/*
 * patch-linux-game-paths.cjs — resolve a game's Windows user folders inside its Proton prefix.
 *
 * A game running under Steam Proton reads "Documents" and "%LOCALAPPDATA%" from inside its
 * compatdata prefix, but Vortex resolves both through util.getVortexPath(), which on Linux
 * returns the host's XDG directories. So load order files (plugins.txt, mods.settings), ini
 * tweaks and "My Games" lookups all land where the game never looks.
 *
 * 1. Installs build/patches/vortex/gamePaths.ts as src/renderer/src/util/linux/gamePaths.ts
 *    and exports it from util/api.ts, so extensions can call
 *    util.getGameDocumentsPath(gamePath) / util.getGameLocalAppDataPath(gamePath).
 *    Verified by qa/test-game-paths.cjs.
 * 2. Converts the shared gamebryo modules that already know the game's discovered path:
 *    gamebryo-savegame-management and local-gamesettings ("My Games"), and
 *    gamebryo-plugin-management (plugins.txt) - the latter is not built on Linux today
 *    (libloot has no Linux build, see docs/AS-BUILT.md), so that edit is carried so the fix
 *    is already in place if it ever is. Windows keeps upstream's code path byte-for-byte.
 *
 * The Witcher 3 extension is converted separately by build/patch-witcher3-proton-docs.cjs,
 * which depends on the export this script adds - run this one first.
 *
 * Usage: node build/patch-linux-game-paths.cjs <upstream Vortex source root>
 * Idempotent; fails the build if any anchor is missing, so an upstream change to these
 * files can't silently drop the fix.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MARKER = '[linux-vortex] proton game paths';
const HELPER_SRC = path.join(__dirname, 'patches', 'vortex', 'gamePaths.ts');
const HELPER_DEST = path.join('src', 'renderer', 'src', 'util', 'linux', 'gamePaths.ts');
const API = path.join('src', 'renderer', 'src', 'util', 'api.ts');
const PLUGIN_MGMT = path.join(
  'extensions', 'gamebryo-plugin-management', 'src', 'util', 'gameSupport.ts');
const SAVEGAMES = path.join(
  'extensions', 'gamebryo-savegame-management', 'src', 'util', 'gameSupport.ts');
const LOCAL_SETTINGS = path.join('extensions', 'local-gamesettings', 'src', 'util', 'gameSupport.ts');

const MYGAMES_FIND = `export function mygamesPath(gameMode: string): string {
  return path.join(
    util.getVortexPath("documents"),
    "My Games",
    gameSupport.get(gameMode, "mygamesPath"),
  );
}`;
const MYGAMES_REPLACE = `// ${MARKER}: "My Games" lives inside the game's Proton prefix on Linux.
// util.getGameDocumentsPath falls back to util.getVortexPath("documents") off Linux or when
// the game has no prefix, so Windows and non-Steam installs are unchanged.
export function mygamesPath(gameMode: string): string {
  return path.join(
    util.getGameDocumentsPath(discoveryForGame(gameMode)?.path),
    "My Games",
    gameSupport.get(gameMode, "mygamesPath"),
  );
}`;

const EDITS = [
  {
    file: API,
    find: `import lazyRequire from "./lazyRequire";
import local from "./local";`,
    replace: `import lazyRequire from "./lazyRequire";
// ${MARKER}
import { getGameDocumentsPath, getGameLocalAppDataPath, getProtonUserDir } from "./linux/gamePaths";
import local from "./local";`,
  },
  {
    file: API,
    find: `  getVortexPath,
  github,`,
    replace: `  getVortexPath,
  // ${MARKER}
  getGameDocumentsPath,
  getGameLocalAppDataPath,
  getProtonUserDir,
  github,`,
  },
  {
    file: PLUGIN_MGMT,
    find: `export function appDataPath(gameMode: string): string {
  const dataPath = gameSupport.get(gameMode, "appDataPath");

  return process.env.LOCALAPPDATA !== undefined
    ? path.join(process.env.LOCALAPPDATA, dataPath)
    : path.resolve(util.getVortexPath("appData"), "..", "Local", dataPath);
}`,
    replace: `export function appDataPath(gameMode: string): string {
  const dataPath = gameSupport.get(gameMode, "appDataPath");

  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA !== undefined
      ? path.join(process.env.LOCALAPPDATA, dataPath)
      : path.resolve(util.getVortexPath("appData"), "..", "Local", dataPath);
  }
  // ${MARKER}: plugins.txt lives under %LOCALAPPDATA% *inside the game's Proton prefix*.
  // util.getGameLocalAppDataPath falls back to the host's local appdata when the game has
  // no prefix (non-Steam install, native Linux build).
  return path.join(util.getGameLocalAppDataPath(discoveryForGame(gameMode)?.path), dataPath);
}`,
  },
  { file: SAVEGAMES, find: MYGAMES_FIND, replace: MYGAMES_REPLACE },
  { file: LOCAL_SETTINGS, find: MYGAMES_FIND, replace: MYGAMES_REPLACE },
];

const srcRoot = process.argv[2];
if (!srcRoot) {
  console.error('usage: node build/patch-linux-game-paths.cjs <upstream source root>');
  process.exit(2);
}
for (const rel of [API, PLUGIN_MGMT, SAVEGAMES, LOCAL_SETTINGS]) {
  if (!fs.existsSync(path.join(srcRoot, rel))) {
    console.error('!! upstream file not found: ' + rel);
    process.exit(1);
  }
}
if (!fs.existsSync(HELPER_SRC)) {
  console.error('!! helper source not found: ' + HELPER_SRC);
  process.exit(1);
}

const contents = new Map();
const readFile = (rel) => {
  if (!contents.has(rel)) {
    contents.set(rel, fs.readFileSync(path.join(srcRoot, rel), 'utf8'));
  }
  return contents.get(rel);
};

// Already patched? Every edit is applied together, so one marker is enough.
if (readFile(API).includes(MARKER)) {
  console.log('>> proton game paths: already patched');
  process.exit(0);
}

let failures = 0;
for (const edit of EDITS) {
  const text = readFile(edit.file);
  const occurrences = text.split(edit.find).length - 1;
  if (occurrences !== 1) {
    console.error('!! ' + edit.file + ': expected 1 occurrence of the anchor, found ' + occurrences);
    console.error('   anchor: ' + edit.find.split('\n')[0].trim() + ' ...');
    failures++;
    continue;
  }
  contents.set(edit.file, text.replace(edit.find, edit.replace));
}

if (failures > 0) {
  console.error('!! Upstream changed a patched file; re-review and refresh ' +
    'build/patch-linux-game-paths.cjs. Nothing was written.');
  process.exit(1);
}

const dest = path.join(srcRoot, HELPER_DEST);
// A leftover copy of our own helper (untracked, so it survives the build's checkout -f) is
// fine; a file upstream now ships at this path is not.
if (fs.existsSync(dest) && !fs.readFileSync(dest, 'utf8').includes(MARKER)) {
  console.error('!! upstream now ships ' + HELPER_DEST + '; re-review before overwriting it.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(HELPER_SRC, dest);
console.log('   installed: ' + HELPER_DEST);
for (const [rel, text] of contents) {
  fs.writeFileSync(path.join(srcRoot, rel), text);
  console.log('   patched: ' + rel);
}
console.log('>> proton game paths: installed helper, patched ' + contents.size + ' file(s)');
