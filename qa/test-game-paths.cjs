#!/usr/bin/env node
/*
 * test-game-paths.cjs — verify the Proton game paths helper against a fake Steam library.
 *
 * A game running under Steam Proton reads its "Documents" and "%LOCALAPPDATA%" from inside
 * its compatdata prefix, not from the host's XDG directories that util.getVortexPath()
 * reports. build/patch-linux-game-paths.cjs installs a helper into Vortex core that maps a
 * discovered game path to that prefix (see build/patches/vortex/gamePaths.ts).
 *
 * This transpiles that TypeScript file with the TypeScript compiler, stubs its one Vortex
 * import (getVortexPath), and runs it against a Steam library built in a temp dir.
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

function loadHelper(file) {
  const source = fs.readFileSync(file, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: file,
  });
  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod.require = (id) => {
    if (id === '../getVortexPath') {
      return { __esModule: true, default: getVortexPathStub };
    }
    return require(id);
  };
  mod._compile(outputText, file);
  return mod.exports;
}

const helper = loadHelper(path.resolve(helperPath));
const { getGameDocumentsPath, getGameLocalAppDataPath, getProtonUserDir } = helper;

// --- fixture: one Steam library plus a GOG-style install outside it ---------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-vortex-gamepaths-'));
const steamApps = path.join(tmpDir, 'library', 'steamapps');
const common = (dir) => path.join(steamApps, 'common', dir);
const prefixUser = (appId) =>
  path.join(steamApps, 'compatdata', appId, 'pfx', 'drive_c', 'users', 'steamuser');
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const manifest = (appId, installdir) =>
  fs.writeFileSync(
    path.join(steamApps, 'appmanifest_' + appId + '.acf'),
    '"AppState"\n{\n\t"appid"\t\t"' + appId + '"\n\t"installdir"\t\t"' + installdir + '"\n}\n',
  );

mkdir(common('The Witcher 3'));
manifest('292030', 'The Witcher 3');
mkdir(path.join(prefixUser('292030'), 'Documents'));

mkdir(common('The Witcher 3 GOTY'));
manifest('499450', 'The Witcher 3 GOTY');
mkdir(prefixUser('499450'));

mkdir(common('Team Fortress 2'));
manifest('440', 'Team Fortress 2'); // native Linux game: no compatdata

// A manifest that cannot be read as a file (it is a directory). Sorts before the others so
// the scan hits it first and must skip it rather than throw.
mkdir(path.join(steamApps, 'appmanifest_100.acf'));

const gogGame = path.join(tmpDir, 'gog', 'The Witcher 3');
mkdir(gogGame);

// Two manifests match the same installdir: appmanifest_1 has no prefix, appmanifest_2 does.
// With sorted scanning, 1 is visited first and must be passed over for 2.
mkdir(common('Dup'));
manifest('1', 'Dup');
manifest('2', 'Dup');
mkdir(prefixUser('2'));

// A library whose path segments aren't lowercase (Steam on a case-insensitive fs, or a
// user-created library) must still be recognised.
const steamApps2 = path.join(tmpDir, 'Library2', 'SteamApps');
mkdir(path.join(steamApps2, 'Common', 'Some Game'));
fs.writeFileSync(path.join(steamApps2, 'appmanifest_777.acf'),
  '"AppState"\n{\n\t"appid"\t\t"777"\n\t"installdir"\t\t"Some Game"\n}\n');
mkdir(path.join(steamApps2, 'compatdata', '777', 'pfx', 'drive_c', 'users', 'steamuser'));

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

test('documents resolve inside the Proton prefix of a Steam game', () => {
  const result = withPlatform('linux', () => getGameDocumentsPath(common('The Witcher 3')));
  assert.strictEqual(result, path.join(prefixUser('292030'), 'Documents'));
});

test('local appdata resolves inside the same prefix', () => {
  const result = withPlatform('linux', () => getGameLocalAppDataPath(common('The Witcher 3')));
  assert.strictEqual(result, path.join(prefixUser('292030'), 'AppData', 'Local'));
});

test('the app id comes from the manifest, not a hardcoded list', () => {
  const result = withPlatform('linux', () => getProtonUserDir(common('The Witcher 3 GOTY')));
  assert.strictEqual(result, prefixUser('499450'));
});

test('installdir matching is case-insensitive', () => {
  const result = withPlatform('linux', () => getProtonUserDir(common('the WITCHER 3')));
  assert.strictEqual(result, prefixUser('292030'));
});

test('a Steam game without a compatdata prefix falls back to the host documents', () => {
  hostLookups.length = 0;
  const result = withPlatform('linux', () => getGameDocumentsPath(common('Team Fortress 2')));
  assert.strictEqual(result, path.join('/host', 'documents'));
  assert.deepStrictEqual(hostLookups, ['documents']);
});

test('a game outside steamapps/common falls back to the host documents', () => {
  const result = withPlatform('linux', () => getGameDocumentsPath(gogGame));
  assert.strictEqual(result, path.join('/host', 'documents'));
});

test('an unreadable manifest is skipped, not fatal', () => {
  // appmanifest_100.acf is a directory and is scanned before 292030.
  const result = withPlatform('linux', () => getProtonUserDir(common('The Witcher 3')));
  assert.strictEqual(result, prefixUser('292030'));
});

test('a missing game path falls back to the host local appdata', () => {
  hostLookups.length = 0;
  const result = withPlatform('linux', () => getGameLocalAppDataPath(undefined));
  assert.strictEqual(result, path.join('/host', 'localAppData'));
  assert.deepStrictEqual(hostLookups, ['localAppData']);
});

test('off Linux the host path is returned without looking for a prefix', () => {
  const result = withPlatform('win32', () => getGameDocumentsPath(common('The Witcher 3')));
  assert.strictEqual(result, path.join('/host', 'documents'));
  const userDir = withPlatform('win32', () => getProtonUserDir(common('The Witcher 3')));
  assert.strictEqual(userDir, undefined);
});

test('a steamapps dir that cannot be listed falls back', () => {
  const result = withPlatform('linux', () =>
    getGameDocumentsPath(path.join(tmpDir, 'missing', 'steamapps', 'common', 'Game')));
  assert.strictEqual(result, path.join('/host', 'documents'));
});

test('steamapps/common segments are matched case-insensitively', () => {
  const result = withPlatform('linux', () =>
    getProtonUserDir(path.join(steamApps2, 'Common', 'Some Game')));
  assert.strictEqual(
    result,
    path.join(steamApps2, 'compatdata', '777', 'pfx', 'drive_c', 'users', 'steamuser'),
  );
});

test('a matching manifest without a prefix is passed over for one that has it', () => {
  const result = withPlatform('linux', () => getProtonUserDir(common('Dup')));
  assert.strictEqual(result, prefixUser('2'));
});

(async () => {
  console.log('gamePaths helper under test: ' + path.resolve(helperPath));
  for (const { name, fn } of tests) {
    try {
      await fn();
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
