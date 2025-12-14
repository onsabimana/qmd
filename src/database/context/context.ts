/**
 * Context Repository - Pure data access for path contexts
 *
 * Handles all SQL operations for path_contexts table.
 * No business logic - only context queries.
 */

import type { Database } from "bun:sqlite";

export interface PathContextRow {
  id: number;
  collection_id: number;
  path_prefix: string;
  context: string;
  created_at: string;
}

export interface CreatePathContextParams {
  collection_id: number;
  path_prefix: string;
  context: string;
}

export class ContextRepository {
  constructor(private db: Database) {}

  /**
   * Create a new path context
   */
  create(params: CreatePathContextParams): PathContextRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO path_contexts (collection_id, path_prefix, context, created_at)
         VALUES (?, ?, ?, ?)
         RETURNING *`,
      )
      .get(params.collection_id, params.path_prefix, params.context, now) as PathContextRow;
    return result;
  }

  /**
   * Get a path context by collection and path prefix
   */
  getByCollectionAndPrefix(collection_id: number, path_prefix: string): PathContextRow | null {
    return this.db
      .prepare(
        `SELECT * FROM path_contexts 
         WHERE collection_id = ? AND path_prefix = ?`,
      )
      .get(collection_id, path_prefix) as PathContextRow | null;
  }

  /**
   * Get all path contexts for a collection
   */
  listByCollection(collection_id: number): PathContextRow[] {
    return this.db
      .prepare(
        `SELECT * FROM path_contexts 
         WHERE collection_id = ? 
         ORDER BY path_prefix`,
      )
      .all(collection_id) as PathContextRow[];
  }

  /**
   * Get the most specific (longest) matching context for a path
   * Uses hierarchical matching: contexts inherit from parent directories
   *
   * @param collection_id Collection ID
   * @param path Relative path within the collection
   * @returns The most specific matching context or null
   */
  getContextForPath(collection_id: number, path: string): string | null {
    const result = this.db
      .prepare(
        `SELECT context FROM path_contexts
         WHERE collection_id = ?
           AND (? LIKE path_prefix || '/%' OR ? = path_prefix OR path_prefix = '')
         ORDER BY LENGTH(path_prefix) DESC
         LIMIT 1`,
      )
      .get(collection_id, path, path) as { context: string } | null;
    return result?.context || null;
  }

  /**
   * Get all matching contexts for a path (from root to specific)
   * Returns contexts ordered from least specific to most specific
   */
  getAllContextsForPath(collection_id: number, path: string): PathContextRow[] {
    return this.db
      .prepare(
        `SELECT * FROM path_contexts
         WHERE collection_id = ?
           AND (? LIKE path_prefix || '/%' OR ? = path_prefix OR path_prefix = '')
         ORDER BY LENGTH(path_prefix) ASC`,
      )
      .all(collection_id, path, path) as PathContextRow[];
  }

  /**
   * Update a path context
   */
  update(id: number, context: string): void {
    this.db.prepare(`UPDATE path_contexts SET context = ? WHERE id = ?`).run(context, id);
  }

  /**
   * Update or insert a path context
   */
  upsert(collection_id: number, path_prefix: string, context: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO path_contexts (collection_id, path_prefix, context, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(collection_id, path_prefix) 
         DO UPDATE SET context = excluded.context`,
      )
      .run(collection_id, path_prefix, context, now);
  }

  /**
   * Delete a path context
   */
  delete(id: number): void {
    this.db.prepare(`DELETE FROM path_contexts WHERE id = ?`).run(id);
  }

  /**
   * Delete path context by collection and prefix
   */
  deleteByCollectionAndPrefix(collection_id: number, path_prefix: string): void {
    this.db
      .prepare(`DELETE FROM path_contexts WHERE collection_id = ? AND path_prefix = ?`)
      .run(collection_id, path_prefix);
  }

  /**
   * Delete all path contexts for a collection
   */
  deleteByCollection(collection_id: number): void {
    this.db.prepare(`DELETE FROM path_contexts WHERE collection_id = ?`).run(collection_id);
  }

  /**
   * Count path contexts in a collection
   */
  countByCollection(collection_id: number): number {
    const result = this.db
      .prepare(`SELECT COUNT(*) as count FROM path_contexts WHERE collection_id = ?`)
      .get(collection_id) as { count: number };
    return result.count;
  }

  /**
   * List all path contexts across all collections
   */
  listAll(): PathContextRow[] {
    return this.db
      .prepare(
        `SELECT * FROM path_contexts 
         ORDER BY collection_id, path_prefix`,
      )
      .all() as PathContextRow[];
  }

  /**
   * Find path contexts by pattern
   */
  findByPattern(pattern: string): PathContextRow[] {
    return this.db
      .prepare(
        `SELECT * FROM path_contexts 
         WHERE path_prefix LIKE ? 
         ORDER BY collection_id, path_prefix`,
      )
      .all(pattern) as PathContextRow[];
  }
}
