/**
 * Documents Repository - Pure data access for documents
 *
 * Handles all SQL operations for documents and content tables.
 * No business logic - only data persistence.
 */

import type { Database } from "bun:sqlite";

export interface DocumentRow {
  id: number;
  collection_id: number;
  path: string;
  title: string;
  hash: string;
  created_at: string;
  modified_at: string;
  active: number;
}

export interface ContentRow {
  hash: string;
  doc: string;
  created_at: string;
}

export interface DocumentWithContent extends DocumentRow {
  doc: string;
  doc_length: number;
}

export interface CreateDocumentParams {
  collection_id: number;
  path: string;
  title: string;
  hash: string;
  modified_at: string;
}

export interface UpdateDocumentParams {
  path?: string;
  title?: string;
  hash?: string;
  modified_at?: string;
  active?: number;
}

export class DocumentRepository {
  constructor(private db: Database) {}

  /**
   * Get document info by hash (for search result enrichment)
   * Returns document path, title, collection name and body content
   */
  getDocumentInfoByHash(hash: string): { path: string; title: string; collection_name: string; doc: string } | null {
    return this.db
      .prepare(
        `SELECT d.path, d.title, c.name as collection_name, content.doc
         FROM documents d
         JOIN collections c ON c.id = d.collection_id
         JOIN content ON content.hash = d.hash
         WHERE d.hash = ? AND d.active = 1
         LIMIT 1`,
      )
      .get(hash) as { path: string; title: string; collection_name: string; doc: string } | null;
  }

  /**
   * Insert content into content-addressable storage
   */
  insertContent(hash: string, doc: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO content (hash, doc, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(hash, doc, now);
  }

  /**
   * Get content by hash
   */
  getContent(hash: string): ContentRow | null {
    return this.db.prepare(`SELECT * FROM content WHERE hash = ?`).get(hash) as ContentRow | null;
  }

  /**
   * Delete content by hash (if no documents reference it)
   */
  deleteContent(hash: string): void {
    this.db.prepare(`DELETE FROM content WHERE hash = ?`).run(hash);
  }

  /**
   * Create a new document
   */
  create(params: CreateDocumentParams): DocumentRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO documents (collection_id, path, title, hash, created_at, modified_at, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         RETURNING *`,
      )
      .get(params.collection_id, params.path, params.title, params.hash, now, params.modified_at) as DocumentRow;
    return result;
  }

  /**
   * Get a document by ID
   */
  getById(id: number): DocumentRow | null {
    return this.db.prepare(`SELECT * FROM documents WHERE id = ? AND active = 1`).get(id) as DocumentRow | null;
  }

  /**
   * Get a document by collection and path
   */
  getByCollectionAndPath(collection_id: number, path: string): DocumentRow | null {
    return this.db
      .prepare(`SELECT * FROM documents WHERE collection_id = ? AND path = ? AND active = 1`)
      .get(collection_id, path) as DocumentRow | null;
  }

  /**
   * Get a document with its content
   */
  getWithContent(id: number): DocumentWithContent | null {
    return this.db
      .prepare(
        `SELECT d.*, c.doc, LENGTH(c.doc) as doc_length
         FROM documents d
         JOIN content c ON c.hash = d.hash
         WHERE d.id = ? AND d.active = 1`,
      )
      .get(id) as DocumentWithContent | null;
  }

  /**
   * Get document by collection and path with content
   */
  getByCollectionAndPathWithContent(collection_id: number, path: string): DocumentWithContent | null {
    return this.db
      .prepare(
        `SELECT d.*, c.doc, LENGTH(c.doc) as doc_length
         FROM documents d
         JOIN content c ON c.hash = d.hash
         WHERE d.collection_id = ? AND d.path = ? AND d.active = 1`,
      )
      .get(collection_id, path) as DocumentWithContent | null;
  }

  /**
   * List all documents in a collection
   */
  listByCollection(collection_id: number, active_only: boolean = true): DocumentRow[] {
    const sql = active_only
      ? `SELECT * FROM documents WHERE collection_id = ? AND active = 1 ORDER BY path`
      : `SELECT * FROM documents WHERE collection_id = ? ORDER BY path`;
    return this.db.prepare(sql).all(collection_id) as DocumentRow[];
  }

  /**
   * List documents with content by collection
   */
  listByCollectionWithContent(collection_id: number): DocumentWithContent[] {
    return this.db
      .prepare(
        `SELECT d.*, c.doc, LENGTH(c.doc) as doc_length
         FROM documents d
         JOIN content c ON c.hash = d.hash
         WHERE d.collection_id = ? AND d.active = 1
         ORDER BY d.path`,
      )
      .all(collection_id) as DocumentWithContent[];
  }

  /**
   * Find documents by path pattern (LIKE query)
   */
  findByPathPattern(pattern: string, limit: number = 100): DocumentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM documents 
         WHERE path LIKE ? AND active = 1 
         ORDER BY path 
         LIMIT ?`,
      )
      .all(pattern, limit) as DocumentRow[];
  }

  /**
   * Update a document
   */
  update(id: number, params: UpdateDocumentParams): void {
    const updates: string[] = [];
    const values: (string | number)[] = [];

    if (params.path !== undefined) {
      updates.push("path = ?");
      values.push(params.path);
    }
    if (params.title !== undefined) {
      updates.push("title = ?");
      values.push(params.title);
    }
    if (params.hash !== undefined) {
      updates.push("hash = ?");
      values.push(params.hash);
    }
    if (params.modified_at !== undefined) {
      updates.push("modified_at = ?");
      values.push(params.modified_at);
    }
    if (params.active !== undefined) {
      updates.push("active = ?");
      values.push(params.active);
    }

    if (updates.length === 0) return;

    values.push(id);

    this.db.prepare(`UPDATE documents SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  }

  /**
   * Mark a document as inactive (soft delete)
   */
  deactivate(id: number): void {
    this.update(id, { active: 0 });
  }

  /**
   * Mark documents as inactive by collection
   */
  deactivateByCollection(collection_id: number): void {
    this.db.prepare(`UPDATE documents SET active = 0 WHERE collection_id = ?`).run(collection_id);
  }

  /**
   * Delete a document (hard delete)
   */
  delete(id: number): void {
    this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
  }

  /**
   * Delete all documents in a collection
   */
  deleteByCollection(collection_id: number): void {
    this.db.prepare(`DELETE FROM documents WHERE collection_id = ?`).run(collection_id);
  }

  /**
   * Count active documents
   */
  count(): number {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as {
      count: number;
    };
    return result.count;
  }

  /**
   * Count documents in a collection
   */
  countByCollection(collection_id: number): number {
    const result = this.db
      .prepare(`SELECT COUNT(*) as count FROM documents WHERE collection_id = ? AND active = 1`)
      .get(collection_id) as { count: number };
    return result.count;
  }

  /**
   * Get total content size
   */
  getTotalContentSize(): number {
    const result = this.db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(c.doc)), 0) as total_size
         FROM documents d
         JOIN content c ON c.hash = d.hash
         WHERE d.active = 1`,
      )
      .get() as { total_size: number };
    return result.total_size;
  }

  /**
   * Find documents by hash
   */
  findByHash(hash: string): DocumentRow[] {
    return this.db.prepare(`SELECT * FROM documents WHERE hash = ? AND active = 1`).all(hash) as DocumentRow[];
  }

  /**
   * List all active documents with basic info (for MCP resource listing)
   */
  listAllWithInfo(limit: number = 1000): Array<{ display_path: string; title: string }> {
    return this.db
      .prepare(
        `SELECT display_path, title
         FROM documents
         WHERE active = 1
         ORDER BY modified_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ display_path: string; title: string }>;
  }

  /**
   * Find document by display_path
   */
  findByDisplayPath(displayPath: string): (DocumentRow & { body: string }) | null {
    const result = this.db
      .prepare(
        `SELECT d.*, c.doc as body
         FROM documents d
         LEFT JOIN content c ON c.hash = d.hash
         WHERE d.display_path = ? AND d.active = 1`,
      )
      .get(displayPath) as (DocumentRow & { body: string }) | null;
    return result;
  }

  /**
   * Find document by display_path suffix (partial match)
   */
  findByDisplayPathSuffix(suffix: string): (DocumentRow & { body: string }) | null {
    const result = this.db
      .prepare(
        `SELECT d.*, c.doc as body
         FROM documents d
         LEFT JOIN content c ON c.hash = d.hash
         WHERE d.display_path LIKE ? AND d.active = 1
         LIMIT 1`,
      )
      .get(`%${suffix}`) as (DocumentRow & { body: string }) | null;
    return result;
  }

  /**
   * Find similar document paths (fuzzy search)
   */
  findSimilarPaths(query: string, limit: number = 5): Array<{ path: string; collection_name: string }> {
    const queryLower = query.toLowerCase();
    return this.db
      .prepare(
        `SELECT d.path, c.name as collection_name
         FROM documents d
         JOIN collections c ON c.id = d.collection_id
         WHERE d.active = 1 AND LOWER(d.path) LIKE ?
         LIMIT ?`,
      )
      .all(`%${queryLower}%`, limit) as Array<{ path: string; collection_name: string }>;
  }

  /**
   * Get document info by hash (for search result enrichment)
   */
  getDocumentInfoByHash(hash: string): { path: string; title: string; collection_name: string; doc: string } | null {
    return this.db
      .prepare(
        `SELECT d.path, d.title, c.name as collection_name, content.doc
         FROM documents d
         JOIN collections c ON c.id = d.collection_id
         JOIN content ON content.hash = d.hash
         WHERE d.hash = ? AND d.active = 1
         LIMIT 1`,
      )
      .get(hash) as { path: string; title: string; collection_name: string; doc: string } | null;
  }

  /**
   * Check if a document exists
   */
  exists(collection_id: number, path: string): boolean {
    const result = this.db
      .prepare(
        `SELECT COUNT(*) as count 
         FROM documents 
         WHERE collection_id = ? AND path = ? AND active = 1`,
      )
      .get(collection_id, path) as { count: number };
    return result.count > 0;
  }

  /**
   * Get all unique hashes referenced by active documents
   */
  getActiveHashes(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT hash 
         FROM documents 
         WHERE active = 1`,
      )
      .all() as Array<{ hash: string }>;
    return rows.map((r) => r.hash);
  }

  /**
   * Clean up orphaned content (content not referenced by any active document)
   */
  cleanupOrphanedContent(): number {
    const result = this.db
      .prepare(
        `DELETE FROM content 
         WHERE hash NOT IN (
           SELECT DISTINCT hash 
           FROM documents 
           WHERE active = 1
         )`,
      )
      .run();
    return result.changes;
  }
}
