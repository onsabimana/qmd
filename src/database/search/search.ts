/**
 * Search Repository - Pure data access for FTS (Full-Text Search)
 *
 * Handles all SQL operations for documents_fts table.
 * No business logic - only FTS queries.
 */

import type { Database } from "bun:sqlite";

export interface FTSSearchResult {
  id: number;
  path: string;
  body: string;
  score: number;
}

export interface FTSSearchResultWithDocument extends FTSSearchResult {
  collection_id: number;
  collection_name: string;
  title: string;
  hash: string;
  modified_at: string;
}

export class SearchRepository {
  constructor(private db: Database) {}

  /**
   * Sanitize a term for FTS5 queries
   */
  private sanitizeFTS5Term(term: string): string {
    return term.replace(/[^\p{L}\p{N}']/gu, "").toLowerCase();
  }

  /**
   * Build an FTS5 query from search terms
   */
  private buildFTS5Query(query: string): string | null {
    const terms = query
      .split(/\s+/)
      .map((t) => this.sanitizeFTS5Term(t))
      .filter((t) => t.length > 0);

    if (terms.length === 0) return null;
    if (terms.length === 1) return `"${terms[0]}"*`;

    return terms.map((t) => `"${t}"*`).join(" AND ");
  }

  /**
   * Full-text search using FTS5
   * Returns raw FTS results with BM25 scores
   */
  searchFTS(query: string, limit: number = 20, collectionId?: number): FTSSearchResultWithDocument[] {
    const ftsQuery = this.buildFTS5Query(query);
    if (!ftsQuery) return [];

    let sql = `
      SELECT
        d.id,
        d.path,
        d.title,
        d.hash,
        d.modified_at,
        d.collection_id,
        c.name as collection_name,
        f.body,
        bm25(documents_fts, 10.0, 1.0) as score
      FROM documents_fts f
      JOIN documents d ON d.id = f.rowid
      JOIN collections c ON c.id = d.collection_id
      WHERE documents_fts MATCH ? AND d.active = 1
    `;

    const params: (string | number)[] = [ftsQuery];

    if (collectionId !== undefined) {
      sql += ` AND d.collection_id = ?`;
      params.push(collectionId);
    }

    sql += ` ORDER BY score LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as FTSSearchResultWithDocument[];
  }

  /**
   * Search for documents by path pattern in FTS index
   */
  searchByPath(pathPattern: string, limit: number = 20): FTSSearchResultWithDocument[] {
    return this.db
      .prepare(
        `SELECT
          d.id,
          d.path,
          d.title,
          d.hash,
          d.modified_at,
          d.collection_id,
          c.name as collection_name,
          f.body,
          0 as score
        FROM documents_fts f
        JOIN documents d ON d.id = f.rowid
        JOIN collections c ON c.id = d.collection_id
        WHERE d.path LIKE ? AND d.active = 1
        ORDER BY d.path
        LIMIT ?`,
      )
      .all(pathPattern, limit) as FTSSearchResultWithDocument[];
  }

  /**
   * Rebuild the FTS index for all active documents
   */
  rebuildIndex(): void {
    // Clear existing FTS data
    this.db.run(`DELETE FROM documents_fts`);

    // Rebuild from documents + content
    this.db.run(`
      INSERT INTO documents_fts(rowid, path, body)
      SELECT d.id, d.path, c.doc
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.active = 1
    `);
  }

  /**
   * Rebuild FTS index for a specific collection
   */
  rebuildIndexForCollection(collectionId: number): void {
    // Delete FTS entries for this collection
    this.db.run(
      `
      DELETE FROM documents_fts
      WHERE rowid IN (
        SELECT id FROM documents WHERE collection_id = ?
      )
    `,
      [collectionId],
    );

    // Rebuild for this collection
    this.db.run(
      `
      INSERT INTO documents_fts(rowid, path, body)
      SELECT d.id, d.path, c.doc
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.collection_id = ? AND d.active = 1
    `,
      [collectionId],
    );
  }

  /**
   * Update FTS entry for a single document
   */
  updateFTSForDocument(documentId: number): void {
    // Delete existing entry
    this.db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(documentId);

    // Insert updated entry
    this.db.run(
      `
      INSERT INTO documents_fts(rowid, path, body)
      SELECT d.id, d.path, c.doc
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.id = ? AND d.active = 1
    `,
      [documentId],
    );
  }

  /**
   * Delete FTS entry for a document
   */
  deleteFTSForDocument(documentId: number): void {
    this.db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(documentId);
  }

  /**
   * Count documents in FTS index
   */
  countIndexedDocuments(): number {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM documents_fts`).get() as { count: number };
    return result.count;
  }

  /**
   * Get FTS index size
   */
  getIndexSize(): number {
    const result = this.db.prepare(`SELECT SUM(LENGTH(body)) as size FROM documents_fts`).get() as {
      size: number | null;
    };
    return result.size || 0;
  }

  /**
   * Optimize FTS index (rebuild and vacuum)
   */
  optimizeIndex(): void {
    this.db.run(`INSERT INTO documents_fts(documents_fts) VALUES('optimize')`);
  }
}
