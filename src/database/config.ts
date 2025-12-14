/**
 * Database Configuration
 *
 * Centralized database configuration and path resolution.
 */

export const HOME = Bun.env.HOME || "/";

/**
 * Get the default database path
 */
export function getDefaultDbPath(indexName: string = "index"): string {
  // Allow override via INDEX_PATH for testing
  if (Bun.env.INDEX_PATH) {
    return Bun.env.INDEX_PATH;
  }

  const cacheDir = Bun.env.XDG_CACHE_HOME || resolve(HOME, ".cache");
  const qmdCacheDir = resolve(cacheDir, "qmd");

  try {
    Bun.spawnSync(["mkdir", "-p", qmdCacheDir]);
  } catch {
    // Ignore errors
  }

  return resolve(qmdCacheDir, `${indexName}.sqlite`);
}

/**
 * Resolve path segments into an absolute path
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
 * Get home directory
 */
export function homedir(): string {
  return HOME;
}
