#!/usr/bin/env node
/*
 * test-proton-matching.cjs — verify the built Proton routing picks the right Steam game.
 *
 * Windows tools launched by extensions are routed through the game's Proton prefix
 * (build/patch-linux-proton-tools.cjs). The decision is made by findProtonGameFor, which
 * must match a game when EITHER the executable path OR the working directory sits inside
 * that game's folder - the same test upstream's shouldRunWithProton applies.
 *
 * Rather than re-implement that logic here, this lifts the real function out of the
 * packaged renderer bundle and runs it against stub Steam entries.
 *
 * Usage: node qa/test-proton-matching.cjs <renderer.js extracted from app.asar>
 */
'use strict';
const assert = require('assert');
const fs = require('fs');

const rendererPath = process.argv[2];
if (!rendererPath) {
  console.error('usage: node qa/test-proton-matching.cjs <renderer.js>');
  process.exit(2);
}
const src = fs.readFileSync(rendererPath, 'utf8');

// The bundle is minified but keeps identifier names, so the class property is still
// "findProtonGameFor=async ...". A single parameter loses its parentheses
// ("async exePath=>"), two keep them ("async(exePath,workingDirectory)=>"), so anchor on
// the arrow rather than on the parameter list.
const marker = 'findProtonGameFor=async';
const start = src.indexOf(marker);
assert.notStrictEqual(start, -1, 'findProtonGameFor not found in the bundle');
const bodyStart = src.indexOf('{', src.indexOf('=>', start));
let depth = 0;
let end = bodyStart;
for (; end < src.length; ++end) {
  if (src[end] === '{') {
    depth++;
  } else if (src[end] === '}') {
    depth--;
    if (depth === 0) {
      break;
    }
  }
}
// safe here because the function body contains no braces inside string literals
const fnSource = src.slice(start + 'findProtonGameFor='.length, end + 1);

// The body calls module-scoped helpers as (0, logging_1.log)(...). Their numeric suffixes
// are assigned by the bundler and shift between builds, so discover them and stub whatever
// it happens to reference.
const externals = [...new Set(
  [...fnSource.matchAll(/\(0,\s*([A-Za-z_$][\w$]*)\./g)].map((match) => match[1]),
)];
const stub = new Proxy({}, { get: () => () => undefined });
// findProtonGameFor is an arrow function, so it takes `this` from where it is defined and
// ignores .call(). Wrap it in a plain function and invoke that with our stub as `this`, or
// every lookup throws into the catch and the whole suite passes vacuously.
const makeFn = new Function(...externals, `return function () { return (${fnSource}); };`)(
  ...externals.map(() => stub),
);

const WITCHER = {
  name: 'The Witcher 3',
  gamePath: '/steam/steamapps/common/The Witcher 3',
  usesProton: true,
};
const NO_PREFIX = {
  name: 'Team Fortress 2',
  gamePath: '/steam/steamapps/common/Team Fortress 2',
  usesProton: false,
};
const self = { getSteamStore: () => ({ allGames: async () => [NO_PREFIX, WITCHER] }) };
const findProtonGameFor = makeFn.call(self);
const find = (exePath, workingDirectory) => findProtonGameFor(exePath, workingDirectory);

let failed = 0;
const check = async (name, run) => {
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
  console.log('findProtonGameFor lifted from: ' + rendererPath);

  await check('matches an executable inside the game folder', async () => {
    const hit = await find(WITCHER.gamePath + '/WitcherScriptMerger/WitcherScriptMerger.exe');
    assert.strictEqual(hit?.name, WITCHER.name);
  });

  await check('matches when only the working directory is inside the game folder', async () => {
    const hit = await find('/home/user/tools/merger.exe', WITCHER.gamePath + '/Mods');
    assert.strictEqual(hit?.name, WITCHER.name, 'working directory was ignored');
  });

  await check('ignores a Steam game with no Proton prefix', async () => {
    const hit = await find(NO_PREFIX.gamePath + '/tool.exe');
    assert.strictEqual(hit, undefined);
  });

  await check('ignores an executable unrelated to any Steam game', async () => {
    const hit = await find('/opt/other/tool.exe', '/opt/other');
    assert.strictEqual(hit, undefined);
  });

  console.log(failed === 0
    ? '\nPROTON MATCHING OK (4/4 passed)'
    : `\n!! ${failed}/4 proton matching tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
