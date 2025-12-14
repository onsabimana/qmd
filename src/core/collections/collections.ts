/**
 * Collection Manager - Business logic for collection operations
 *
 * Orchestrates collection CRUD operations, indexing, and validation.
 * Uses repositories for data access.
 */

import type { Database } from "bun:sqlite";
import { Glob } from "bun";
import { CollectionRepository, DocumentRepository, type CollectionRow } from "src/database";
import { hashContent, extractTitle } from "src/utils/content";
import { getRealPath, resolve } from "src/utils/path";

export interface CollectionWithStats extends CollectionRow {
  document_count: number;
  total_size: number;
  last_modified: string | null;
}

export interface IndexingOptions {
  name?: string;
  excludeDirs?: string[];
  onProgress?: (current: number, total: number, path: string) => void;
}

export interface IndexingResult {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  orphanedContent: number;
}

export class CollectionManager {
  private collectionRepo: CollectionRepository;
  private documentRepo: DocumentRepository;

  constructor(private db: Database) {
    this.collectionRepo = new CollectionRepository(db);
    this.documentRepo = new DocumentRepository(db);
  }

  /**
   * List all collections with statistics
   */
  listWithStats(): CollectionWithStats[] {
    const collections = this.collectionRepo.list();
    return collections.map((c) => {
      const count = this.collectionRepo.countDocuments(c.id);
      const size = this.collectionRepo.getTotalSize(c.id);
      const last_modified = this.collectionRepo.getLastModified(c.id);

      return {
        ...c,
        document_count: count,
        total_size: size,
        last_modified,
      };
    });
  }

  /**
   * Get a collection by name
   */
  getByName(name: string): CollectionRow | null {
    return this.collectionRepo.getByName(name);
  }

  /**
   * Create a new collection
   */
  create(pwd: string, glob_pattern: string, name?: string): CollectionRow {
    // Generate name from pwd if not provided
    if (!name) {
      const parts = pwd.split("/").filter(Boolean);
      name = parts[parts.length - 1] || "root";
    }

    // Validate: check if name already exists
    const existingName = this.collectionRepo.getByName(name);
    if (existingName) {
      throw new Error(`Collection '${name}' already exists`);
    }

    // Validate: check if pwd+glob already exists
    const existingPwdGlob = this.collectionRepo.getByPwdAndGlob(pwd, glob_pattern);
    if (existingPwdGlob) {
      throw new Error(`A collection already exists for this path and pattern (name: ${existingPwdGlob.name})`);
    }

    return this.collectionRepo.create({ name, pwd, glob_pattern });
  }

  /**
   * Get or create a collection
   */
  getOrCreate(pwd: string, glob_pattern: string, name?: string): CollectionRow {
    const existing = this.collectionRepo.getByPwdAndGlob(pwd, glob_pattern);
    if (existing) return existing;

    return this.create(pwd, glob_pattern, name);
  }

  /**
   * Rename a collection
   */
  rename(oldName: string, newName: string): void {
    const coll = this.collectionRepo.getByName(oldName);
    if (!coll) {
      throw new Error(`Collection not found: ${oldName}`);
    }

    const existing = this.collectionRepo.getByName(newName);
    if (existing) {
      throw new Error(`Collection name already exists: ${newName}`);
    }

    this.collectionRepo.rename(coll.id, newName);
  }

  /**
   * Remove a collection and its documents
   */
  remove(name: string): { deletedDocs: number; cleanedHashes: number } {
    const coll = this.collectionRepo.getByName(name);
    if (!coll) {
      throw new Error(`Collection not found: ${name}`);
    }

    const docCount = this.collectionRepo.countDocuments(coll.id);

    // Delete all documents in this collection
    this.documentRepo.deleteByCollection(coll.id);

    // Delete the collection
    this.collectionRepo.delete(coll.id);

    // Clean up orphaned content
    const cleanedHashes = this.documentRepo.cleanupOrphanedContent();

    return {
      deletedDocs: docCount,
      cleanedHashes,
    };
  }

  /**
   * Index files in a collection
   */
  async indexFiles(pwd: string, glob_pattern: string, options: IndexingOptions = {}): Promise<IndexingResult> {
    const { name, excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"], onProgress } = options;

    // Get or create collection
    const collection = this.getOrCreate(pwd, glob_pattern, name);
    const now = new Date().toISOString();

    // Scan files using glob pattern
    const glob = new Glob(glob_pattern);
    const files: string[] = [];
    for await (const file of glob.scan({
      cwd: pwd,
      onlyFiles: true,
      followSymlinks: true,
    })) {
      const parts = file.split("/");
      const shouldSkip = parts.some((part) => part.startsWith(".") || excludeDirs.includes(part));
      if (!shouldSkip) {
        files.push(file);
      }
    }

    const total = files.length;
    if (total === 0) {
      return { indexed: 0, updated: 0, unchanged: 0, removed: 0, orphanedContent: 0 };
    }

    let indexed = 0,
      updated = 0,
      unchanged = 0;
    const seenPaths = new Set<string>();

    // Process each file
    for (let i = 0; i < files.length; i++) {
      const relativeFile = files[i];
      const filepath = getRealPath(resolve(pwd, relativeFile));
      seenPaths.add(relativeFile);

      if (onProgress) {
        onProgress(i + 1, total, relativeFile);
      }

      // Read and hash content
      const content = await Bun.file(filepath).text();
      const hash = await hashContent(content);
      const title = extractTitle(content, relativeFile);

      // Check if document exists
      const existing = this.documentRepo.getByCollectionAndPath(collection.id, relativeFile);

      if (existing) {
        if (existing.hash === hash) {
          // Hash unchanged, check if title needs updating
          if (existing.title !== title) {
            this.documentRepo.update(existing.id, { title, modified_at: now });
            updated++;
          } else {
            unchanged++;
          }
        } else {
          // Content changed - insert new content and update document
          this.documentRepo.insertContent(hash, content);
          this.documentRepo.update(existing.id, { hash, title, modified_at: now });
          updated++;
        }
      } else {
        // New document
        this.documentRepo.insertContent(hash, content);

        const stat = await Bun.file(filepath).stat();
        const modified_at = stat ? new Date(stat.mtime).toISOString() : now;

        this.documentRepo.create({
          collection_id: collection.id,
          path: relativeFile,
          title,
          hash,
          modified_at,
        });
        indexed++;
      }
    }

    // Deactivate documents that no longer exist
    const allDocs = this.documentRepo.listByCollection(collection.id);
    let removed = 0;
    for (const doc of allDocs) {
      if (!seenPaths.has(doc.path)) {
        this.documentRepo.deactivate(doc.id);
        removed++;
      }
    }

    // Clean up orphaned content
    const orphanedContent = this.documentRepo.cleanupOrphanedContent();

    // Update collection timestamp
    this.collectionRepo.update(collection.id, { updated_at: now });

    return { indexed, updated, unchanged, removed, orphanedContent };
  }

  /**
   * Get collection statistics
   */
  getStats(name: string): CollectionWithStats | null {
    const coll = this.collectionRepo.getByName(name);
    if (!coll) return null;

    const count = this.collectionRepo.countDocuments(coll.id);
    const size = this.collectionRepo.getTotalSize(coll.id);
    const last_modified = this.collectionRepo.getLastModified(coll.id);

    return {
      ...coll,
      document_count: count,
      total_size: size,
      last_modified,
    };
  }
}
