#!/usr/bin/env node
/*
 * patch-witcher3-proton-docs.cjs — point the Witcher 3 extension at the Proton prefix.
 *
 * The Witcher 3 has no native Linux build; it runs through a Steam Proton (Wine) prefix
 * and reads its "Documents" folder from inside that prefix. Upstream's extension uses
 * util.getVortexPath('documents'), which on Linux is the XDG documents dir (~/Documents).
 * So the load order file (mods.settings) and menu mods are written where the game will
 * never look for them: mod priorities and enable/disable flags have no effect in game, and
 * menu mods do nothing.
 *
 * The prefix itself is resolved by util.getGameDocumentsPath(gamePath), installed into
 * Vortex core by build/patch-linux-game-paths.cjs (run that first). This script threads
 * the discovered game path to every documents-path site in the extension: the load order
 * file (iniParser, index, mergeBackup, loadOrder), the menu mod deployment target, the settings
 * mergers, the DX12 settings health check, and the "open documents folder" toolbar action.
 *
 * Usage: node build/patch-witcher3-proton-docs.cjs <upstream Vortex source root>
 * Idempotent; fails the build if any anchor is missing, so an upstream change to these
 * files can't silently drop the fix.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MARKER = '[linux-vortex] proton documents';
const EXT_REL = path.join('extensions', 'games', 'game-witcher3', 'src');

// Import cleanup is independent of the code we patch. Preserve upstream's bindings
// instead of requiring a particular list/order (e.g. LOCKED_PREFIX was removed from
// iconbarActions.ts and CONFIG_MATRIX_FILES from mergers.ts in 41be6d455656).
// Still require exactly one named import from ./common; changed code anchors below
// continue to require review.
const DOCUMENTS_IMPORT = {
  find: /^import\s*\{[^{}]*\}\s*from\s*(["'])\.\/common\1[ \t]*;/gm,
  replace: (text) => text.replace('{', '{ getWitcher3DocumentsPath,'),
};

const EDITS = [
  {
    file: 'common.ts',
    find: `export function getLoadOrderFilePath() {
  return path.join(util.getVortexPath("documents"), "The Witcher 3", LOAD_ORDER_FILENAME);
}`,
    replace: `// ${MARKER}: The Witcher 3 has no native Linux build - it runs in a Steam
// Proton (Wine) prefix and reads "Documents" from inside that prefix, not from the XDG
// documents directory util.getVortexPath("documents") reports. The core helper resolves
// the prefix from the discovered game path and falls back to Vortex's documents
// path on Windows or when the game isn't a Steam/Proton install (GOG, Epic, Heroic, ...).
// (Named after the game on purpose: it appends the game folder, the core helper doesn't.)
export function getWitcher3DocumentsPath(gamePath?: string) {
  return path.join(util.getGameDocumentsPath(gamePath), "The Witcher 3");
}

export function getLoadOrderFilePath(gamePath?: string) {
  return path.join(getWitcher3DocumentsPath(gamePath), LOAD_ORDER_FILENAME);
}`,
  },
  {
    file: 'util.ts',
    ...DOCUMENTS_IMPORT,
  },
  {
    file: 'util.ts',
    find: `export const getDocumentsPath = (game: types.IGame) => {
  return path.join(util.getVortexPath("documents"), "The Witcher 3");
};`,
    replace: `// ${MARKER}: menu mods deploy into the game's documents folder, which lives
// inside the Proton prefix on Linux - take the same api closure shape as getDLCPath so we
// can resolve it from the discovered game path.
export const getDocumentsPath = (api: types.IExtensionApi) => {
  return (game: types.IGame) => {
    const state = api.store.getState();
    const discovery = state.settings.gameMode.discovered[game.id];
    return getWitcher3DocumentsPath(discovery?.path);
  };
};`,
  },
  {
    file: 'iniParser.ts',
    find: `  public async getIniStructure() {
    return this.mIniStruct;
  }`,
    replace: `  // ${MARKER}: the load order file lives in the game's documents folder,
  // which is inside the Proton prefix on Linux, so its location depends on where the game is.
  private gamePath(): string | undefined {
    const state = this.mApi.getState();
    return util.getSafe(state, ["settings", "gameMode", "discovered", GAME_ID, "path"], undefined);
  }

  public async getIniStructure() {
    return this.mIniStruct;
  }`,
  },
  {
    file: 'iniParser.ts',
    find: 'getLoadOrderFilePath()',
    replace: 'getLoadOrderFilePath(this.gamePath())',
    all: true,
    expect: 5,
  },
  {
    file: 'index.ts',
    find: '      ensurePath(path.dirname(getLoadOrderFilePath())),',
    replace: '      ensurePath(path.dirname(getLoadOrderFilePath(discovery.path))),',
  },
  {
    file: 'index.ts',
    find: `    isTW3(context.api),
    getDocumentsPath,`,
    replace: `    isTW3(context.api),
    getDocumentsPath(context.api),`,
  },
  {
    file: 'iconbarActions.ts',
    ...DOCUMENTS_IMPORT,
  },
  {
    file: 'iconbarActions.ts',
    find: `  const openTW3DocPath = () => {
    const docPath = path.join(util.getVortexPath("documents"), "The Witcher 3");
    util.opn(docPath).catch(() => null);
  };`,
    replace: `  const openTW3DocPath = () => {
    // ${MARKER}: the folder lives inside the Proton prefix on Linux.
    const discovery = context.api.getState().settings.gameMode.discovered[GAME_ID];
    util.opn(getWitcher3DocumentsPath(discovery?.path)).catch(() => null);
  };`,
  },
  {
    file: 'iconbarActions.ts',
    find: `import path from "path";

import { actions, selectors, types, util } from "@nexusmods/vortex-api";`,
    replace: `import { actions, selectors, types, util } from "@nexusmods/vortex-api";`,
  },
  {
    // Profile load-order backup/restore moves mods.settings; it must look in the same place
    // iniParser writes it. handleMergedScripts already has the discovered game path in props.
    file: 'mergeBackup.ts',
    find: '    const loarOrderFilepath: string = getLoadOrderFilePath();',
    replace: '    const loarOrderFilepath: string = getLoadOrderFilePath(gamePath);',
  },
  {
    // mergers.ts still called getDocumentsPath with the old (game) signature. Those merge
    // handlers are not registered upstream today (registerMerge is commented out), but leave
    // them correct rather than a landmine.
    file: 'mergers.ts',
    ...DOCUMENTS_IMPORT,
  },
  {
    file: 'mergers.ts',
    find: `import { fileExists, getDocumentsPath, isSettingsFile, isXML } from "./util";`,
    replace: `import { fileExists, isSettingsFile, isXML } from "./util";`,
  },
  {
    file: 'mergers.ts',
    find: `            in: path.join(getDocumentsPath(game), path.basename(file.relPath)),`,
    replace: `            in: path.join(
              getWitcher3DocumentsPath(gameDiscovery?.path),
              path.basename(file.relPath),
            ),`,
  },
  {
    file: 'mergers.ts',
    find: `  const gameSettingsFilepath = path.join(getDocumentsPath(discovery), path.basename(modFilePath));`,
    replace: `  const gameSettingsFilepath = path.join(
    getWitcher3DocumentsPath(discovery.path),
    path.basename(modFilePath),
  );`,
  },
];

const srcRoot = process.argv[2];
if (!srcRoot) {
  console.error('usage: node build/patch-witcher3-proton-docs.cjs <upstream source root>');
  process.exit(2);
}
const extDir = path.join(srcRoot, EXT_REL);
if (!fs.existsSync(extDir)) {
  console.error('!! Witcher 3 extension sources not found at ' + extDir);
  process.exit(1);
}

const contents = new Map();
const readFile = (name) => {
  if (!contents.has(name)) {
    contents.set(name, fs.readFileSync(path.join(extDir, name), 'utf8'));
  }
  return contents.get(name);
};

// Check staged contents before writing. Also run on repeat invocations: a marker must
// not hide a newly added call that would fall back to the host documents directory.
function checkGamePaths() {
  const bareCalls = [];
  for (const rel of fs.readdirSync(extDir, { recursive: true })) {
    if (!/\.tsx?$/.test(rel)) {
      continue;
    }
    const text = contents.get(rel) ?? fs.readFileSync(path.join(extDir, rel), 'utf8');
    if (/\b(?:getLoadOrderFilePath|getWitcher3DocumentsPath|getDx12UserSettingsPath)\(\s*\)/.test(text)) {
      bareCalls.push(rel);
    }
  }
  if (bareCalls.length > 0) {
    console.error('!! ' + EXT_REL + ': documents-path helper called without a game path in: ' +
      bareCalls.join(', ') + '. Thread the discovered game path through (see this script). ' +
      'Nothing was written.');
    process.exit(1);
  }
}

// Already patched? Every edit is applied together, so one marker is enough.
if (readFile('common.ts').includes(MARKER)) {
  checkGamePaths();
  console.log('>> witcher3 proton documents: already patched');
  process.exit(0);
}

// 41be6d455656 added this existence check; the older pinned release has no reference
// to the helper in loadOrder.tsx. If a reference is present, require the reviewed code
// instead of silently skipping an unfamiliar use of the helper.
if (/\bgetLoadOrderFilePath\b/.test(readFile('loadOrder.tsx'))) {
  EDITS.push({
    file: 'loadOrder.tsx',
    find: '      if (iniStructure.revertedByPurge || !(await fileExists(getLoadOrderFilePath()))) {',
    replace: `      // ${MARKER}: check for mods.settings inside the discovered game's prefix.
      const discovery = this.mApi.getState().settings.gameMode.discovered[GAME_ID];
      if (
        iniStructure.revertedByPurge ||
        !(await fileExists(getLoadOrderFilePath(discovery?.path)))
      ) {`,
  });
}

// The newer release also checks/fixes dx12user.settings. Route both the health check
// and its fix through the same documents helper; older releases have neither site.
if (/\bgetDx12UserSettingsPath\b/.test(readFile('common.ts'))) {
  EDITS.push(
    {
      file: 'common.ts',
      find: `export function getDx12UserSettingsPath() {
  return path.join(util.getVortexPath("documents"), "The Witcher 3", DX12_USER_SETTINGS_FILENAME);
}`,
      replace: `export function getDx12UserSettingsPath(gamePath?: string) {
  return path.join(getWitcher3DocumentsPath(gamePath), DX12_USER_SETTINGS_FILENAME);
}`,
    },
    {
      file: 'healthChecks.ts',
      find: 'async function enableLocalMods(): Promise<void> {',
      replace: 'async function enableLocalMods(api: types.IExtensionApi): Promise<void> {',
    },
    {
      file: 'healthChecks.ts',
      find: 'getDx12UserSettingsPath()',
      replace: 'getDx12UserSettingsPath(selectors.discoveryByGame(api.getState(), GAME_ID)?.path)',
      all: true,
      expect: 2,
    },
    {
      file: 'healthChecks.ts',
      find: '  fix: () => enableLocalMods(),',
      replace: '  fix: (api) => enableLocalMods(api),',
    },
  );
}

let failures = 0;
for (const edit of EDITS) {
  const text = readFile(edit.file);
  const occurrences = edit.find instanceof RegExp
    ? [...text.matchAll(edit.find)].length
    : text.split(edit.find).length - 1;
  if (edit.all && edit.expect === undefined) {
    throw new Error(edit.file + ': replace-all edits must declare an expected count');
  }
  const wanted = edit.all ? edit.expect : 1;
  if (occurrences !== wanted) {
    console.error('!! ' + edit.file + ': expected ' + wanted + ' occurrence(s) of the anchor, found ' +
      occurrences);
    console.error('   anchor: ' + String(edit.find).split('\n')[0].trim() + ' ...');
    failures++;
    continue;
  }
  contents.set(edit.file, edit.all ? text.split(edit.find).join(edit.replace)
    : text.replace(edit.find, edit.replace));
}

if (failures > 0) {
  console.error('!! Upstream changed the Witcher 3 extension; re-review ' + EXT_REL +
    ' and refresh build/patch-witcher3-proton-docs.cjs. Nothing was written.');
  process.exit(1);
}

checkGamePaths();
for (const [name, text] of contents) {
  fs.writeFileSync(path.join(extDir, name), text);
  console.log('   patched: ' + path.join(EXT_REL, name));
}

console.log('>> witcher3 proton documents: patched ' + contents.size + ' file(s)');
