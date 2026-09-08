/**
 * [linux-vortex] proton game paths
 *
 * A game running under Steam Proton reads its per-user Windows folders ("Documents",
 * "%LOCALAPPDATA%") from inside its compatibility prefix:
 *   <library>/steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/...
 * getVortexPath("documents") reports the host's XDG documents directory and
 * getVortexPath("localAppData") a Windows-only location that doesn't exist on Linux, so
 * anything Vortex writes there for the game (load order files, ini tweaks, menu mods) lands
 * where the game never looks.
 *
 * These helpers resolve the prefix from the game's discovered path. The app id is read from
 * the library's appmanifest_*.acf files, so no per-game knowledge is needed. Everything falls
 * back to getVortexPath() when the game isn't a Steam install, has no prefix (native Linux
 * build, never launched), or we're not on Linux - Windows behaviour is unchanged.
 *
 * All of this is synchronous on purpose: every caller (load order file paths, plugins.txt,
 * "My Games" lookups) is synchronous.
 *
 * Vortex's Steam store (util/Steam.ts, allGames()) already parses these manifests and knows
 * each game's compatdata path, but only asynchronously; these helpers re-derive the little
 * they need so the synchronous callers can use them.
 */
import * as fs from "fs";
import * as path from "path";

import getVortexPath from "../getVortexPath";
import { log } from "../log";

// Proton always creates the prefix user as "steamuser".
const PREFIX_USER = "steamuser";

interface ISteamInstall {
  steamApps: string;
  installDir: string;
}

// <library>/steamapps/common/<installdir> -> { <library>/steamapps, <installdir> }
function steamInstallFor(gamePath: string): ISteamInstall | undefined {
  const resolved = path.resolve(gamePath);
  const common = path.dirname(resolved);
  const steamApps = path.dirname(common);
  if (
    path.basename(common).toLowerCase() !== "common" ||
    path.basename(steamApps).toLowerCase() !== "steamapps"
  ) {
    return undefined;
  }
  return { steamApps, installDir: path.basename(resolved) };
}

// A regex rather than simple-vdf (which upstream uses elsewhere): we only need one key, it
// can't throw on a malformed file, and it costs nothing. Real Steam manifests have exactly
// one installdir and never quote characters in it.
function manifestInstallDir(manifestPath: string): string | undefined {
  try {
    const match = /"installdir"\s+"([^"]*)"/i.exec(fs.readFileSync(manifestPath, "utf8"));
    return match?.[1];
  } catch {
    // unreadable or malformed manifest - not ours to fix, skip it
    return undefined;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The prefix user directory (…/pfx/drive_c/users/steamuser) for a Steam game that has a
 * Proton prefix, or undefined when there is none or this isn't Linux.
 */
export function getProtonUserDir(gamePath?: string): string | undefined {
  if (process.platform !== "linux" || typeof gamePath !== "string" || gamePath.length === 0) {
    return undefined;
  }
  const install = steamInstallFor(gamePath);
  if (install === undefined) {
    return undefined;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(install.steamApps);
  } catch (err: any) {
    log("debug", "could not list steamapps for Proton prefix lookup", {
      steamApps: install.steamApps,
      error: err?.message,
    });
    return undefined;
  }
  // readdir order is filesystem-dependent; sort so which manifest wins is predictable.
  entries.sort();
  const wanted = install.installDir.toLowerCase();
  for (const entry of entries) {
    const match = /^appmanifest_(\d+)\.acf$/i.exec(entry);
    if (match === null) {
      continue;
    }
    const installDir = manifestInstallDir(path.join(install.steamApps, entry));
    // Keep scanning past a matching manifest with no prefix: a game can have several app ids
    // (base game / GOTY edition) and only the installed one has compatdata. Sorted order means
    // the first manifest filename in sorted order wins if more than one has a prefix.
    if (installDir === undefined || installDir.toLowerCase() !== wanted) {
      continue;
    }
    const userDir = path.join(
      install.steamApps,
      "compatdata",
      match[1],
      "pfx",
      "drive_c",
      "users",
      PREFIX_USER,
    );
    if (isDirectory(userDir)) {
      return userDir;
    }
  }
  log("debug", "no Proton prefix found for game, using host paths", {
    gamePath,
    steamApps: install.steamApps,
  });
  return undefined;
}

/**
 * The "Documents" folder the game reads: inside its Proton prefix when it has one, otherwise
 * Vortex's documents path (the host's, which is also what Windows gets).
 */
export function getGameDocumentsPath(gamePath?: string): string {
  const userDir = getProtonUserDir(gamePath);
  return userDir !== undefined ? path.join(userDir, "Documents") : getVortexPath("documents");
}

/**
 * The "%LOCALAPPDATA%" folder the game reads, with the same fallback.
 */
export function getGameLocalAppDataPath(gamePath?: string): string {
  const userDir = getProtonUserDir(gamePath);
  return userDir !== undefined
    ? path.join(userDir, "AppData", "Local")
    : getVortexPath("localAppData");
}
