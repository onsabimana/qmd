/**
 * Cache Repository - Pure data access for Ollama API caching
 *
 * Handles all SQL operations for ollama_cache table.
 * No business logic - only cache operations.
 */

import type { Database } from "bun:sqlite";

export interface CacheRow {
  hash: string;
  result: string;
  created_at: string;
}

export class CacheRepository {
  constructor(private db: Database) {}

  /**
   * Generate a cache key from URL and body
   */
  generateKey(url: string, body: object): string {
    const hash = new Bun.CryptoHasher("sha256");
    hash.update(url);
    hash.update(JSON.stringify(body));
    return hash.digest("hex");
  }

  /**
   * Get cached result by key
   */
  get(cacheKey: string): string | null {
    const row = this.db.prepare(`SELECT result FROM ollama_cache WHERE hash = ?`).get(cacheKey) as {
      result: string;
    } | null;
    return row?.result || null;
  }

  /**
   * Set cached result
   */
  set(cacheKey: string, result: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ollama_cache (hash, result, created_at) 
         VALUES (?, ?, ?)`,
      )
      .run(cacheKey, result, now);
  }

  /**
   * Set cached result and auto-cleanup if needed
   * Randomly triggers cleanup to maintain max cache size
   */
  setWithAutoCleanup(cacheKey: string, result: string, maxSize: number = 1000): void {
    this.set(cacheKey, result);

    // Randomly trigger cleanup (1% chance)
    if (Math.random() < 0.01) {
      this.limitSize(maxSize);
    }
  }

  /**
   * Check if a cache entry exists
   */
  exists(cacheKey: string): boolean {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM ollama_cache WHERE hash = ?`).get(cacheKey) as {
      count: number;
    };
    return result.count > 0;
  }

  /**
   * Get cache entry with metadata
   */
  getWithMetadata(cacheKey: string): CacheRow | null {
    return this.db.prepare(`SELECT * FROM ollama_cache WHERE hash = ?`).get(cacheKey) as CacheRow | null;
  }

  /**
   * Delete a specific cache entry
   */
  delete(cacheKey: string): void {
    this.db.prepare(`DELETE FROM ollama_cache WHERE hash = ?`).run(cacheKey);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.db.run(`DELETE FROM ollama_cache`);
  }

  /**
   * Limit cache size to the most recent N entries
   */
  limitSize(maxSize: number): void {
    this.db.run(
      `DELETE FROM ollama_cache 
       WHERE hash NOT IN (
         SELECT hash FROM ollama_cache 
         ORDER BY created_at DESC 
         LIMIT ?
       )`,
      maxSize,
    );
  }

  /**
   * Delete cache entries older than a specific date
   */
  deleteOlderThan(date: Date): void {
    this.db.prepare(`DELETE FROM ollama_cache WHERE created_at < ?`).run(date.toISOString());
  }

  /**
   * Count cache entries
   */
  count(): number {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM ollama_cache`).get() as { count: number };
    return result.count;
  }

  /**
   * Get cache size in bytes
   */
  getSize(): number {
    const result = this.db.prepare(`SELECT SUM(LENGTH(result)) as size FROM ollama_cache`).get() as {
      size: number | null;
    };
    return result.size || 0;
  }

  /**
   * Get oldest cache entry date
   */
  getOldestEntry(): Date | null {
    const result = this.db.prepare(`SELECT MIN(created_at) as oldest FROM ollama_cache`).get() as {
      oldest: string | null;
    };
    return result.oldest ? new Date(result.oldest) : null;
  }

  /**
   * Get newest cache entry date
   */
  getNewestEntry(): Date | null {
    const result = this.db.prepare(`SELECT MAX(created_at) as newest FROM ollama_cache`).get() as {
      newest: string | null;
    };
    return result.newest ? new Date(result.newest) : null;
  }

  /**
   * List recent cache entries
   */
  listRecent(limit: number = 100): CacheRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ollama_cache 
         ORDER BY created_at DESC 
         LIMIT ?`,
      )
      .all(limit) as CacheRow[];
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    count: number;
    totalSize: number;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  } {
    return {
      count: this.count(),
      totalSize: this.getSize(),
      oldestEntry: this.getOldestEntry(),
      newestEntry: this.getNewestEntry(),
    };
  }
}
