#!/usr/bin/env node
/*
 * patch-witcher3-proton-docs.cjs — point the Witcher 3 extension at the Proton prefix.
 *
 * The Witcher 3 has no native Linux build; it runs through a Steam Proton (Wine) prefix
 * and reads its "Documents" folder from inside that prefix:
 *   <library>/steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/Documents/The Witcher 3
 * Upstream's extension uses util.getVortexPath('documents'), which on Linux is the XDG
 * documents dir (~/Documents). So the load order file (mods.settings) and menu mods are
 * written where the game will never look for them: mod priorities and enable/disable flags
 * have no effect in game, and menu mods do nothing.
 *
 * This rewrites the extension's two documents-path helpers to resolve the prefix from the
 * discovered game path, falling back to Vortex's documents path on Windows or when no
 * prefix is found (GOG/Epic/Heroic layouts keep the old behaviour).
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

const EDITS = [
  {
    file: 'common.ts',
    find: `export function getLoadOrderFilePath() {
  return path.join(util.getVortexPath("documents"), "The Witcher 3", LOAD_ORDER_FILENAME);
}`,
    replace: `// ${MARKER}: The Witcher 3 has no native Linux build - it runs in a Steam
// Proton (Wine) prefix and reads "Documents" from inside that prefix, not from the XDG
// documents directory util.getVortexPath("documents") reports. Writing mods.settings to
// ~/Documents means the game never sees the load order. Resolve the prefix from the
// discovered game path; fall back to Vortex's documents path on Windows, or when the game
// isn't a Steam/Proton install (GOG, Epic, Heroic, ...).
const STEAM_APP_IDS = ["292030", "499450"];

export function getGameDocumentsRoot(gamePath?: string) {
  const fallback = util.getVortexPath("documents");
  if (process.platform !== "linux" || !gamePath) {
    return fallback;
  }
  // <library>/steamapps/common/The Witcher 3 -> <library>/steamapps
  const steamApps = path.resolve(gamePath, "..", "..");
  const users = ["steamuser"];
  if (process.env.USER) {
    users.push(process.env.USER);
  }
  for (const appId of STEAM_APP_IDS) {
    for (const user of users) {
      const documents = path.join(
        steamApps,
        "compatdata",
        appId,
        "pfx",
        "drive_c",
        "users",
        user,
        "Documents",
      );
      try {
        if (fs.statSync(documents).isDirectory()) {
          return documents;
        }
      } catch (err) {
        // no prefix at this candidate, try the next one
      }
    }
  }
  return fallback;
}

export function getGameDocumentsPath(gamePath?: string) {
  return path.join(getGameDocumentsRoot(gamePath), "The Witcher 3");
}

export function getLoadOrderFilePath(gamePath?: string) {
  return path.join(getGameDocumentsPath(gamePath), LOAD_ORDER_FILENAME);
}`,
  },
  {
    file: 'util.ts',
    find: `import {
  GAME_ID,
  LOCKED_PREFIX,
  I18N_NAMESPACE,
  ACTIVITY_ID_IMPORTING_LOADORDER,
  PART_SUFFIX,
} from "./common";`,
    replace: `import {
  GAME_ID,
  LOCKED_PREFIX,
  I18N_NAMESPACE,
  ACTIVITY_ID_IMPORTING_LOADORDER,
  PART_SUFFIX,
  getGameDocumentsPath,
} from "./common";`,
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
    return getGameDocumentsPath(discovery?.path);
  };
};`,
  },
  {
    file: 'iniParser.ts',
    find: `  public async getIniStructure() {
    return this.mIniStruct;
  }`,
    replace: `  // ${MARKER}: the load order file lives in the game's documents folder, which is
  // inside the Proton prefix on Linux, so its location depends on where the game is.
  private gamePath(): string {
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

// Already patched? Every edit is applied together, so one marker is enough.
if (readFile('common.ts').includes(MARKER)) {
  console.log('>> witcher3 proton documents: already patched');
  process.exit(0);
}

let failures = 0;
for (const edit of EDITS) {
  const text = readFile(edit.file);
  const occurrences = text.split(edit.find).length - 1;
  const wanted = edit.all ? (edit.expect || occurrences) : 1;
  if (occurrences !== wanted) {
    console.error('!! ' + edit.file + ': expected ' + wanted + ' occurrence(s) of the anchor, found ' +
      occurrences);
    console.error('   anchor: ' + edit.find.split('\n')[0].trim() + ' ...');
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

for (const [name, text] of contents) {
  fs.writeFileSync(path.join(extDir, name), text);
  console.log('   patched: ' + path.join(EXT_REL, name));
}
console.log('>> witcher3 proton documents: patched ' + contents.size + ' file(s)');
