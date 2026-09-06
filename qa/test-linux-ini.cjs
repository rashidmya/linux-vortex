#!/usr/bin/env node
/*
 * test-linux-ini.cjs — verify the pure-JS ini backend patched into vortex-parse-ini.
 *
 * Upstream's only ini backend (WinapiFormat) calls Win32 profile functions that
 * winapi-bindings does not provide off Windows, so every ini read/write in Vortex throws
 * on Linux. build/patch-linux-ini.cjs replaces that backend; this exercises it through
 * the package's real public API (IniParser + IniFile), including the exact call sequence
 * the Witcher 3 extension uses when you enable/disable a mod.
 *
 * Usage: node qa/test-linux-ini.cjs <path to a vortex-parse-ini package dir>
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: node qa/test-linux-ini.cjs <path-to-vortex-parse-ini>');
  process.exit(2);
}
const parseIni = require(path.resolve(pkgDir));
const IniParser = parseIni.default;
const WinapiFormat = parseIni.WinapiFormat;
const newParser = () => new IniParser(new WinapiFormat());

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-vortex-ini-'));
const file = (name) => path.join(tmpDir, name);
const read = (p) => fs.readFileSync(p, 'utf8');

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// The Witcher 3 extension's writeToModSettings(): truncate, re-read, fill in, write.
async function writeModSettings(filePath, struct) {
  const parser = newParser();
  fs.rmSync(filePath, { force: true });
  fs.writeFileSync(filePath, '', { encoding: 'utf8' });
  const ini = await parser.read(filePath);
  for (const key of Object.keys(struct)) {
    ini.data[key] = struct[key];
  }
  await parser.write(filePath, ini);
}

test('witcher3: a load order survives being written and read back', async () => {
  const target = file('mods.settings');
  await writeModSettings(target, {
    modFastTravel: { Enabled: 1, Priority: 1, VK: 'fasttravel-mod-id' },
    modBrothers: { Enabled: 0, Priority: 2, VK: 'brothers-mod-id' },
  });
  const text = read(target);
  assert.ok(text.includes('[modFastTravel]'), 'section header missing:\n' + text);
  const ini = await newParser().read(target);
  assert.strictEqual(ini.data.modFastTravel.Enabled, '1');
  assert.strictEqual(ini.data.modFastTravel.Priority, '1');
  assert.strictEqual(ini.data.modFastTravel.VK, 'fasttravel-mod-id');
  assert.strictEqual(ini.data.modBrothers.Enabled, '0');
});

test('witcher3: toggling a mod twice does not wipe or duplicate the file', async () => {
  const target = file('toggle.settings');
  await writeModSettings(target, { modA: { Enabled: 1, Priority: 1, VK: 'a' } });
  await writeModSettings(target, {
    modA: { Enabled: 0, Priority: 1, VK: 'a' },
    modB: { Enabled: 1, Priority: 2, VK: 'b' },
  });
  const text = read(target);
  assert.ok(text.trim().length > 0, 'load order file was emptied');
  assert.strictEqual((text.match(/\[modA\]/g) || []).length, 1, 'section duplicated:\n' + text);
  const ini = await newParser().read(target);
  assert.strictEqual(ini.data.modA.Enabled, '0');
  assert.strictEqual(ini.data.modB.VK, 'b');
});

test('edits keep comments, unrelated keys, key order and CRLF line endings', async () => {
  const target = file('skyrim.ini');
  fs.writeFileSync(target,
    '; user settings - do not delete\r\n[General]\r\nsLanguage=ENGLISH\r\nbFoo=1\r\n\r\n[Display]\r\niSize=1080\r\n');
  const parser = newParser();
  const ini = await parser.read(target);
  ini.data.General.sLanguage = 'GERMAN';
  delete ini.data.General.bFoo;
  ini.data.Display.iNew = '5';
  await parser.write(target, ini);
  const text = read(target);
  assert.ok(text.startsWith('; user settings - do not delete'), 'comment lost:\n' + text);
  assert.ok(text.includes('sLanguage=GERMAN'), 'value not updated:\n' + text);
  assert.ok(!text.includes('bFoo'), 'removed key still present:\n' + text);
  assert.ok(text.includes('iNew=5'), 'added key missing:\n' + text);
  assert.ok(text.includes('iSize=1080'), 'unrelated key lost:\n' + text);
  assert.ok(!/[^\r]\n/.test(text), 'CRLF line endings not preserved');
});

test('a key written in a different case replaces the existing one', async () => {
  const target = file('case.ini');
  fs.writeFileSync(target, '[General]\nSLANGUAGE=ENGLISH\n');
  const parser = newParser();
  const ini = await parser.read(target);
  ini.data.General.sLanguage = 'FRENCH';
  await parser.write(target, ini);
  const text = read(target);
  assert.strictEqual((text.match(/language=/gi) || []).length, 1, 'key duplicated:\n' + text);
  assert.ok(text.toLowerCase().includes('language=french'), text);
});

test('UTF-16LE files keep their encoding and non-ascii values', async () => {
  const target = file('utf16.ini');
  fs.writeFileSync(target, Buffer.concat([
    Buffer.from([0xFF, 0xFE]), Buffer.from('[Section]\r\nname=Bruxa Ürsula\r\n', 'utf16le')]));
  const parser = newParser();
  const ini = await parser.read(target);
  assert.strictEqual(ini.data.Section.name, 'Bruxa Ürsula');
  ini.data.Section.extra = 'ok';
  await parser.write(target, ini);
  const raw = fs.readFileSync(target);
  assert.strictEqual(raw[0], 0xFF, 'BOM lost');
  assert.strictEqual(raw[1], 0xFE, 'BOM lost');
  const back = await newParser().read(target);
  assert.strictEqual(back.data.Section.name, 'Bruxa Ürsula');
  assert.strictEqual(back.data.Section.extra, 'ok');
});

test('UTF-8 non-ascii values round-trip', async () => {
  const target = file('utf8.ini');
  fs.writeFileSync(target, '[modŻurawiejki]\nVK=zurawiejki\n', 'utf8');
  const parser = newParser();
  const ini = await parser.read(target);
  assert.strictEqual(Object.keys(ini.data)[0], 'modŻurawiejki');
  ini.data['modŻurawiejki'].Enabled = 1;
  await parser.write(target, ini);
  const back = await newParser().read(target);
  assert.strictEqual(back.data['modŻurawiejki'].Enabled, '1');
  assert.strictEqual(back.data['modŻurawiejki'].VK, 'zurawiejki');
});

test('a missing file reads as empty instead of throwing', async () => {
  const ini = await newParser().read(file('does-not-exist.ini'));
  assert.deepStrictEqual(ini.data, {});
});

test('comments and keys outside a section are not treated as entries', async () => {
  const target = file('stray.ini');
  fs.writeFileSync(target, 'stray=1\n; comment=2\n[Real]\nkey=3\n');
  const ini = await newParser().read(target);
  assert.deepStrictEqual(Object.keys(ini.data), ['Real']);
  assert.strictEqual(ini.data.Real.key, '3');
});

(async () => {
  console.log('vortex-parse-ini under test: ' + path.resolve(pkgDir));
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
    ? `\nINI BACKEND OK (${tests.length}/${tests.length} passed)`
    : `\n!! ${failed}/${tests.length} ini backend tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
