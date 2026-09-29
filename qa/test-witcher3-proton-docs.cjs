#!/usr/bin/env node
/*
 * Exercise the documents patch on disposable copies of the actual upstream sources.
 * Import cleanup must be harmless; missing/ambiguous imports and code drift must fail
 * before writing. Runs before the real patch in build-upstream.sh (no dependencies).
 * Usage: node qa/test-witcher3-proton-docs.cjs <unpatched upstream Vortex source root>
 */
'use strict';
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const srcRoot = process.argv[2];
if (!srcRoot) {
  console.error('usage: node qa/test-witcher3-proton-docs.cjs <unpatched upstream source root>');
  process.exit(2);
}
const extRel = path.join('extensions', 'games', 'game-witcher3', 'src');
const patch = path.resolve(__dirname, '../build/patch-witcher3-proton-docs.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-vortex-witcher3-docs-'));
const importFiles = ['util.ts', 'iconbarActions.ts', 'mergers.ts'];
const commonImport = /^import\s*\{[^{}]*\}\s*from\s*["']\.\/common["'];/m;
const bindings = (text) => text.match(commonImport)[0].split('{')[1].split('}')[0]
  .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  .split(',').map((name) => name.trim()).filter(Boolean).sort();

const cases = [
  { name: 'actual upstream sources' },
  {
    name: 'imports before upstream cleanup',
    imports: {
      'iconbarActions.ts': 'import { GAME_ID, I18N_NAMESPACE, LOCKED_PREFIX } from "./common";',
      'mergers.ts': 'import { GAME_ID, CONFIG_MATRIX_REL_PATH, CONFIG_MATRIX_FILES, VORTEX_BACKUP_TAG } from "./common";',
    },
  },
  {
    name: 'imports after upstream cleanup (41be6d455656)',
    imports: {
      'iconbarActions.ts': 'import { GAME_ID, I18N_NAMESPACE } from "./common";',
      'mergers.ts': 'import { GAME_ID, CONFIG_MATRIX_REL_PATH, VORTEX_BACKUP_TAG } from "./common";',
    },
  },
  {
    name: 'reordered multiline imports with comments, aliases and single quotes',
    imports: {
      'iconbarActions.ts': "import {\n  // Keep this binding.\n  I18N_NAMESPACE,\n  GAME_ID,\n  LOCKED_PREFIX as lockedPrefix,\n} from './common';",
      'mergers.ts': "import {\n  VORTEX_BACKUP_TAG,\n  /* Used below. */ CONFIG_MATRIX_REL_PATH,\n  GAME_ID,\n} from './common';",
    },
  },
  {
    name: 'missing common import',
    imports: { 'iconbarActions.ts': '' },
    error: /iconbarActions\.ts: expected 1 occurrence\(s\) of the anchor, found 0/,
  },
  {
    name: 'ambiguous common imports',
    imports: {
      'mergers.ts': 'import { GAME_ID } from "./common";\nimport { VORTEX_BACKUP_TAG, CONFIG_MATRIX_REL_PATH } from "./common";',
    },
    error: /mergers\.ts: expected 1 occurrence\(s\) of the anchor, found 2/,
  },
  {
    name: 'changed documents path logic',
    change: ['common.ts', (text) => text.replace(
      'path.join(util.getVortexPath("documents"), "The Witcher 3", LOAD_ORDER_FILENAME)',
      'path.resolve(util.getVortexPath("documents"), "The Witcher 3", LOAD_ORDER_FILENAME)',
    )],
    error: /common\.ts: expected 1 occurrence\(s\) of the anchor, found 0/,
  },
  {
    name: 'additional load order call needs review',
    change: ['iniParser.ts', (text) => text + '\ngetLoadOrderFilePath();\n'],
    error: /iniParser\.ts: expected 5 occurrence\(s\) of the anchor, found 6/,
  },
  {
    name: 'new documents path user needs review before any writes',
    extraFile: ['newDocumentsUser.ts', 'getLoadOrderFilePath();\n'],
    error: /documents-path helper called without a game path in: newDocumentsUser\.ts/,
  },
  {
    name: 'new DX12 settings user needs review before any writes',
    extraFile: ['newSettingsUser.ts', 'getDx12UserSettingsPath();\n'],
    error: /documents-path helper called without a game path in: newSettingsUser\.ts/,
  },
];

try {
  for (const [index, test] of cases.entries()) {
    const root = path.join(tmp, String(index));
    const ext = path.join(root, extRel);
    fs.cpSync(path.join(srcRoot, extRel), ext, { recursive: true });
    const read = (name) => fs.readFileSync(path.join(ext, name), 'utf8');
    const write = (name, text) => fs.writeFileSync(path.join(ext, name), text);
    assert(!read('common.ts').includes('[linux-vortex] proton documents'),
      'tests require unpatched upstream sources');
    for (const [file, statement] of Object.entries(test.imports || {})) {
      const source = read(file);
      assert.match(source, commonImport, file + ' must have a common import to vary');
      write(file, source.replace(commonImport, () => statement));
    }
    if (test.change) {
      const [file, change] = test.change;
      const source = read(file);
      const changed = change(source);
      assert.notEqual(changed, source, test.name + ' must alter the fixture');
      write(file, changed);
    }
    if (test.extraFile) {
      write(...test.extraFile);
    }
    const snapshot = () => Object.fromEntries(fs.readdirSync(ext, { recursive: true })
      .filter((name) => fs.statSync(path.join(ext, name)).isFile())
      .map((name) => [name, read(name)]));
    const before = snapshot();
    const run = () => spawnSync(process.execPath, [patch, root], { encoding: 'utf8' });
    const result = run();
    assert.ifError(result.error);
    if (test.error) {
      assert.equal(result.status, 1, test.name + ': ' + result.stdout + result.stderr);
      assert.match(result.stderr, test.error);
      assert.match(result.stderr, /Nothing was written/);
      assert.deepEqual(snapshot(), before, test.name + ' must leave all files untouched');
    } else {
      assert.equal(result.status, 0, test.name + ': ' + result.stdout + result.stderr);
      for (const file of importFiles) {
        assert.deepEqual(bindings(read(file)),
          [...bindings(before[file]), 'getWitcher3DocumentsPath'].sort(),
          file + ' must keep upstream bindings and add the helper exactly once');
      }
      assert.match(read('common.ts'), /util\.getGameDocumentsPath\(gamePath\)/);
      assert.match(read('iconbarActions.ts'), /getWitcher3DocumentsPath\(discovery\?\.path\)/);
      if (before['loadOrder.tsx'].includes('getLoadOrderFilePath')) {
        assert.match(read('loadOrder.tsx'), /getLoadOrderFilePath\(discovery\?\.path\)/);
      }
      if (before['common.ts'].includes('getDx12UserSettingsPath')) {
        assert.match(read('common.ts'),
          /getWitcher3DocumentsPath\(gamePath\), DX12_USER_SETTINGS_FILENAME/);
        assert.match(read('healthChecks.ts'), /enableLocalMods\(api: types\.IExtensionApi\)/);
        assert.match(read('healthChecks.ts'), /fix: \(api\) => enableLocalMods\(api\)/);
      }
      const after = snapshot();
      const rerun = run();
      assert.ifError(rerun.error);
      assert.equal(rerun.status, 0, rerun.stderr);
      assert.deepEqual(snapshot(), after, 'rerunning the patch must not change any files');
      write('newDocumentsUser.ts', 'getWitcher3DocumentsPath();\n');
      const withNewCall = snapshot();
      const invalidRerun = run();
      assert.ifError(invalidRerun.error);
      assert.equal(invalidRerun.status, 1, 'a marker must not bypass the documents call guard');
      assert.match(invalidRerun.stderr, /newDocumentsUser\.ts/);
      assert.deepEqual(snapshot(), withNewCall, 'a rejected repeat must not change files');
    }
    console.log('ok - ' + test.name);
  }
  console.log('>> witcher3 documents patch: ' + cases.length + ' checks passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
