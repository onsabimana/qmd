/**
 * Database helper utilities
 */

import { Glob } from "bun";
import type { Database } from "bun:sqlite";
import { VectorService } from "src/core/vectors";
import { logger } from "./logger";
import { getRealPath } from "./path";

export interface IndexHealthInfo {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
}

/**
 * Get index health information
 */
export function getIndexHealth(db: Database): IndexHealthInfo {
  const vectorService = new VectorService(db);
  const needsEmbedding = vectorService.getHashesNeedingEmbedding("embeddinggemma"); // Default model

  const totalDocs = (db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number })
    .count;

  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as {
    latest: string | null;
  };

  let daysStale: number | null = null;
  if (mostRecent?.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    daysStale = Math.floor((Date.now() - lastUpdate.getTime()) / (24 * 60 * 60 * 1000));
  }

  return { needsEmbedding, totalDocs, daysStale };
}

/**
 * Get or create a collection in the database.
 * If a collection with the same pwd+glob already exists, returns its ID.
 * Otherwise, creates a new collection with the given or generated name.
 */
export function getOrCreateCollection(db: Database, pwd: string, globPattern: string, name?: string): number {
  const now = new Date().toISOString();

  // Generate collection name from pwd basename if not provided
  if (!name) {
    const parts = pwd.split("/").filter(Boolean);
    name = parts[parts.length - 1] || "root";
  }

  // Check if collection with this pwd+glob already exists
  const existing = db
    .prepare(`SELECT id FROM collections WHERE pwd = ? AND glob_pattern = ?`)
    .get(pwd, globPattern) as { id: number } | null;
  if (existing) return existing.id;

  // Try to insert with generated name
  try {
    const result = db
      .prepare(`INSERT INTO collections (name, pwd, glob_pattern, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(name, pwd, globPattern, now, now);
    return result.lastInsertRowid as number;
  } catch (e) {
    // Name collision - append a unique suffix
    const allCollections = db.prepare(`SELECT name FROM collections WHERE name LIKE ?`).all(`${name}%`) as {
      name: string;
    }[];
    let suffix = 2;
    let uniqueName = `${name}-${suffix}`;
    while (allCollections.some((c) => c.name === uniqueName)) {
      suffix++;
      uniqueName = `${name}-${suffix}`;
    }
    const result = db
      .prepare(`INSERT INTO collections (name, pwd, glob_pattern, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(uniqueName, pwd, globPattern, now, now);
    return result.lastInsertRowid as number;
  }
}

/**
 * Remove duplicate collections, keeping the oldest one
 * Also cleans up bogus "." glob patterns
 */
export function cleanupDuplicateCollections(db: Database): void {
  // Remove duplicate collections keeping the oldest one
  db.run(`
    DELETE FROM collections WHERE id NOT IN (
      SELECT MIN(id) FROM collections GROUP BY pwd, glob_pattern
    )
  `);
  // Remove bogus "." glob pattern entries (from earlier bug)
  db.run(`DELETE FROM collections WHERE glob_pattern = '.'`);
}

/**
 * Get collection ID by name
 * Searches both pwd and glob_pattern columns for the name
 */
export function getCollectionIdByName(db: Database, name: string): number | null {
  const result = db
    .prepare(`
    SELECT id FROM collections
    WHERE pwd LIKE ? OR glob_pattern LIKE ?
    ORDER BY LENGTH(pwd) DESC
  `)
    .get(`%${name}%`, `%${name}%`) as { id: number } | null;
  return result?.id || null;
}

/**
 * Check index health and print warnings/tips
 */
export function checkIndexHealth(db: Database): void {
  const { needsEmbedding, totalDocs, daysStale } = getIndexHealth(db);

  // Terminal colors
  const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
  const c = {
    reset: useColor ? "\x1b[0m" : "",
    dim: useColor ? "\x1b[2m" : "",
    yellow: useColor ? "\x1b[33m" : "",
  };

  // Warn if many docs need embedding
  if (needsEmbedding > 0) {
    const pct = Math.round((needsEmbedding / totalDocs) * 100);
    if (pct >= 10) {
      logger.warn(
        `${needsEmbedding} documents (${pct}%) need embeddings. Run 'qmd embed' for better results.`,
      );
    } else {
      logger.dim(`Tip: ${needsEmbedding} documents need embeddings. Run 'qmd embed' to index them.`);
    }
  }

  // Check if most recent document update is older than 2 weeks
  if (daysStale !== null && daysStale >= 14) {
    logger.dim(`Tip: Index last updated ${daysStale} days ago. Run 'qmd update' to refresh.`);
  }
}

/**
 * Compute unique display path for a document
 * Always include at least parent folder + filename, add more parent dirs until unique
 */
export function computeDisplayPath(filepath: string, collectionPath: string, existingPaths: Set<string>): string {
  // Get path relative to collection (include collection dir name)
  const collectionDir = collectionPath.replace(/\/$/, "");
  const collectionName = collectionDir.split("/").pop() || "";

  let relativePath: string;
  if (filepath.startsWith(collectionDir + "/")) {
    // filepath is under collection: use collection name + relative path
    relativePath = collectionName + filepath.slice(collectionDir.length);
  } else {
    // Fallback: just use the filepath
    relativePath = filepath;
  }

  const parts = relativePath.split("/").filter((p) => p.length > 0);

  // Always include at least parent folder + filename (minimum 2 parts if available)
  // Then add more parent dirs until unique
  const minParts = Math.min(2, parts.length);
  for (let i = parts.length - minParts; i >= 0; i--) {
    const candidate = parts.slice(i).join("/");
    if (!existingPaths.has(candidate)) {
      return candidate;
    }
  }

  // Absolute fallback: use full path (should be unique)
  return filepath;
}

/**
 * Update display_paths for all documents that have empty display_path
 */
export function updateDisplayPaths(db: Database): number {
  // Get all docs with empty display_path, grouped by collection
  const emptyDocs = db
    .prepare(`
    SELECT d.id, d.filepath, c.pwd
    FROM documents d
    JOIN collections c ON d.collection_id = c.id
    WHERE d.active = 1 AND (d.display_path IS NULL OR d.display_path = '')
  `)
    .all() as { id: number; filepath: string; pwd: string }[];

  if (emptyDocs.length === 0) return 0;

  // Collect existing display_paths
  const existingPaths = new Set<string>(
    (
      db.prepare(`SELECT display_path FROM documents WHERE active = 1 AND display_path != ''`).all() as {
        display_path: string;
      }[]
    ).map((r) => r.display_path),
  );

  const updateStmt = db.prepare(`UPDATE documents SET display_path = ? WHERE id = ?`);
  let updated = 0;

  for (const doc of emptyDocs) {
    const displayPath = computeDisplayPath(doc.filepath, doc.pwd, existingPaths);
    updateStmt.run(displayPath, doc.id);
    existingPaths.add(displayPath);
    updated++;
  }

  return updated;
}

/**
 * Detect which collection (if any) contains the given filesystem path.
 * Returns { collectionId, collectionName, relativePath } or null if not in any collection.
 */
export function detectCollectionFromPath(
  db: Database,
  fsPath: string,
): {
  collectionId: number;
  collectionName: string;
  relativePath: string;
} | null {
  const realPath = getRealPath(fsPath);

  // Find collections that this path is under
  const collections = db
    .prepare(`
    SELECT id, name, pwd
    FROM collections
    WHERE ? LIKE pwd || '/%' OR ? = pwd
    ORDER BY LENGTH(pwd) DESC
    LIMIT 1
  `)
    .get(realPath, realPath) as {
    id: number;
    name: string;
    pwd: string;
  } | null;

  if (!collections) return null;

  // Calculate relative path
  let relativePath = realPath;
  if (relativePath.startsWith(collections.pwd + "/")) {
    relativePath = relativePath.slice(collections.pwd.length + 1);
  } else if (relativePath === collections.pwd) {
    relativePath = "";
  }

  return {
    collectionId: collections.id,
    collectionName: collections.name,
    relativePath,
  };
}

/**
 * Match files by glob pattern across all collections
 */
export function matchFilesByGlob(
  db: Database,
  pattern: string,
): { filepath: string; displayPath: string; bodyLength: number }[] {
  const allFiles = db
    .prepare(`
    SELECT
      'qmd://' || c.name || '/' || d.path as virtual_path,
      LENGTH(content.doc) as body_length,
      d.collection_id,
      d.path
    FROM documents d
    JOIN collections c ON c.id = d.collection_id
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `)
    .all() as {
    virtual_path: string;
    body_length: number;
    collection_id: number;
    path: string;
  }[];

  const glob = new Glob(pattern);
  return allFiles
    .filter((f) => glob.match(f.virtual_path) || glob.match(f.path))
    .map((f) => ({
      filepath: f.virtual_path, // Use virtual path as filepath
      displayPath: f.virtual_path,
      bodyLength: f.body_length,
    }));
}
