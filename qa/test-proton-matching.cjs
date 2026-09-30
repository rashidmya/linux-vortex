#!/usr/bin/env node
/*
 * test-proton-matching.cjs — verify the built Proton routing picks the right Steam game.
 *
 * Windows tools are run through the Proton prefix of the Steam game they belong to. Two
 * places decide which game that is, and both are checked here:
 *   - findProtonGameFor (ExtensionManager, added by build/patch-linux-proton-tools.cjs) for
 *     tools extensions start with api.runExecutable;
 *   - shouldRunWithProton (upstream's StarterInfo, fixed by the same patch) for games and
 *     tools started from Vortex's dashboard.
 * A game matches when EITHER the executable path OR the working directory is inside its
 * folder - inside as in the folder itself or below it, not a folder whose name merely
 * starts the same way ("Fallout 4 VR" is not inside "Fallout 4").
 *
 * Rather than re-implement that logic here, this lifts the real functions out of the
 * packaged renderer bundle and runs them against stub Steam entries.
 *
 * Usage: node qa/test-proton-matching.cjs <renderer.js extracted from app.asar>
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rendererPath = process.argv[2];
if (!rendererPath) {
  console.error('usage: node qa/test-proton-matching.cjs <renderer.js>');
  process.exit(2);
}
const src = fs.readFileSync(rendererPath, 'utf8');

// Source of the function starting at `from`, up to the brace closing its body; safe here
// because neither function has braces inside string literals.
function functionSource(from, bodySearchFrom) {
  const bodyStart = src.indexOf('{', bodySearchFrom);
  let depth = 0;
  for (let end = bodyStart; end < src.length; ++end) {
    if (src[end] === '{') {
      depth++;
    } else if (src[end] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(from, end + 1);
      }
    }
  }
  throw new Error('unbalanced braces after ' + from);
}

// The bodies reach other modules through bundler variables such as logging_1 or
// GameStoreHelper_1, whose numeric suffixes shift between builds, so discover them and
// hand each one a stub (or a replacement from `known`, matched by name before the suffix).
// "path" is the node module, passed through as is.
const stub = new Proxy({}, { get: () => () => undefined });
function compile(fnSource, known = {}) {
  const externals = [...new Set(
    [...fnSource.matchAll(/\b([A-Za-z_$][\w$]*_\d+)\./g)].map((match) => match[1]),
  )];
  const values = externals.map((name) => known[name.replace(/_\d+$/, '')] ?? stub);
  return new Function(...externals, 'path', `return function () { return (${fnSource}); };`)(
    ...values, path,
  );
}

// The bundle is minified but keeps identifier names, so the class property is still
// "findProtonGameFor=async ...". A single parameter loses its parentheses
// ("async exePath=>"), two keep them ("async(exePath,workingDirectory)=>"), so anchor on
// the arrow rather than on the parameter list.
const FIND_MARKER = 'findProtonGameFor=async';
const findStart = src.indexOf(FIND_MARKER);
assert.notStrictEqual(findStart, -1, 'findProtonGameFor not found in the bundle');
const findSource = functionSource(findStart + 'findProtonGameFor='.length,
  src.indexOf('=>', findStart));

// Upstream's shouldRunWithProton is used once, so the minifier inlines it as a named
// function expression at its call site - the name survives.
const SHOULD_MARKER = 'async function shouldRunWithProton(';
const shouldStart = src.indexOf(SHOULD_MARKER);
assert.notStrictEqual(shouldStart, -1, 'shouldRunWithProton not found in the bundle');
const shouldSource = functionSource(shouldStart, src.indexOf(')', shouldStart));

const common = '/steam/steamapps/common/';
const WITCHER = { name: 'The Witcher 3', gamePath: common + 'The Witcher 3', usesProton: true };
const NO_PREFIX = { name: 'Team Fortress 2', gamePath: common + 'Team Fortress 2', usesProton: false };
// Listed first: a plain prefix test claims everything in "Fallout 4 VR" for it.
const FALLOUT4 = { name: 'Fallout 4', gamePath: common + 'Fallout 4', usesProton: true };
const FALLOUT4VR = { name: 'Fallout 4 VR', gamePath: common + 'Fallout 4 VR', usesProton: true };
const steamStore = { allGames: async () => [NO_PREFIX, FALLOUT4, FALLOUT4VR, WITCHER] };

// findProtonGameFor is an arrow function, so it takes `this` from where it is defined and
// ignores .call(). Wrap it in a plain function and invoke that with our stub as `this`, or
// every lookup throws into the catch and the whole suite passes vacuously.
const findProtonGameFor = compile(findSource).call({ getSteamStore: () => steamStore });
const find = (exePath, workingDirectory) => findProtonGameFor(exePath, workingDirectory);

const shouldRunWithProton = compile(shouldSource, {
  proton: { isWindowsExecutable: (file) => /\.(exe|bat|cmd)$/i.test(file) },
  GameStoreHelper: { default: { getGameStore: () => steamStore } },
})();
const should = (exePath, workingDirectory, store = 'steam') =>
  shouldRunWithProton({ exePath, workingDirectory, store }, undefined);

let failed = 0;
let total = 0;
const check = async (name, run) => {
  total++;
  try {
    await run();
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + String(err.message || err).split('\n')[0]);
  }
};

(async () => {
  console.log('findProtonGameFor and shouldRunWithProton lifted from: ' + rendererPath);

  // --- findProtonGameFor (api.runExecutable) ---
  await check('matches an executable inside the game folder', async () => {
    const hit = await find(WITCHER.gamePath + '/WitcherScriptMerger/WitcherScriptMerger.exe');
    assert.strictEqual(hit?.name, WITCHER.name);
  });

  await check('matches when only the working directory is inside the game folder', async () => {
    const hit = await find('/home/user/tools/merger.exe', WITCHER.gamePath + '/Mods');
    assert.strictEqual(hit?.name, WITCHER.name, 'working directory was ignored');
  });

  await check('matches a working directory that is the game folder itself', async () => {
    const hit = await find('/home/user/tools/merger.exe', WITCHER.gamePath);
    assert.strictEqual(hit?.name, WITCHER.name);
  });

  await check('a tool in "Fallout 4 VR" runs in its prefix, not "Fallout 4"\'s', async () => {
    const hit = await find(FALLOUT4VR.gamePath + '/f4sevr_loader.exe');
    assert.strictEqual(hit?.name, FALLOUT4VR.name);
  });

  await check('a working directory in "Fallout 4 VR" is not in "Fallout 4"', async () => {
    const hit = await find('/home/user/tools/tool.exe', FALLOUT4VR.gamePath + '/Data');
    assert.strictEqual(hit?.name, FALLOUT4VR.name);
  });

  await check('ignores a Steam game with no Proton prefix', async () => {
    const hit = await find(NO_PREFIX.gamePath + '/tool.exe');
    assert.strictEqual(hit, undefined);
  });

  await check('ignores an executable unrelated to any Steam game', async () => {
    const hit = await find('/opt/other/tool.exe', '/opt/other');
    assert.strictEqual(hit, undefined);
  });

  // --- shouldRunWithProton (dashboard launches) ---
  await check('dashboard: a tool in "Fallout 4 VR" runs in its prefix, not "Fallout 4"\'s',
    async () => {
      const hit = await should(FALLOUT4VR.gamePath + '/f4sevr_loader.exe');
      assert.strictEqual(hit?.name, FALLOUT4VR.name);
    });

  await check('dashboard: a working directory in "Fallout 4 VR" is not in "Fallout 4"',
    async () => {
      const hit = await should('/home/user/tools/tool.exe', FALLOUT4VR.gamePath + '/Data');
      assert.strictEqual(hit?.name, FALLOUT4VR.name);
    });

  await check('dashboard: matches an executable inside the game folder', async () => {
    const hit = await should(FALLOUT4.gamePath + '/f4se_loader.exe', FALLOUT4.gamePath);
    assert.strictEqual(hit?.name, FALLOUT4.name);
  });

  await check('dashboard: leaves non-Steam launches alone', async () => {
    const hit = await should(FALLOUT4.gamePath + '/f4se_loader.exe', undefined, 'gog');
    assert.strictEqual(hit, undefined);
  });

  await check('dashboard: leaves native executables alone', async () => {
    const hit = await should(FALLOUT4.gamePath + '/run.sh');
    assert.strictEqual(hit, undefined);
  });

  console.log(failed === 0
    ? `\nPROTON MATCHING OK (${total}/${total} passed)`
    : `\n!! ${failed}/${total} proton matching tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
