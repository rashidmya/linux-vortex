#!/usr/bin/env node
/*
 * patch-witcher3-scriptmerger-paths.cjs — hand W3 Script Merger Windows paths on Linux.
 *
 * Vortex configures the merger for the user: setMergerConfig() rewrites GameDirectory,
 * VanillaScriptsDirectory and ModsDirectory inside WitcherScriptMerger.exe.config. It
 * builds those with node's path.join, so on Linux it writes POSIX paths
 * ("/home/u/.../The Witcher 3/mods"). But Script Merger is a Windows .NET tool that runs
 * in the game's Proton prefix, where the files it enumerates come back as
 * "Z:\home\u\...\The Witcher 3\Mods\...".
 *
 * That mismatch is not a graceful failure. The merger locates a file inside its mod with
 *
 *     Paths.GetRelativePath(fullPath, basePath):
 *       var startIndex = fullPath.IndexOfIgnoreCase(basePath) + basePath.Length + 1;
 *       return fullPath.Substring(startIndex);
 *
 * IndexOfIgnoreCase is separator- and drive-sensitive, so it returns -1 and the helper
 * silently strips basePath.Length characters instead of erroring. The garbage relative
 * path flows straight into
 *
 *     _outputPath = Path.Combine(ModsDirectory, mergedModName, relPath)   (FileMerger.cs)
 *
 * so a merge writes its output into a junk subfolder — observed on a real install as
 * Mods/mod0000_MergedFiles/ywhere/content/scripts/game/gui/menus/mapMenu.ws, where
 * "ywhere" is the tail of modFastTravelFromAnywhere. The game only reads
 * mod0000_MergedFiles/content/scripts/..., so the merge is invisible, the script conflict
 * it was meant to resolve persists, MergeInventory.xml is left empty (blank Merges panel)
 * and Vortex logs "[game-witcher] failed to retrieve merged mod names". Merging appears to
 * succeed and does nothing at all.
 *
 * Wine maps the Z: drive to /, so an absolute POSIX path becomes a valid Windows path by
 * prefixing "Z:" and flipping the separators. Naming the drive explicitly also keeps the
 * merger off any longer drive mapping Proton adds later (it maps the Steam library to S:,
 * and a bare "/home/..." resolves against the process's current drive, not necessarily Z:).
 *
 * Usage: node build/patch-witcher3-scriptmerger-paths.cjs <upstream Vortex source root>
 * Idempotent; fails the build if the anchor is missing, so an upstream change to
 * setMergerConfig can't silently drop the fix.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MARKER = '[linux-vortex] script merger paths';
const EXT_REL = path.join('extensions', 'games', 'game-witcher3', 'src');

const EDITS = [
  {
    file: 'scriptmerger.ts',
    find: `    replaceElement("GameDirectory", gameRootPath);
    replaceElement(
      "VanillaScriptsDirectory",
      path.join(gameRootPath, "content", "content0", "scripts"),
    );
    replaceElement("ModsDirectory", path.join(gameRootPath, "mods"));`,
    replace: `    // ${MARKER}: Script Merger is a Windows .NET tool running in the
    // game's Proton prefix, so it has to be given Windows paths. Handed a POSIX one it does
    // not fail cleanly - Paths.GetRelativePath finds its base path with IndexOfIgnoreCase
    // and, on the -1 miss, returns fullPath.Substring(basePath.Length) instead of erroring.
    // The truncated result becomes the merge's output path, so merged scripts are written
    // to a junk subfolder the game never reads and merging silently does nothing. Wine maps
    // the Z: drive to /, so name the drive explicitly and flip the separators.
    const toMergerPath = (dirPath: string) =>
      process.platform === "linux" ? "Z:" + dirPath.replace(/\\//g, "\\\\") : dirPath;

    replaceElement("GameDirectory", toMergerPath(gameRootPath));
    replaceElement(
      "VanillaScriptsDirectory",
      toMergerPath(path.join(gameRootPath, "content", "content0", "scripts")),
    );
    // "Mods" is the casing this extension creates and reads everywhere else; on a
    // case-sensitive filesystem "mods" is a directory that does not exist.
    replaceElement("ModsDirectory", toMergerPath(path.join(gameRootPath, "Mods")));`,
  },
];

const srcRoot = process.argv[2];
if (!srcRoot) {
  console.error('usage: node build/patch-witcher3-scriptmerger-paths.cjs <upstream source root>');
  process.exit(2);
}
const extDir = path.join(srcRoot, EXT_REL);
if (!fs.existsSync(extDir)) {
  console.error('!! Witcher 3 extension sources not found at ' + extDir);
  process.exit(1);
}

const contents = new Map();
const readFile = (name) => {
  if (!contents.has(name)) {
    contents.set(name, fs.readFileSync(path.join(extDir, name), 'utf8'));
  }
  return contents.get(name);
};

if (readFile('scriptmerger.ts').includes(MARKER)) {
  console.log('>> witcher3 script merger paths: already patched');
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
  console.error('!! Upstream changed setMergerConfig; re-review ' + EXT_REL +
    '/scriptmerger.ts and refresh build/patch-witcher3-scriptmerger-paths.cjs. ' +
    'Nothing was written.');
  process.exit(1);
}

for (const [name, text] of contents) {
  fs.writeFileSync(path.join(extDir, name), text);
  console.log('   patched: ' + path.join(EXT_REL, name));
}
console.log('>> witcher3 script merger paths: patched ' + contents.size + ' file(s)');
