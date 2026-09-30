#!/usr/bin/env node
/*
 * patch-linux-game-paths.cjs — resolve a game's Windows user folders inside its Proton prefix,
 * for every game.
 *
 * A game running under Steam Proton reads "Documents", "%LOCALAPPDATA%" and "%APPDATA%" from
 * inside its compatdata prefix, but Vortex resolves them through util.getVortexPath(), which
 * on Linux returns the host's XDG directories. So load order files (plugins.txt,
 * mods.settings), ini tweaks, "My Games" lookups and mods deployed into Documents all land
 * where the game never looks.
 *
 * 1. Installs build/patches/vortex/gamePaths.ts as src/renderer/src/util/linux/gamePaths.ts
 *    and exports its helpers from util/api.ts (util.getGameDocumentsPath(gamePath),
 *    util.getGameLocalAppDataPath(gamePath), util.getProtonUserDir(gamePath)).
 *    Verified by qa/test-game-paths.cjs.
 * 2. Gives every extension its own util.getVortexPath (util/extensionRequire.ts already hands
 *    each extension its own proxy of the api): "documents", "localAppData" and "appData"
 *    resolve inside the prefix of the game the extension works for. This is what fixes game
 *    extensions without editing them, bundled or downloaded from Nexus Mods. It also makes
 *    extensionRequire attribute a file to its extension exactly - a plain prefix test gives
 *    game-fallout4vr's files to game-fallout4. Verified by qa/test-extension-require.cjs.
 * 3. Converts the shared gamebryo modules, which work for a game they are told about rather
 *    than the managed one (local-gamesettings swaps ini files for the game being switched
 *    away from as well as the one being switched to): gamebryo-savegame-management,
 *    gamebryo-test-settings and local-gamesettings ("My Games"), and
 *    gamebryo-plugin-management (plugins.txt) - the latter is not built on Linux today
 *    (libloot has no Linux build, see docs/AS-BUILT.md), so that edit is carried so the fix
 *    is already in place if it ever is. Windows keeps upstream's code path byte-for-byte.
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
const EXT_REQUIRE = path.join('src', 'renderer', 'src', 'util', 'extensionRequire.ts');
const EXT_MANAGER = path.join('src', 'renderer', 'src', 'ExtensionManager.ts');
const PLUGIN_MGMT = path.join(
  'extensions', 'gamebryo-plugin-management', 'src', 'util', 'gameSupport.ts');
const SAVEGAMES = path.join(
  'extensions', 'gamebryo-savegame-management', 'src', 'util', 'gameSupport.ts');
const TEST_SETTINGS = path.join(
  'extensions', 'gamebryo-test-settings', 'src', 'util', 'gameSupport.ts');
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
    file: EXT_REQUIRE,
    find: `import type { LogLevel } from "./log";
import { webpackRequireHack } from "./webpack-hacks";`,
    replace: `import type { LogLevel } from "./log";
// ${MARKER}
import * as path from "path";
import type { IState } from "../types/IState";
import { utilForExtension } from "./linux/gamePaths";
import { webpackRequireHack } from "./webpack-hacks";`,
  },
  {
    file: EXT_REQUIRE,
    find: `class ExtProxyHandler implements ProxyHandler<typeof api> {
  private mExt: IRegisteredExtension;
  constructor(ext: IRegisteredExtension) {
    this.mExt = ext;
  }

  public get(target: typeof api, p: PropertyKey, receiver: any): any {
    if (p === "log") {
      return (level: LogLevel, message: string, metadata: any) => {
        target.log(level, \`[\${this.mExt.namespace}] \${message}\`, metadata);
      };
    } else {
      return target[p];
    }
  }
}`,
    replace: `class ExtProxyHandler implements ProxyHandler<typeof api> {
  private mExt: IRegisteredExtension;
  // ${MARKER}
  private mGetState: () => IState | undefined;
  private mUtil: typeof api.util;
  constructor(ext: IRegisteredExtension, getState: () => IState | undefined) {
    this.mExt = ext;
    this.mGetState = getState;
  }

  public get(target: typeof api, p: PropertyKey, receiver: any): any {
    if (p === "log") {
      return (level: LogLevel, message: string, metadata: any) => {
        target.log(level, \`[\${this.mExt.namespace}] \${message}\`, metadata);
      };
    } else if (p === "util") {
      // ${MARKER}: this extension's util.getVortexPath resolves
      // Documents and AppData inside the Proton prefix of the game it works for
      // (see linux/gamePaths.ts).
      if (this.mUtil === undefined) {
        this.mUtil = utilForExtension(target.util, this.mExt.path, this.mGetState);
      }
      return this.mUtil;
    } else {
      return target[p];
    }
  }
}

// ${MARKER}: a plain prefix test gives every file in
// bundledPlugins/game-fallout4vr to game-fallout4 (darksouls2 to darksouls, ...), whichever
// is listed first. Each extension's api now resolves paths for that extension's game, so the
// owner has to be exact.
function isInsideExtension(filename: string, extensionPath: string): boolean {
  return filename.startsWith(extensionPath + path.sep);
}`,
  },
  {
    file: EXT_REQUIRE,
    find: 'function extensionRequire(orig, getExtensions: () => IRegisteredExtension[]) {',
    replace: `function extensionRequire(
  orig,
  getExtensions: () => IRegisteredExtension[],
  getState: () => IState | undefined,
) {`,
  },
  {
    file: EXT_REQUIRE,
    find: '      const ext = getExtensions().find((iter) => this.filename.startsWith(iter.path));',
    replace: '      const ext = getExtensions().find((iter) => isInsideExtension(this.filename, iter.path));',
    all: true,
    expect: 2,
  },
  {
    file: EXT_REQUIRE,
    find: '          handlerMapAPI[ext.name] = new Proxy(api, new ExtProxyHandler(ext));',
    replace: '          handlerMapAPI[ext.name] = new Proxy(api, new ExtProxyHandler(ext, getState));',
  },
  {
    file: EXT_REQUIRE,
    find: `export default function (getExtensions: () => IRegisteredExtension[]) {
  const orig = Module.prototype.require;
  Module.prototype.require = extensionRequire(orig, getExtensions);
}`,
    replace: `export default function (
  getExtensions: () => IRegisteredExtension[],
  // ${MARKER}
  getState: () => IState | undefined = () => undefined,
) {
  const orig = Module.prototype.require;
  Module.prototype.require = extensionRequire(orig, getExtensions, getState);
}`,
  },
  {
    file: EXT_MANAGER,
    find: '    require("./util/extensionRequire").default(() => this.extensions);',
    replace: `    // ${MARKER}: an extension's getVortexPath needs the store to find
    // the game the extension works for. mApi.getState returns undefined until the store is set.
    require("./util/extensionRequire").default(
      () => this.extensions,
      () => this.mApi?.getState?.(),
    );`,
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
  { file: TEST_SETTINGS, find: MYGAMES_FIND, replace: MYGAMES_REPLACE },
  { file: LOCAL_SETTINGS, find: MYGAMES_FIND, replace: MYGAMES_REPLACE },
];

const srcRoot = process.argv[2];
if (!srcRoot) {
  console.error('usage: node build/patch-linux-game-paths.cjs <upstream source root>');
  process.exit(2);
}
const FILES = [...new Set(EDITS.map((edit) => edit.file))];
for (const rel of FILES) {
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
  const wanted = edit.all ? edit.expect : 1;
  if (occurrences !== wanted) {
    console.error('!! ' + edit.file + ': expected ' + wanted + ' occurrence(s) of the anchor, found ' +
      occurrences);
    console.error('   anchor: ' + edit.find.split('\n')[0].trim() + ' ...');
    failures++;
    continue;
  }
  contents.set(edit.file, text.split(edit.find).join(edit.replace));
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
