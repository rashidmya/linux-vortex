/**
 * [linux-vortex] proton game paths
 *
 * A game running under Steam Proton reads its per-user Windows folders ("Documents",
 * "%LOCALAPPDATA%", "%APPDATA%") from inside its compatibility prefix:
 *   <library>/steamapps/compatdata/<appid>/pfx/drive_c/users/steamuser/...
 * getVortexPath("documents") reports the host's XDG documents directory, and
 * getVortexPath("localAppData") / ("appData") host locations the game never sees, so anything
 * Vortex writes there for the game (load order files, ini tweaks, mods deployed into
 * Documents) lands where the game never looks.
 *
 * These helpers resolve the prefix from the game's discovered path. The app id is read from
 * the library's appmanifest_*.acf files, so no per-game knowledge is needed. Everything falls
 * back to getVortexPath() when the game isn't a Steam install, has no prefix (native Linux
 * build, never launched), or we're not on Linux - Windows behaviour is unchanged.
 *
 * getVortexPathForExtension() applies this to every extension without touching its code:
 * util/extensionRequire.ts gives each extension its own getVortexPath, which answers those
 * three folders for the game the extension is working for. That is what makes game support
 * work under Proton whether it ships with Vortex or is downloaded from Nexus Mods.
 *
 * All of this is synchronous on purpose: getVortexPath and every other caller (load order
 * file paths, plugins.txt, "My Games" lookups) are synchronous.
 *
 * Vortex's Steam store (util/Steam.ts, allGames()) already parses these manifests and knows
 * each game's compatdata path, but only asynchronously; these helpers re-derive the little
 * they need so the synchronous callers can use them.
 */
import * as fs from "fs";
import * as path from "path";

import type { IState } from "../../types/IState";
import getVortexPath from "../getVortexPath";
import type { AppPath } from "../getVortexPath";
import { log } from "../log";

// Proton always creates the prefix user as "steamuser".
const PREFIX_USER = "steamuser";

// Extensions ask for these folders often (every mod path lookup can), and answering means
// reading the library's manifests, so the answer is kept per game folder. A found prefix is
// re-checked with one stat, since Steam can delete it. A miss is kept for this long, so a
// game run through Proton for the first time while Vortex is open is picked up shortly after.
const NO_PREFIX_RETRY_MS = 10000;

interface IPrefixLookup {
  userDir?: string;
  // when userDir is unset: don't scan the library again before this time
  retryAt?: number;
}

const prefixLookups = new Map<string, IPrefixLookup>();

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

function findProtonUserDir(install: ISteamInstall, gamePath: string): string | undefined {
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
  const key = path.resolve(gamePath);
  const known = prefixLookups.get(key);
  if (known?.userDir !== undefined && isDirectory(known.userDir)) {
    return known.userDir;
  }
  if (known?.retryAt !== undefined && Date.now() < known.retryAt) {
    return undefined;
  }
  const userDir = findProtonUserDir(install, gamePath);
  prefixLookups.set(
    key,
    userDir !== undefined ? { userDir } : { retryAt: Date.now() + NO_PREFIX_RETRY_MS },
  );
  return userDir;
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

// Where each per-user Windows folder lives in the prefix user directory. "home" is left out
// on purpose: extensions use it for native Linux locations (e.g. ~/.factorio).
function prefixFolder(id: AppPath): string[] | undefined {
  switch (id) {
    case "documents":
      return ["Documents"];
    case "localAppData":
      return ["AppData", "Local"];
    case "appData":
      return ["AppData", "Roaming"];
    default:
      return undefined;
  }
}

function profileGameId(state: IState, profileId: string | undefined): string | undefined {
  return profileId !== undefined ? state.persistent?.profiles?.[profileId]?.gameId : undefined;
}

interface IExtensionGame {
  gameId?: string;
  // the extension registered no game of its own (gamebryo support, open-directory, ...)
  shared: boolean;
}

/**
 * The game an extension is working for.
 * - A game extension works for its own game, whether or not it's the one being managed (its
 *   setup runs before a switch to it is complete). If it registered several games, the one
 *   being managed wins, and if that's none of them there is no telling which it means.
 * - A shared extension works for the game being managed. During a game switch that is the
 *   game being switched to, which is only recorded as active once its setup has finished.
 */
function gameForExtension(state: IState, extensionPath: string): IExtensionGame | undefined {
  const known = state.session?.gameMode?.known;
  if (!Array.isArray(known) || known.length === 0) {
    // Games aren't in the store yet, so a game extension can't be told from a shared one.
    return undefined;
  }
  const profiles = state.settings?.profiles;
  const managed =
    profileGameId(state, profiles?.nextProfileId) ??
    profileGameId(state, profiles?.activeProfileId);
  const extensionDir = path.resolve(extensionPath);
  const own = known
    .filter(
      (game) =>
        typeof game.extensionPath === "string" &&
        path.resolve(game.extensionPath) === extensionDir,
    )
    .map((game) => game.id);
  if (own.length === 0) {
    return { gameId: managed, shared: true };
  }
  if (managed !== undefined && own.includes(managed)) {
    return { gameId: managed, shared: false };
  }
  return { gameId: own.length === 1 ? own[0] : undefined, shared: false };
}

/**
 * getVortexPath as one extension sees it; util/extensionRequire.ts installs it in the api
 * each extension gets.
 *
 * On Linux, when the game the extension is working for runs under Proton, "documents",
 * "localAppData" and "appData" resolve inside that game's prefix - the folders the game
 * itself reads. Every other path, and every case where there is no such game, resolves as
 * before. A shared extension keeps the host "appData": roaming AppData is where Vortex and
 * extensions keep their own data (%APPDATA%\Vortex), so a shared extension asking for it
 * may not mean the game's.
 *
 * Values an extension computes while it is being loaded resolve to host paths: at that
 * point no game is registered and there is no store to find one in.
 */
export function getVortexPathForExtension(
  id: AppPath,
  extensionPath: string,
  getState: () => IState | undefined,
): string {
  const folder = prefixFolder(id);
  if (process.platform === "linux" && folder !== undefined) {
    try {
      const state = getState();
      const target = state !== undefined ? gameForExtension(state, extensionPath) : undefined;
      if (target?.gameId !== undefined && !(target.shared && id === "appData")) {
        const userDir = getProtonUserDir(
          state.settings?.gameMode?.discovered?.[target.gameId]?.path,
        );
        if (userDir !== undefined) {
          return path.join(userDir, ...folder);
        }
      }
    } catch (err: any) {
      // Never let a lookup break the extension; the host path is what it got before.
      log("debug", "could not resolve game folder for extension, using host paths", {
        extensionPath,
        id,
        error: err?.message,
      });
    }
  }
  return getVortexPath(id);
}

/**
 * The util namespace one extension gets: upstream's, with getVortexPath answered by
 * getVortexPathForExtension. A Proxy rather than a copy, so every other member stays live.
 */
export function utilForExtension<T extends object>(
  util: T,
  extensionPath: string,
  getState: () => IState | undefined,
): T {
  const getVortexPathForThis = (id: AppPath) =>
    getVortexPathForExtension(id, extensionPath, getState);
  return new Proxy(util, {
    get: (target, key) =>
      key === "getVortexPath" ? getVortexPathForThis : Reflect.get(target, key),
  });
}
