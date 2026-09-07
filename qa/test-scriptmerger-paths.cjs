#!/usr/bin/env node
/*
 * test-scriptmerger-paths.cjs — verify the built Witcher 3 extension configures W3 Script
 * Merger with Windows paths on Linux.
 *
 * Vortex writes the merger's WitcherScriptMerger.exe.config itself. The merger is a Windows
 * .NET tool running in the game's Proton prefix, and it does NOT reject a POSIX path - it
 * silently derives a garbage relative path and merges into a folder the game never reads
 * (build/patch-witcher3-scriptmerger-paths.cjs has the full mechanism). A grep for "Z:"
 * can't tell a correct conversion from a backwards one, so this runs the real function.
 *
 * setMergerConfig is a module-scoped function, so the bundler renames it; anchor on the
 * "GameDirectory" literal it writes and walk back to the enclosing declaration. Free
 * variables (the bundler's module namespaces) are resolved through a `with` scope onto one
 * permissive stub keyed by property name - property names survive minification even though
 * the namespace identifiers don't.
 *
 * Usage: node qa/test-scriptmerger-paths.cjs <game-witcher3/index.cjs>
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const nodePath = require('path');

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('usage: node qa/test-scriptmerger-paths.cjs <game-witcher3/index.cjs>');
  process.exit(2);
}
const src = fs.readFileSync(bundlePath, 'utf8');

const literal = /[`'"]GameDirectory[`'"]/.exec(src);
assert.notStrictEqual(literal, null, 'no GameDirectory literal in the bundle');
const start = src.lastIndexOf('async function', literal.index);
assert.notStrictEqual(start, -1, 'no enclosing async function for setMergerConfig');

// safe here because the function body contains no braces inside string literals
const bodyStart = src.indexOf('{', start);
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
const fnSource = src.slice(start, end + 1);

const PLACEHOLDER = '<unset>';
const makeConfig = () => ({
  configuration: {
    appSettings: [{
      add: [
        { $: { key: 'GameDirectory', value: PLACEHOLDER } },
        { $: { key: 'VanillaScriptsDirectory', value: PLACEHOLDER } },
        { $: { key: 'ModsDirectory', value: PLACEHOLDER } },
      ],
    }],
  },
});

// One stub standing in for every module namespace the bundle references. path.join has to
// tolerate the module-scoped constants we can't resolve (the config filename), which arrive
// as the stub itself rather than as strings.
const lenientJoin = (...parts) => {
  const strings = parts.filter((part) => typeof part === 'string');
  return strings.length > 0 ? nodePath.join(...strings) : '.';
};

const runSetMergerConfig = (gameRootPath, platform) => {
  const config = makeConfig();
  let built;
  class Builder {
    buildObject(value) {
      built = value;
      return '<xml/>';
    }
  }
  const stub = new Proxy({}, {
    get(_target, prop) {
      switch (prop) {
        case 'default': case 'fs': return stub;
        case 'join': return lenientJoin;
        case 'readFileAsync': return async () => '<xml/>';
        case 'writeFileAsync': return async () => undefined;
        case 'parseStringPromise': return async () => config;
        case 'Builder': return Builder;
        default: return () => undefined;
      }
    },
  });
  const scope = new Proxy({}, {
    has: () => true,
    get(_target, prop) {
      if (prop === Symbol.unscopables) {
        return undefined;
      }
      return prop === 'process' ? { platform } : stub;
    },
  });
  const fn = new Function('scope', 'with (scope) { return (' + fnSource + '); }')(scope);
  return Promise.resolve(fn(gameRootPath, '/opt/merger')).then(() => {
    assert.ok(built !== undefined, 'setMergerConfig never wrote the config back');
    const values = {};
    for (const entry of built.configuration.appSettings[0].add) {
      values[entry.$.key] = entry.$.value;
    }
    return values;
  });
};

const GAME = '/home/u/.local/share/Steam/steamapps/common/The Witcher 3';

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
  console.log('setMergerConfig lifted from: ' + bundlePath);

  await check('on Linux, writes a Z: drive path for the game directory', async () => {
    const values = await runSetMergerConfig(GAME, 'linux');
    assert.strictEqual(
      values.GameDirectory,
      'Z:\\home\\u\\.local\\share\\Steam\\steamapps\\common\\The Witcher 3',
    );
  });

  await check('on Linux, no POSIX separator survives in any path', async () => {
    const values = await runSetMergerConfig(GAME, 'linux');
    for (const [key, value] of Object.entries(values)) {
      assert.strictEqual(value.includes('/'), false, key + ' still POSIX: ' + value);
      assert.strictEqual(value.startsWith('Z:\\'), true, key + ' is not on Z: ' + value);
    }
  });

  await check('on Linux, the mods directory keeps the real "Mods" casing', async () => {
    const values = await runSetMergerConfig(GAME, 'linux');
    assert.strictEqual(values.ModsDirectory.endsWith('\\Mods'), true, values.ModsDirectory);
  });

  await check('on Linux, the vanilla scripts path is content\\content0\\scripts', async () => {
    const values = await runSetMergerConfig(GAME, 'linux');
    assert.strictEqual(
      values.VanillaScriptsDirectory.endsWith('\\content\\content0\\scripts'),
      true,
      values.VanillaScriptsDirectory,
    );
  });

  await check('on Windows, paths are left exactly as upstream builds them', async () => {
    const values = await runSetMergerConfig('C:\\Games\\The Witcher 3', 'win32');
    assert.strictEqual(values.GameDirectory, 'C:\\Games\\The Witcher 3');
    assert.strictEqual(values.ModsDirectory.startsWith('Z:'), false, values.ModsDirectory);
  });

  console.log(failed === 0
    ? '\nSCRIPT MERGER PATHS OK (5/5 passed)'
    : `\n!! ${failed}/5 script merger path tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
