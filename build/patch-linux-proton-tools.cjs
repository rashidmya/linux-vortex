#!/usr/bin/env node
/*
 * patch-linux-proton-tools.cjs — run extension-launched Windows tools through Proton.
 *
 * Vortex already knows how to run Windows executables on Linux: StarterInfo.runDirectly
 * checks shouldRunWithProton() and hands game/tool launches to Steam.runToolWithProton(),
 * which invokes `<proton>/proton run <exe>` in the game's compatibility prefix.
 *
 * Extensions that call api.runExecutable() directly bypass all of that. The Witcher 3
 * extension's "Run tool" action for the script merger does exactly that
 * (extensions/games/game-witcher3/src/eventHandlers.ts, runScriptMerger), as do
 * fnis-integration, gamestore-gog and most community game extensions. Spawning a PE binary
 * on Linux fails with EACCES, which Vortex renders as the misleading
 *   "Network connect was not permitted, please check your firewall settings"
 *
 * Patch 1 (ExtensionManager.ts): api.runExecutable applies the same Proton routing, so every
 * caller benefits instead of only the ones that go through StarterInfo.
 *
 * Patch 2 (util/linux/proton.ts): when Steam has no explicit Proton mapping for the game,
 * prefer the Proton build that actually created the prefix (recorded in compatdata's
 * config_info) over "newest installed". Running a different build against a prefix makes
 * Proton upgrade/downgrade it behind the user's back.
 *
 * Usage: node build/patch-linux-proton-tools.cjs <upstream Vortex source root>
 * Idempotent; fails the build if any anchor is missing.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MARKER = '[linux-vortex] proton tools';
const EXT_MANAGER = path.join('src', 'renderer', 'src', 'ExtensionManager.ts');
const PROTON = path.join('src', 'renderer', 'src', 'util', 'linux', 'proton.ts');

const EDITS = [
  {
    file: EXT_MANAGER,
    find: `import lazyRequire from "./util/lazyRequire";
import { showError } from "./util/message";`,
    replace: `import lazyRequire from "./util/lazyRequire";
import { isWindowsExecutable } from "./util/linux/proton";
import { showError } from "./util/message";`,
  },
  {
    file: EXT_MANAGER,
    find: `import { activeGameId } from "./util/selectors";`,
    replace: `import { activeGameId } from "./util/selectors";
import type { ISteamEntry, Steam } from "./util/Steam";`,
  },
  {
    file: EXT_MANAGER,
    find: `  private runExecutable = (
    executable: string,
    args: string[],
    options: IRunOptions,
  ): PromiseBB<void> => {
    if (!truthy(executable)) {
      return PromiseBB.reject(new ProcessCanceled("Executable not set"));
    }
    const interpreter = this.mInterpreters[path.extname(executable).toLowerCase()];`,
    replace: `  private getSteamStore = (): Steam | undefined => {
    // ${MARKER}: required lazily - importing the game store modules at module scope
    // would introduce an import cycle through ExtensionManager.
    const helperModule = require("./util/GameStoreHelper");
    const helper = helperModule.default ?? helperModule;
    return helper.getGameStore("steam") as Steam;
  };

  /**
   * ${MARKER}: find the Proton-enabled Steam game a Windows executable belongs to, if any.
   * Mirrors what StarterInfo does for game/tool launches, minus the discovery "store"
   * requirement - the executable being inside a Steam game folder is the actual evidence.
   */
  private findProtonGameFor = async (exePath: string): Promise<ISteamEntry | undefined> => {
    try {
      const games = (await this.getSteamStore()?.allGames()) ?? [];
      const match = games.find((game) =>
        exePath.toLowerCase().startsWith(game.gamePath.toLowerCase()),
      );
      return match?.usesProton ? match : undefined;
    } catch (err) {
      log("debug", "could not determine whether to run through Proton", {
        executable: exePath,
        error: getErrorMessageOrDefault(err),
      });
      return undefined;
    }
  };

  /**
   * ${MARKER}: a Windows executable can't be spawned on Linux - the kernel rejects the PE
   * binary with EACCES, which Vortex reports as a misleading firewall error. Vortex knows how
   * to run these (StarterInfo routes launches through the game's Proton prefix), but
   * extensions calling api.runExecutable directly bypass that - the Witcher 3 script merger,
   * FNIS and most community game extensions do. Apply the same routing for every caller.
   */
  private runExecutable = (
    executable: string,
    args: string[],
    options: IRunOptions,
  ): PromiseBB<void> => {
    if (!truthy(executable)) {
      return PromiseBB.reject(new ProcessCanceled("Executable not set"));
    }
    if (process.platform === "win32" || !isWindowsExecutable(executable)) {
      return this.runExecutableDirect(executable, args, options);
    }
    return PromiseBB.resolve(this.findProtonGameFor(executable)).then((gameEntry) => {
      const steamStore = gameEntry !== undefined ? this.getSteamStore() : undefined;
      if (gameEntry === undefined || steamStore === undefined) {
        return this.runExecutableDirect(executable, args, options);
      }
      log("info", "running Windows executable through Proton", {
        executable,
        game: gameEntry.name,
      });
      // runToolWithProton re-enters runExecutable with the proton launcher, which isn't a
      // Windows executable, so this doesn't recurse.
      return PromiseBB.resolve(
        steamStore.runToolWithProton(
          this.mApi,
          executable,
          args,
          { ...options, cwd: options.cwd ?? path.dirname(executable) },
          gameEntry,
        ),
      );
    });
  };

  private runExecutableDirect = (
    executable: string,
    args: string[],
    options: IRunOptions,
  ): PromiseBB<void> => {
    const interpreter = this.mInterpreters[path.extname(executable).toLowerCase()];`,
  },
  {
    file: PROTON,
    find: `  if (!protonPath) {
    protonPath = await findLatestProton(steamPath);
  }`,
    replace: `  if (!protonPath) {
    // ${MARKER}: Steam has no explicit mapping for this game (it's on the default), so
    // prefer the Proton build that actually created/last updated this prefix - running a
    // different build against it makes Proton upgrade or downgrade the prefix behind the
    // user's back.
    protonPath = await getProtonFromCompatData(compatDataPath);
  }

  if (!protonPath) {
    protonPath = await findLatestProton(steamPath);
  }`,
  },
  {
    file: PROTON,
    find: `/**
 * Find the latest installed Proton version (fallback)
 */`,
    replace: `/**
 * ${MARKER}: Read the Proton installation that created/last updated a prefix.
 * Proton records the dist paths of the build that owns the prefix in compatdata/config_info.
 */
export async function getProtonFromCompatData(compatDataPath: string): Promise<string | undefined> {
  const marker = \`\${path.sep}files\${path.sep}\`;
  try {
    const configInfo = await fs.readFileAsync(path.join(compatDataPath, "config_info"), "utf8");
    for (const line of configInfo.toString().split("\\n")) {
      const idx = line.indexOf(marker);
      if (idx === -1) {
        continue;
      }
      const candidate = line.slice(0, idx);
      if (await pathExists(path.join(candidate, "proton"))) {
        return candidate;
      }
    }
  } catch (err: any) {
    log("debug", "Could not read compatdata config_info", { error: err?.message });
  }
  return undefined;
}

/**
 * Find the latest installed Proton version (fallback)
 */`,
  },
];

const srcRoot = process.argv[2];
if (!srcRoot) {
  console.error('usage: node build/patch-linux-proton-tools.cjs <upstream source root>');
  process.exit(2);
}
const abs = (rel) => path.join(srcRoot, rel);
for (const rel of [EXT_MANAGER, PROTON]) {
  if (!fs.existsSync(abs(rel))) {
    console.error('!! not found: ' + abs(rel));
    process.exit(1);
  }
}

const contents = new Map();
const readFile = (rel) => {
  if (!contents.has(rel)) {
    contents.set(rel, fs.readFileSync(abs(rel), 'utf8'));
  }
  return contents.get(rel);
};

if (readFile(EXT_MANAGER).includes(MARKER)) {
  console.log('>> proton tool routing: already patched');
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
  console.error('!! Upstream changed; re-review the Proton tool routing patch. Nothing was written.');
  process.exit(1);
}

for (const [rel, text] of contents) {
  fs.writeFileSync(abs(rel), text);
  console.log('   patched: ' + rel);
}
console.log('>> proton tool routing: patched ' + contents.size + ' file(s)');
