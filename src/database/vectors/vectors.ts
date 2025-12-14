/**
 * Vector Repository - Pure data access for embeddings and vector search
 *
 * Handles all SQL operations for content_vectors and vectors_vec tables.
 * No business logic - only data persistence and vector queries.
 */

import type { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

export interface ContentVectorRow {
  hash: string;
  seq: number;
  pos: number;
  model: string;
  embedded_at: string;
}

export interface VectorRow {
  hash_seq: string;
  embedding: Float32Array;
}

export interface VectorSearchResult {
  hash_seq: string;
  distance: number;
  hash: string;
  seq: number;
  pos: number;
  model: string;
}

export class VectorRepository {
  constructor(private db: Database) {
    // Load sqlite-vec extension
    sqliteVec.load(db);
  }

  /**
   * Ensure the vec0 table exists with the specified dimensions
   */
  ensureVecTable(dimensions: number): void {
    const tableInfo = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`)
      .get() as { sql: string } | null;

    if (tableInfo) {
      const match = tableInfo.sql.match(/float\[(\d+)\]/);
      const hasHashSeq = tableInfo.sql.includes("hash_seq");
      if (match && parseInt(match[1]) === dimensions && hasHashSeq) {
        return; // Table already exists with correct dimensions
      }
      // Drop table if dimensions don't match or schema is outdated
      this.db.run("DROP TABLE IF EXISTS vectors_vec");
    }

    // Create new vec0 table with correct dimensions
    this.db.run(
      `CREATE VIRTUAL TABLE vectors_vec USING vec0(
        hash_seq TEXT PRIMARY KEY,
        embedding float[${dimensions}]
      )`,
    );
  }

  /**
   * Check if vec table exists
   */
  vecTableExists(): boolean {
    const result = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
    return result !== null;
  }

  /**
   * Insert or update a content vector record
   */
  insertContentVector(hash: string, seq: number, pos: number, model: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hash, seq, pos, model, now);
  }

  /**
   * Insert or update a vector embedding
   */
  insertVector(hash: string, seq: number, embedding: Float32Array): void {
    const hash_seq = `${hash}_${seq}`;
    this.db.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(hash_seq, embedding);
  }

  /**
   * Insert both content vector metadata and embedding in one transaction
   */
  insertVectorWithMetadata(hash: string, seq: number, pos: number, model: string, embedding: Float32Array): void {
    this.insertContentVector(hash, seq, pos, model);
    this.insertVector(hash, seq, embedding);
  }

  /**
   * Get content vector metadata for a hash
   */
  getContentVectors(hash: string): ContentVectorRow[] {
    return this.db.prepare(`SELECT * FROM content_vectors WHERE hash = ? ORDER BY seq`).all(hash) as ContentVectorRow[];
  }

  /**
   * Get a specific content vector by hash and sequence
   */
  getContentVector(hash: string, seq: number): ContentVectorRow | null {
    return this.db
      .prepare(`SELECT * FROM content_vectors WHERE hash = ? AND seq = ?`)
      .get(hash, seq) as ContentVectorRow | null;
  }

  /**
   * Check if a hash has embeddings for a specific model
   */
  hasEmbeddings(hash: string, model: string): boolean {
    const result = this.db
      .prepare(`SELECT COUNT(*) as count FROM content_vectors WHERE hash = ? AND model = ?`)
      .get(hash, model) as { count: number };
    return result.count > 0;
  }

  /**
   * Get all unique hashes that have embeddings
   */
  getHashesWithEmbeddings(model?: string): string[] {
    const sql = model
      ? `SELECT DISTINCT hash FROM content_vectors WHERE model = ?`
      : `SELECT DISTINCT hash FROM content_vectors`;
    const rows = model
      ? (this.db.prepare(sql).all(model) as Array<{ hash: string }>)
      : (this.db.prepare(sql).all() as Array<{ hash: string }>);
    return rows.map((r) => r.hash);
  }

  /**
   * Count hashes that need embedding (exist in content but not in content_vectors)
   */
  countHashesNeedingEmbedding(model: string): number {
    const result = this.db
      .prepare(
        `SELECT COUNT(DISTINCT c.hash) as count
         FROM content c
         LEFT JOIN content_vectors cv ON cv.hash = c.hash AND cv.model = ?
         WHERE cv.hash IS NULL`,
      )
      .get(model) as { count: number };
    return result.count;
  }

  /**
   * Get hashes that need embedding
   */
  getHashesNeedingEmbedding(model: string, limit?: number): string[] {
    const sql = `
      SELECT DISTINCT c.hash
      FROM content c
      LEFT JOIN content_vectors cv ON cv.hash = c.hash AND cv.model = ?
      WHERE cv.hash IS NULL
      ${limit ? `LIMIT ${limit}` : ""}
    `;
    const rows = this.db.prepare(sql).all(model) as Array<{ hash: string }>;
    return rows.map((r) => r.hash);
  }

  /**
   * Vector similarity search using KNN
   * Returns top k results by distance
   */
  searchVectors(embedding: Float32Array, k: number, collectionId?: number): VectorSearchResult[] {
    if (!this.vecTableExists()) {
      return [];
    }

    let sql = `
      SELECT
        v.hash_seq,
        v.distance,
        cv.hash,
        cv.seq,
        cv.pos,
        cv.model
      FROM vectors_vec v
      JOIN content_vectors cv ON cv.hash || '_' || cv.seq = v.hash_seq
      WHERE v.embedding MATCH ? AND k = ?
    `;

    const params: (Float32Array | number)[] = [embedding, k];

    if (collectionId !== undefined) {
      sql += `
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.hash = cv.hash
          AND d.collection_id = ?
          AND d.active = 1
        )
      `;
      params.push(collectionId);
    }

    sql += ` ORDER BY v.distance`;

    return this.db.prepare(sql).all(...params) as VectorSearchResult[];
  }

  /**
   * Delete all vectors for a hash
   */
  deleteVectorsByHash(hash: string): void {
    // Delete from content_vectors
    this.db.prepare(`DELETE FROM content_vectors WHERE hash = ?`).run(hash);

    // Delete from vectors_vec (find all hash_seq entries)
    this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ?`).run(`${hash}_%`);
  }

  /**
   * Delete a specific vector by hash and sequence
   */
  deleteVector(hash: string, seq: number): void {
    const hash_seq = `${hash}_${seq}`;
    this.db.prepare(`DELETE FROM content_vectors WHERE hash = ? AND seq = ?`).run(hash, seq);
    this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(hash_seq);
  }

  /**
   * Delete all vectors for a specific model
   */
  deleteVectorsByModel(model: string): void {
    // Get all hash_seq values for this model
    const rows = this.db
      .prepare(`SELECT hash || '_' || seq as hash_seq FROM content_vectors WHERE model = ?`)
      .all(model) as Array<{ hash_seq: string }>;

    // Delete from content_vectors
    this.db.prepare(`DELETE FROM content_vectors WHERE model = ?`).run(model);

    // Delete from vectors_vec
    for (const row of rows) {
      this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(row.hash_seq);
    }
  }

  /**
   * Count total vectors
   */
  countVectors(): number {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get() as { count: number };
    return result.count;
  }

  /**
   * Count vectors for a specific model
   */
  countVectorsByModel(model: string): number {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM content_vectors WHERE model = ?`).get(model) as {
      count: number;
    };
    return result.count;
  }

  /**
   * Get models used for embeddings
   */
  getModels(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT model FROM content_vectors ORDER BY model`).all() as Array<{
      model: string;
    }>;
    return rows.map((r) => r.model);
  }

  /**
   * Clean up orphaned vectors (vectors for hashes not in content table)
   */
  cleanupOrphanedVectors(): number {
    // Delete orphaned content_vectors
    const cvResult = this.db
      .prepare(
        `DELETE FROM content_vectors
         WHERE hash NOT IN (SELECT hash FROM content)`,
      )
      .run();

    // Delete orphaned vectors_vec entries
    const vvResult = this.db
      .prepare(
        `DELETE FROM vectors_vec
         WHERE hash_seq NOT IN (
           SELECT hash || '_' || seq FROM content_vectors
         )`,
      )
      .run();

    return cvResult.changes + vvResult.changes;
  }
}
