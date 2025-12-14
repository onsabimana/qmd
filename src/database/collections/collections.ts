/**
 * Collections Repository - Pure data access for collections
 *
 * Handles all SQL operations for collections table.
 * No business logic - only data persistence.
 */

import type { Database } from "bun:sqlite";

export interface CollectionRow {
  id: number;
  name: string;
  pwd: string;
  glob_pattern: string;
  created_at: string;
  updated_at: string;
}

export interface CreateCollectionParams {
  name: string;
  pwd: string;
  glob_pattern: string;
}

export interface UpdateCollectionParams {
  name?: string;
  glob_pattern?: string;
  updated_at?: string;
}

export class CollectionRepository {
  constructor(private db: Database) {}

  /**
   * Create a new collection
   */
  create(params: CreateCollectionParams): CollectionRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO collections (name, pwd, glob_pattern, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(params.name, params.pwd, params.glob_pattern, now, now) as CollectionRow;
    return result;
  }

  /**
   * Get a collection by ID
   */
  getById(id: number): CollectionRow | null {
    return this.db.prepare(`SELECT * FROM collections WHERE id = ?`).get(id) as CollectionRow | null;
  }

  /**
   * Get a collection by name
   */
  getByName(name: string): CollectionRow | null {
    return this.db.prepare(`SELECT * FROM collections WHERE name = ?`).get(name) as CollectionRow | null;
  }

  /**
   * Get a collection by pwd and glob pattern
   */
  getByPwdAndGlob(pwd: string, glob_pattern: string): CollectionRow | null {
    return this.db
      .prepare(`SELECT * FROM collections WHERE pwd = ? AND glob_pattern = ?`)
      .get(pwd, glob_pattern) as CollectionRow | null;
  }

  /**
   * List all collections
   */
  list(): CollectionRow[] {
    return this.db.prepare(`SELECT * FROM collections ORDER BY name`).all() as CollectionRow[];
  }

  /**
   * Update a collection
   */
  update(id: number, params: UpdateCollectionParams): void {
    const updates: string[] = [];
    const values: (string | number)[] = [];

    if (params.name !== undefined) {
      updates.push("name = ?");
      values.push(params.name);
    }
    if (params.glob_pattern !== undefined) {
      updates.push("glob_pattern = ?");
      values.push(params.glob_pattern);
    }
    if (params.updated_at !== undefined) {
      updates.push("updated_at = ?");
      values.push(params.updated_at);
    }

    if (updates.length === 0) return;

    values.push(id);

    this.db.prepare(`UPDATE collections SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  }

  /**
   * Rename a collection
   */
  rename(id: number, newName: string): void {
    this.update(id, { name: newName, updated_at: new Date().toISOString() });
  }

  /**
   * Delete a collection (cascade deletes documents)
   */
  delete(id: number): void {
    this.db.prepare(`DELETE FROM collections WHERE id = ?`).run(id);
  }

  /**
   * Count documents in a collection
   */
  countDocuments(id: number): number {
    const result = this.db
      .prepare(`SELECT COUNT(*) as count FROM documents WHERE collection_id = ? AND active = 1`)
      .get(id) as { count: number };
    return result.count;
  }

  /**
   * Get total size of documents in a collection
   */
  getTotalSize(id: number): number {
    const result = this.db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(c.doc)), 0) as total_size
         FROM documents d
         JOIN content c ON c.hash = d.hash
         WHERE d.collection_id = ? AND d.active = 1`,
      )
      .get(id) as { total_size: number };
    return result.total_size;
  }

  /**
   * Get collection with document stats
   */
  getWithStats(id: number): (CollectionRow & { document_count: number; total_size: number }) | null {
    const collection = this.getById(id);
    if (!collection) return null;

    const document_count = this.countDocuments(id);
    const total_size = this.getTotalSize(id);

    return {
      ...collection,
      document_count,
      total_size,
    };
  }

  /**
   * List all collections with document stats
   */
  listWithStats(): Array<CollectionRow & { document_count: number; total_size: number }> {
    const collections = this.list();
    return collections.map((c) => ({
      ...c,
      document_count: this.countDocuments(c.id),
      total_size: this.getTotalSize(c.id),
    }));
  }

  /**
   * Get last modified timestamp for documents in collection
   */
  getLastModified(collection_id: number): string | null {
    const result = this.db
      .prepare(
        `SELECT MAX(modified_at) as last_modified 
         FROM documents 
         WHERE collection_id = ? AND active = 1`,
      )
      .get(collection_id) as { last_modified: string | null };
    return result.last_modified;
  }

  /**
   * Get collection by name with PWD info
   */
  getByNameWithPath(name: string): { id: number; pwd: string } | null {
    return this.db.prepare(`SELECT id, pwd FROM collections WHERE name = ?`).get(name) as {
      id: number;
      pwd: string;
    } | null;
  }

  /**
   * Find document's collection and path by absolute path
   */
  findDocumentByAbsolutePath(absolutePath: string): { name: string; path: string } | null {
    return this.db
      .prepare(
        `SELECT c.name, d.path
         FROM documents d
         JOIN collections c ON c.id = d.collection_id
         WHERE c.pwd || '/' || d.path = ? AND d.active = 1
         LIMIT 1`,
      )
      .get(absolutePath) as { name: string; path: string } | null;
  }
}
