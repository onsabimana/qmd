/**
 * Path utility functions
 */

import { HOME } from "src/config";

/**
 * Get home directory
 */
export function homedir(): string {
  return HOME;
}

/**
 * Resolve and normalize paths
 */
export function resolve(...paths: string[]): string {
  let result = paths[0].startsWith("/") ? "" : Bun.env.PWD || process.cwd();
  for (const p of paths) {
    if (p.startsWith("/")) {
      result = p;
    } else {
      result = result + "/" + p;
    }
  }
  const parts = result.split("/").filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "..") normalized.pop();
    else if (part !== ".") normalized.push(part);
  }
  return "/" + normalized.join("/");
}

/**
 * Get current working directory
 */
export function getPwd(): string {
  return process.env.PWD || process.cwd();
}

/**
 * Get real path using realpath command
 */
export function getRealPath(path: string): string {
  try {
    const result = Bun.spawnSync(["realpath", path]);
    if (result.success) {
      return result.stdout.toString().trim();
    }
  } catch {}
  return resolve(path);
}

/**
 * Get default database path
 */
export function getDefaultDbPath(indexName: string = "index"): string {
  // Allow override via INDEX_PATH for testing
  if (Bun.env.INDEX_PATH) {
    return Bun.env.INDEX_PATH;
  }
  const cacheDir = Bun.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
  const qmdCacheDir = resolve(cacheDir, "qmd");
  try {
    Bun.spawnSync(["mkdir", "-p", qmdCacheDir]);
  } catch {}
  return resolve(qmdCacheDir, `${indexName}.sqlite`);
}
