#!/usr/bin/env node
/*
 * patch-linux-ini.cjs — give vortex-parse-ini an ini backend that works off Windows.
 *
 * winapi-bindings only implements the Win32 profile (.ini) functions on Windows; its
 * index.js exports an empty object everywhere else. vortex-parse-ini ships exactly one
 * backend (WinapiFormat), which calls those functions unconditionally, so on Linux every
 * ini read/write in Vortex throws
 *   TypeError: winapi.GetPrivateProfileSectionNames is not a function
 * That hits the Witcher 3 load order file (mods.settings is truncated and never rewritten
 * on every deploy, i.e. on every mod enable/disable), the gamebryo ini tweaks, morrowind,
 * bepinex, mo-import, sims4, msfs, vtmbloodlines and Vortex core's game settings.
 *
 * This installs build/patches/vortex-parse-ini/WinapiFormat.js, which keeps the native
 * path byte-for-byte for Windows and falls back to a pure-JS implementation when the
 * native functions are missing. Verified by qa/test-linux-ini.cjs.
 *
 * Usage: node build/patch-linux-ini.cjs <dir to scan for node_modules> [...]
 * Refuses to patch (and fails the build) if upstream's backend is no longer the file we
 * reviewed, so a dependency bump can't silently drop the fix.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PATCH_SRC = path.join(__dirname, 'patches', 'vortex-parse-ini', 'WinapiFormat.js');
// vortex-parse-ini 0.4.0 (Nexus-Mods/vortex-parse-ini @ 2425af9), lib/WinapiFormat.js
const UPSTREAM_SHA256 = 'c6d4864d76aca93a9c5463a963a7b6fff61defdd3329ad95961727b84a71e129';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function findPackageDirs(root) {
  const found = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (err) {
      continue;
    }
    if (seen.has(real)) {
      continue;
    }
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (entry.name === 'vortex-parse-ini') {
        found.push(child);
      } else if (!['.git', '.bin', '.cache'].includes(entry.name)) {
        stack.push(child);
      }
    }
  }
  return found;
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node build/patch-linux-ini.cjs <dir> [...]');
  process.exit(2);
}
const patchContent = fs.readFileSync(PATCH_SRC);
const patchSha = crypto.createHash('sha256').update(patchContent).digest('hex');

let patched = 0;
let already = 0;
let mismatched = 0;
for (const root of roots) {
  if (!fs.existsSync(root)) {
    console.log('   skip (no such dir): ' + root);
    continue;
  }
  for (const pkgDir of findPackageDirs(root)) {
    const target = path.join(pkgDir, 'lib', 'WinapiFormat.js');
    if (!fs.existsSync(target)) {
      continue;
    }
    const current = sha256(target);
    if (current === patchSha) {
      already++;
      continue;
    }
    if (current !== UPSTREAM_SHA256) {
      console.error('!! vortex-parse-ini/lib/WinapiFormat.js is not the reviewed upstream file:');
      console.error('   ' + target);
      console.error('   expected sha256 ' + UPSTREAM_SHA256 + ', found ' + current);
      console.error('   Re-review the upstream backend and refresh build/patches/vortex-parse-ini/.');
      mismatched++;
      continue;
    }
    // unlink first: pnpm hardlinks package files into its content-addressable store,
    // so writing in place would rewrite the store copy too.
    fs.unlinkSync(target);
    fs.writeFileSync(target, patchContent);
    console.log('   patched: ' + target);
    patched++;
  }
}

console.log('>> linux ini backend: patched=' + patched + ', already-patched=' + already +
  ', mismatched=' + mismatched);
if (mismatched > 0) {
  process.exit(1);
}
if (patched + already === 0) {
  console.error('!! vortex-parse-ini not found under: ' + roots.join(', '));
  console.error('   The dependency layout changed; the Linux ini fix would be missing.');
  process.exit(1);
}
