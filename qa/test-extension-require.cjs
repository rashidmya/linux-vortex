#!/usr/bin/env node
/*
 * test-extension-require.cjs — verify that extensions get Proton-aware Windows folders.
 *
 * build/patch-linux-game-paths.cjs edits upstream's util/extensionRequire.ts, the require
 * hook that hands each extension its own proxy of the vortex-api module: the proxy's
 * util.getVortexPath resolves "documents"/"localAppData"/"appData" inside the Proton prefix of
 * the extension's game, and a file is attributed to its extension exactly (a plain prefix
 * test gave game-fallout4vr's files to game-fallout4).
 *
 * This transpiles the PATCHED extensionRequire.ts and the installed gamePaths.ts from an
 * upstream tree, stubs the rest of Vortex, and requires "vortex-api" / "redux-act" through
 * the hook the way extension code does, against a fake Steam library.
 *
 * Usage: node qa/test-extension-require.cjs <patched upstream source root>
 *          [--typescript <typescript pkg dir>]
 * The compiler is resolved from --typescript, then $TYPESCRIPT_DIR, then a normal require.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const srcRoot = args[0];
if (!srcRoot) {
  console.error('usage: node qa/test-extension-require.cjs <patched upstream source root> ' +
    '[--typescript <dir>]');
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

const UTIL_DIR = path.join(path.resolve(srcRoot), 'src', 'renderer', 'src', 'util');
const EXT_REQUIRE = path.join(UTIL_DIR, 'extensionRequire.ts');
const GAME_PATHS = path.join(UTIL_DIR, 'linux', 'gamePaths.ts');
for (const file of [EXT_REQUIRE, GAME_PATHS]) {
  if (!fs.existsSync(file)) {
    console.error('!! not found: ' + file + ' (run build/patch-linux-game-paths.cjs first)');
    process.exit(2);
  }
}

// Transpile a TypeScript file and load it with the given module ids replaced by stubs.
function load(file, stubs) {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
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
    if (Object.prototype.hasOwnProperty.call(stubs, id)) {
      return stubs[id];
    }
    if (id === 'path' || id === 'fs') {
      return require(id);
    }
    throw new Error(file + ' requires "' + id + '", which this test does not stub');
  };
  mod._compile(outputText, file);
  return mod.exports;
}

const host = (id) => path.join('/host', id);

// --- fixture: a Steam library with Fallout 4 and Fallout 4 VR under Proton --------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-vortex-extrequire-'));
const steamApps = path.join(tmpDir, 'library', 'steamapps');
const prefixUser = (appId) =>
  path.join(steamApps, 'compatdata', appId, 'pfx', 'drive_c', 'users', 'steamuser');
const steamGame = (dir, appId) => {
  fs.mkdirSync(path.join(steamApps, 'common', dir), { recursive: true });
  fs.writeFileSync(path.join(steamApps, 'appmanifest_' + appId + '.acf'),
    '"AppState"\n{\n\t"appid"\t\t"' + appId + '"\n\t"installdir"\t\t"' + dir + '"\n}\n');
  fs.mkdirSync(prefixUser(appId), { recursive: true });
  return path.join(steamApps, 'common', dir);
};
const fallout4 = steamGame('Fallout 4', '377160');
const fallout4vr = steamGame('Fallout 4 VR', '611660');

const bundled = path.join(tmpDir, 'bundledPlugins');
const extension = (name) => ({ name, namespace: name, path: path.join(bundled, name) });
// game-fallout4 is listed first: with a plain prefix test it claims game-fallout4vr's files.
const EXTENSIONS = [extension('game-fallout4'), extension('game-fallout4vr'),
  extension('gamebryo-shared')];

const state = {
  settings: {
    profiles: { activeProfileId: 'p-fallout4', nextProfileId: 'p-fallout4' },
    gameMode: { discovered: { fallout4: { path: fallout4 }, fallout4vr: { path: fallout4vr } } },
  },
  persistent: {
    profiles: { 'p-fallout4': { gameId: 'fallout4' }, 'p-fallout4vr': { gameId: 'fallout4vr' } },
  },
  session: {
    gameMode: {
      known: [
        { id: 'fallout4', extensionPath: path.join(bundled, 'game-fallout4') },
        { id: 'fallout4vr', extensionPath: path.join(bundled, 'game-fallout4vr') },
      ],
    },
  },
};

// --- load the patched hook with the rest of Vortex stubbed ------------------------------
const logs = [];
const gamePaths = load(GAME_PATHS, {
  '../getVortexPath': { __esModule: true, default: host },
  '../log': { __esModule: true, log: () => undefined },
});

function installHook(getState) {
  const fakeModule = {
    prototype: {
      require(id) {
        return { original: id };
      },
    },
  };
  const api = {
    __esModule: true,
    log: (level, message) => logs.push(message),
    util: { getVortexPath: host, getSafe: () => 'safe' },
    types: { marker: 'types' },
  };
  const reduxAct = {
    __esModule: true,
    createAction: (description, payloadReducer, metaReducer) => ({ description, metaReducer }),
  };
  const extensionRequire = load(EXT_REQUIRE, {
    module: fakeModule,
    'redux-act': reduxAct,
    '../api': api,
    '../controls/ReactSelectWrap': { __esModule: true },
    '../ExtensionManager': {
      __esModule: true,
      default: { getExtensionPaths: () => [{ path: bundled, bundled: true }] },
    },
    './webpack-hacks': { __esModule: true, webpackRequireHack: () => undefined },
    './linux/gamePaths': gamePaths,
  });
  if (getState === undefined) {
    extensionRequire.default(() => EXTENSIONS);
  } else {
    extensionRequire.default(() => EXTENSIONS, getState);
  }
  const hook = fakeModule.prototype.require;
  // require(id) as the extension file at <extension>/<file> would call it
  const requireFrom = (ext, id, file = 'index.cjs') =>
    hook.call({ filename: path.join(bundled, ext, file) }, id);
  return { api, requireFrom, hook };
}

// --- tests -----------------------------------------------------------------------------
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("an extension's vortex-api resolves Documents in its own game's prefix", () => {
  const { requireFrom } = installHook(() => state);
  assert.strictEqual(requireFrom('game-fallout4', 'vortex-api').util.getVortexPath('documents'),
    path.join(prefixUser('377160'), 'Documents'));
  assert.strictEqual(
    requireFrom('game-fallout4vr', '@nexusmods/vortex-api').util.getVortexPath('appData'),
    path.join(prefixUser('611660'), 'AppData', 'Roaming'));
});

test("game-fallout4vr's files belong to game-fallout4vr, not game-fallout4", () => {
  const { requireFrom } = installHook(() => state);
  logs.length = 0;
  requireFrom('game-fallout4vr', 'vortex-api').log('info', 'hello');
  assert.deepStrictEqual(logs, ['[game-fallout4vr] hello']);
  const action = requireFrom('game-fallout4vr', 'redux-act').createAction('SOME_ACTION');
  assert.deepStrictEqual(action.metaReducer(), { extension: 'game-fallout4vr' });
});

test('files in an extension subfolder belong to that extension', () => {
  const { requireFrom } = installHook(() => state);
  const api = requireFrom('game-fallout4vr', 'vortex-api', path.join('lib', 'util.js'));
  assert.strictEqual(api.util.getVortexPath('documents'),
    path.join(prefixUser('611660'), 'Documents'));
});

test('a shared extension resolves the managed game', () => {
  const { requireFrom } = installHook(() => state);
  const util = requireFrom('gamebryo-shared', 'vortex-api').util;
  assert.strictEqual(util.getVortexPath('localAppData'),
    path.join(prefixUser('377160'), 'AppData', 'Local'));
  assert.strictEqual(util.getVortexPath('appData'), host('appData'));
});

test('the rest of the api and util pass through, and util is one object', () => {
  const { api, requireFrom } = installHook(() => state);
  const extApi = requireFrom('game-fallout4', 'vortex-api');
  assert.strictEqual(extApi.types, api.types);
  assert.strictEqual(extApi.util.getSafe(), 'safe');
  assert.strictEqual(extApi.util.getVortexPath('temp'), host('temp'));
  assert.strictEqual(extApi.util, extApi.util);
  assert.strictEqual(requireFrom('game-fallout4', 'vortex-api'), extApi);
});

test('a module outside every extension gets the plain api', () => {
  const { api, hook } = installHook(() => state);
  const result = hook.call({ filename: path.join(tmpDir, 'harmony', 'index.js') }, 'vortex-api');
  assert.strictEqual(result, api);
});

test('without a state getter (upstream call signature) paths resolve as before', () => {
  const { requireFrom } = installHook(undefined);
  assert.strictEqual(requireFrom('game-fallout4', 'vortex-api').util.getVortexPath('documents'),
    host('documents'));
});

test('other modules still go through the original require', () => {
  const { requireFrom } = installHook(() => state);
  assert.deepStrictEqual(requireFrom('game-fallout4', 'lodash'), { original: 'lodash' });
});

(async () => {
  console.log('patched extensionRequire under test: ' + EXT_REQUIRE);
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
  Object.defineProperty(process, 'platform', originalPlatform);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(failed === 0
    ? `\nEXTENSION REQUIRE OK (${tests.length}/${tests.length} passed)`
    : `\n!! ${failed}/${tests.length} extension require tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
