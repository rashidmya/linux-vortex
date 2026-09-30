#!/usr/bin/env node
/*
 * test-game-paths.cjs — verify the Proton game paths helper against a fake Steam library.
 *
 * A game running under Steam Proton reads its "Documents" and "%LOCALAPPDATA%" from inside
 * its compatdata prefix, not from the host's XDG directories that util.getVortexPath()
 * reports. build/patch-linux-game-paths.cjs installs a helper into Vortex core that maps a
 * discovered game path to that prefix (see build/patches/vortex/gamePaths.ts), and gives
 * every extension a getVortexPath that resolves those folders for the game it works for.
 *
 * This transpiles that TypeScript file with the TypeScript compiler, stubs its Vortex
 * imports (getVortexPath, log), and runs it against a Steam library built in a temp dir.
 * Every test gets a freshly loaded helper, so what one test leaves in the helper's prefix
 * cache can't make another pass.
 *
 * Usage: node qa/test-game-paths.cjs <path to gamePaths.ts> [--typescript <typescript pkg dir>]
 * The compiler is resolved from --typescript, then $TYPESCRIPT_DIR, then a normal require.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const helperPath = args[0];
if (!helperPath) {
  console.error('usage: node qa/test-game-paths.cjs <gamePaths.ts> [--typescript <dir>]');
  process.exit(2);
}
const tsFlag = args.indexOf('--typescript');
const tsDir = tsFlag !== -1 ? args[tsFlag + 1] : process.env.TYPESCRIPT_DIR;
let ts;
try {
  ts = require(tsDir ? path.resolve(tsDir) : 'typescript');
} catch (err) {
  console.error('!! typescript compiler not found (' + (tsDir || 'require("typescript")') + '): ' +
    err.message);
  process.exit(2);
}

// Every getVortexPath() lookup is recorded so a test can assert the fallback was (not) used.
const hostLookups = [];
const getVortexPathStub = (id) => {
  hostLookups.push(id);
  return path.join('/host', id);
};
const host = (id) => path.join('/host', id);

const compiled = ts.transpileModule(fs.readFileSync(path.resolve(helperPath), 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: path.resolve(helperPath),
}).outputText;

function loadHelper() {
  const file = path.resolve(helperPath);
  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod.require = (id) => {
    if (id === '../getVortexPath') {
      return { __esModule: true, default: getVortexPathStub };
    }
    if (id === '../log') {
      return { __esModule: true, log: () => undefined };
    }
    return require(id);
  };
  mod._compile(compiled, file);
  return mod.exports;
}

// --- fixture: one Steam library plus a GOG-style install outside it ---------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-vortex-gamepaths-'));
const steamApps = path.join(tmpDir, 'library', 'steamapps');
const common = (dir) => path.join(steamApps, 'common', dir);
const prefixUser = (appId) =>
  path.join(steamApps, 'compatdata', appId, 'pfx', 'drive_c', 'users', 'steamuser');
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const manifest = (dir, appId, installdir) =>
  fs.writeFileSync(
    path.join(dir, 'appmanifest_' + appId + '.acf'),
    '"AppState"\n{\n\t"appid"\t\t"' + appId + '"\n\t"installdir"\t\t"' + installdir + '"\n}\n',
  );
// A Steam game in the fixture library; a prefix is created unless withPrefix is false.
const steamGame = (dir, appId, withPrefix = true) => {
  mkdir(common(dir));
  manifest(steamApps, appId, dir);
  if (withPrefix) {
    mkdir(prefixUser(appId));
  }
  return common(dir);
};

steamGame('The Witcher 3', '292030');
mkdir(path.join(prefixUser('292030'), 'Documents'));

steamGame('The Witcher 3 GOTY', '499450');

steamGame('Team Fortress 2', '440', false); // native Linux game: no compatdata

// A manifest that cannot be read as a file (it is a directory). Sorts before the others so
// the scan hits it first and must skip it rather than throw.
mkdir(path.join(steamApps, 'appmanifest_100.acf'));

const gogGame = path.join(tmpDir, 'gog', 'The Witcher 3');
mkdir(gogGame);

// Two manifests match the same installdir: appmanifest_1 has no prefix, appmanifest_2 does.
// With sorted scanning, 1 is visited first and must be passed over for 2.
mkdir(common('Dup'));
manifest(steamApps, '1', 'Dup');
manifest(steamApps, '2', 'Dup');
mkdir(prefixUser('2'));

// A library whose path segments aren't lowercase (Steam on a case-insensitive fs, or a
// user-created library) must still be recognised.
const steamApps2 = path.join(tmpDir, 'Library2', 'SteamApps');
mkdir(path.join(steamApps2, 'Common', 'Some Game'));
manifest(steamApps2, '777', 'Some Game');
mkdir(path.join(steamApps2, 'compatdata', '777', 'pfx', 'drive_c', 'users', 'steamuser'));

// Games the per-extension tests resolve. Each belongs to the extension of the same name;
// game-fallout4 and game-fallout4vr are the pair whose paths share a prefix.
const GAMES = {
  witcher3: { dir: common('The Witcher 3'), appId: '292030', ext: 'game-witcher3' },
  tf2: { dir: common('Team Fortress 2'), ext: 'game-tf2' },
  fallout4: { dir: steamGame('Fallout 4', '377160'), appId: '377160', ext: 'game-fallout4' },
  fallout4vr: { dir: steamGame('Fallout 4 VR', '611660'), appId: '611660', ext: 'game-fallout4vr' },
  multia: { dir: steamGame('Multi A', '3001'), appId: '3001', ext: 'game-multi' },
  multib: { dir: steamGame('Multi B', '3002'), appId: '3002', ext: 'game-multi' },
  goggame: { dir: gogGame, ext: 'game-gog' },
};
const extDir = (name) => path.join(tmpDir, 'plugins', name);
const SHARED_EXT = extDir('gamebryo-shared');

// The slice of Vortex's store the helper reads. One profile per game, "p-<gameId>".
function makeState({ active, next, known = Object.keys(GAMES), discovered = Object.keys(GAMES) }) {
  return {
    settings: {
      profiles: {
        activeProfileId: active !== undefined ? 'p-' + active : undefined,
        nextProfileId: next !== undefined ? 'p-' + next : undefined,
      },
      gameMode: {
        discovered: Object.fromEntries(discovered.map((id) => [id, { path: GAMES[id].dir }])),
      },
    },
    persistent: {
      profiles: Object.fromEntries(Object.keys(GAMES).map((id) => ['p-' + id, { gameId: id }])),
    },
    session: {
      gameMode: {
        known: known.map((id) => ({ id, extensionPath: extDir(GAMES[id].ext) })),
      },
    },
  };
}

// --- tests -----------------------------------------------------------------------------
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const withPlatform = (platform, fn) => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
};
const onLinux = (fn) => withPlatform('linux', fn);

test('documents resolve inside the Proton prefix of a Steam game', (h) => {
  const result = onLinux(() => h.getGameDocumentsPath(common('The Witcher 3')));
  assert.strictEqual(result, path.join(prefixUser('292030'), 'Documents'));
});

test('local appdata resolves inside the same prefix', (h) => {
  const result = onLinux(() => h.getGameLocalAppDataPath(common('The Witcher 3')));
  assert.strictEqual(result, path.join(prefixUser('292030'), 'AppData', 'Local'));
});

test('the app id comes from the manifest, not a hardcoded list', (h) => {
  const result = onLinux(() => h.getProtonUserDir(common('The Witcher 3 GOTY')));
  assert.strictEqual(result, prefixUser('499450'));
});

test('installdir matching is case-insensitive', (h) => {
  const result = onLinux(() => h.getProtonUserDir(common('the WITCHER 3')));
  assert.strictEqual(result, prefixUser('292030'));
});

test('a Steam game without a compatdata prefix falls back to the host documents', (h) => {
  hostLookups.length = 0;
  const result = onLinux(() => h.getGameDocumentsPath(common('Team Fortress 2')));
  assert.strictEqual(result, host('documents'));
  assert.deepStrictEqual(hostLookups, ['documents']);
});

test('a game outside steamapps/common falls back to the host documents', (h) => {
  const result = onLinux(() => h.getGameDocumentsPath(gogGame));
  assert.strictEqual(result, host('documents'));
});

test('an unreadable manifest is skipped, not fatal', (h) => {
  // appmanifest_100.acf is a directory and is scanned before 292030.
  const result = onLinux(() => h.getProtonUserDir(common('The Witcher 3')));
  assert.strictEqual(result, prefixUser('292030'));
});

test('a missing game path falls back to the host local appdata', (h) => {
  hostLookups.length = 0;
  const result = onLinux(() => h.getGameLocalAppDataPath(undefined));
  assert.strictEqual(result, host('localAppData'));
  assert.deepStrictEqual(hostLookups, ['localAppData']);
});

test('off Linux the host path is returned without looking for a prefix', (h) => {
  const result = withPlatform('win32', () => h.getGameDocumentsPath(common('The Witcher 3')));
  assert.strictEqual(result, host('documents'));
  const userDir = withPlatform('win32', () => h.getProtonUserDir(common('The Witcher 3')));
  assert.strictEqual(userDir, undefined);
});

test('a steamapps dir that cannot be listed falls back', (h) => {
  const result = onLinux(() =>
    h.getGameDocumentsPath(path.join(tmpDir, 'missing', 'steamapps', 'common', 'Game')));
  assert.strictEqual(result, host('documents'));
});

test('steamapps/common segments are matched case-insensitively', (h) => {
  const result = onLinux(() => h.getProtonUserDir(path.join(steamApps2, 'Common', 'Some Game')));
  assert.strictEqual(
    result,
    path.join(steamApps2, 'compatdata', '777', 'pfx', 'drive_c', 'users', 'steamuser'),
  );
});

test('a matching manifest without a prefix is passed over for one that has it', (h) => {
  const result = onLinux(() => h.getProtonUserDir(common('Dup')));
  assert.strictEqual(result, prefixUser('2'));
});

test('a resolved prefix never consults the host fallback', (h) => {
  hostLookups.length = 0;
  const result = onLinux(() => h.getGameDocumentsPath(common('The Witcher 3')));
  assert.strictEqual(result, path.join(prefixUser('292030'), 'Documents'));
  assert.deepStrictEqual(hostLookups, []);
});

test('Documents is returned even when the game has not created it yet', (h) => {
  const result = onLinux(() => h.getGameDocumentsPath(common('The Witcher 3 GOTY')));
  assert.strictEqual(result, path.join(prefixUser('499450'), 'Documents'));
});

// --- prefix cache ----------------------------------------------------------------------

test('a found prefix is remembered, and dropped once Steam deletes it', (h) => {
  const game = steamGame('Cached Game', '9001');
  assert.strictEqual(onLinux(() => h.getProtonUserDir(game)), prefixUser('9001'));
  // Without the manifest a fresh scan can't find the prefix, so this answer is the cache's.
  fs.rmSync(path.join(steamApps, 'appmanifest_9001.acf'));
  assert.strictEqual(onLinux(() => h.getProtonUserDir(game)), prefixUser('9001'));
  fs.rmSync(path.join(steamApps, 'compatdata', '9001'), { recursive: true });
  assert.strictEqual(onLinux(() => h.getProtonUserDir(game)), undefined);
});

test('a prefix created after a miss is found once the miss expires', (h) => {
  const game = steamGame('First Launch', '9002', false);
  assert.strictEqual(onLinux(() => h.getProtonUserDir(game)), undefined);
  mkdir(prefixUser('9002')); // the user runs the game through Proton for the first time
  assert.strictEqual(onLinux(() => h.getProtonUserDir(game)), undefined);
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 1000;
  try {
    assert.strictEqual(onLinux(() => h.getProtonUserDir(game)), prefixUser('9002'));
  } finally {
    Date.now = realNow;
  }
});

// --- getVortexPathForExtension ---------------------------------------------------------

const forExt = (h, id, ext, state) =>
  onLinux(() => h.getVortexPathForExtension(id, ext, () => state));

test("a game extension's Windows folders resolve inside its game's prefix", (h) => {
  const state = makeState({ active: 'witcher3' });
  const ext = extDir('game-witcher3');
  assert.strictEqual(forExt(h, 'documents', ext, state),
    path.join(prefixUser('292030'), 'Documents'));
  assert.strictEqual(forExt(h, 'localAppData', ext, state),
    path.join(prefixUser('292030'), 'AppData', 'Local'));
  assert.strictEqual(forExt(h, 'appData', ext, state),
    path.join(prefixUser('292030'), 'AppData', 'Roaming'));
});

test('a game extension resolves its own game while another game is managed', (h) => {
  const state = makeState({ active: 'fallout4', next: 'witcher3' });
  assert.strictEqual(forExt(h, 'documents', extDir('game-witcher3'), state),
    path.join(prefixUser('292030'), 'Documents'));
  assert.strictEqual(forExt(h, 'documents', extDir('game-fallout4'), state),
    path.join(prefixUser('377160'), 'Documents'));
});

test('extensions are matched to their games exactly, not by path prefix', (h) => {
  const state = makeState({ active: 'fallout4vr' });
  assert.strictEqual(forExt(h, 'documents', extDir('game-fallout4'), state),
    path.join(prefixUser('377160'), 'Documents'));
  assert.strictEqual(forExt(h, 'documents', extDir('game-fallout4vr'), state),
    path.join(prefixUser('611660'), 'Documents'));
  // a trailing separator on the extension path is the same extension
  assert.strictEqual(forExt(h, 'documents', extDir('game-fallout4vr') + path.sep, state),
    path.join(prefixUser('611660'), 'Documents'));
  // game-fallout4vr must not count Fallout 4 as one of its games when Fallout 4 is managed
  const fallout4 = makeState({ active: 'fallout4' });
  assert.strictEqual(forExt(h, 'documents', extDir('game-fallout4vr'), fallout4),
    path.join(prefixUser('611660'), 'Documents'));
});

test('a shared extension resolves documents and local appdata for the managed game', (h) => {
  const state = makeState({ active: 'fallout4' });
  assert.strictEqual(forExt(h, 'documents', SHARED_EXT, state),
    path.join(prefixUser('377160'), 'Documents'));
  assert.strictEqual(forExt(h, 'localAppData', SHARED_EXT, state),
    path.join(prefixUser('377160'), 'AppData', 'Local'));
});

test('a shared extension keeps the host roaming appdata', (h) => {
  hostLookups.length = 0;
  const state = makeState({ active: 'fallout4' });
  assert.strictEqual(forExt(h, 'appData', SHARED_EXT, state), host('appData'));
  assert.deepStrictEqual(hostLookups, ['appData']);
});

test('a shared extension follows a game switch that is in progress', (h) => {
  // setup for the new game runs before the switch is recorded as the active profile
  const state = makeState({ active: 'witcher3', next: 'fallout4' });
  assert.strictEqual(forExt(h, 'documents', SHARED_EXT, state),
    path.join(prefixUser('377160'), 'Documents'));
});

test('a shared extension with no game managed gets host folders', (h) => {
  const state = makeState({});
  assert.strictEqual(forExt(h, 'documents', SHARED_EXT, state), host('documents'));
});

test('a multi-game extension resolves the managed game if it is one of them', (h) => {
  const state = makeState({ active: 'multib' });
  assert.strictEqual(forExt(h, 'documents', extDir('game-multi'), state),
    path.join(prefixUser('3002'), 'Documents'));
});

test('a multi-game extension gets host folders when none of its games is managed', (h) => {
  const state = makeState({ active: 'witcher3' });
  assert.strictEqual(forExt(h, 'documents', extDir('game-multi'), state), host('documents'));
});

test('folders other than documents and appdata are never redirected', (h) => {
  hostLookups.length = 0;
  const state = makeState({ active: 'witcher3' });
  const ext = extDir('game-witcher3');
  for (const id of ['home', 'userData', 'temp', 'desktop', 'bundledPlugins']) {
    assert.strictEqual(forExt(h, id, ext, state), host(id));
  }
  assert.deepStrictEqual(hostLookups, ['home', 'userData', 'temp', 'desktop', 'bundledPlugins']);
});

test('a native Linux game (no prefix) gets host folders', (h) => {
  const state = makeState({ active: 'tf2' });
  assert.strictEqual(forExt(h, 'documents', extDir('game-tf2'), state), host('documents'));
});

test('a non-Steam game gets host folders', (h) => {
  const state = makeState({ active: 'goggame' });
  assert.strictEqual(forExt(h, 'documents', extDir('game-gog'), state), host('documents'));
});

test('an undiscovered game gets host folders', (h) => {
  const state = makeState({ active: 'witcher3', discovered: [] });
  assert.strictEqual(forExt(h, 'documents', extDir('game-witcher3'), state), host('documents'));
});

test('off Linux nothing is redirected', (h) => {
  const state = makeState({ active: 'witcher3' });
  const result = withPlatform('win32', () =>
    h.getVortexPathForExtension('documents', extDir('game-witcher3'), () => state));
  assert.strictEqual(result, host('documents'));
});

test('before the store exists, or before games are in it, nothing is redirected', (h) => {
  // extensions compute load-time constants before either exists
  assert.strictEqual(forExt(h, 'documents', extDir('game-witcher3'), undefined), host('documents'));
  // with no known games a game extension can't be told from a shared one
  const state = makeState({ active: 'fallout4', known: [] });
  assert.strictEqual(forExt(h, 'documents', extDir('game-witcher3'), state), host('documents'));
});

test('a state that cannot be read falls back instead of throwing', (h) => {
  const throwing = onLinux(() => h.getVortexPathForExtension('documents', SHARED_EXT, () => {
    throw new Error('store not ready');
  }));
  assert.strictEqual(throwing, host('documents'));
  const malformed = { session: { gameMode: { known: [{ id: 'x', extensionPath: 42 }] } } };
  assert.strictEqual(forExt(h, 'documents', SHARED_EXT, malformed), host('documents'));
});

test("the per-extension util answers getVortexPath and passes the rest through live", (h) => {
  const state = makeState({ active: 'witcher3' });
  const util = { getVortexPath: getVortexPathStub, getSafe: () => 'safe', version: 1 };
  const extUtil = h.utilForExtension(util, extDir('game-witcher3'), () => state);
  assert.strictEqual(onLinux(() => extUtil.getVortexPath('documents')),
    path.join(prefixUser('292030'), 'Documents'));
  assert.strictEqual(onLinux(() => extUtil.getVortexPath('temp')), host('temp'));
  assert.strictEqual(extUtil.getSafe(), 'safe');
  util.version = 2;
  assert.strictEqual(extUtil.version, 2);
  // destructuring (common in extensions) gets the per-extension function too
  const { getVortexPath } = extUtil;
  assert.strictEqual(onLinux(() => getVortexPath('documents')),
    path.join(prefixUser('292030'), 'Documents'));
});

(async () => {
  console.log('gamePaths helper under test: ' + path.resolve(helperPath));
  for (const { name, fn } of tests) {
    try {
      await fn(loadHelper());
      console.log('  PASS  ' + name);
    } catch (err) {
      failed++;
      console.log('  FAIL  ' + name);
      console.log('        ' + String(err.message || err).split('\n').join('\n        '));
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(failed === 0
    ? `\nGAME PATHS OK (${tests.length}/${tests.length} passed)`
    : `\n!! ${failed}/${tests.length} game paths tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
