/**
 * Context Service - Business logic for context management
 *
 * Orchestrates path context operations and hierarchical context resolution.
 * Uses repositories for data access.
 */

import type { Database } from "bun:sqlite";
import { CollectionRepository, ContextRepository, DocumentRepository, type PathContextRow } from "src/database";

export interface ContextInfo {
  collectionId: number;
  collectionName: string;
  path: string;
  context: string;
}

export class ContextService {
  private contextRepo: ContextRepository;
  private collectionRepo: CollectionRepository;
  private documentRepo: DocumentRepository;

  constructor(private db: Database) {
    this.contextRepo = new ContextRepository(db);
    this.collectionRepo = new CollectionRepository(db);
    this.documentRepo = new DocumentRepository(db);
  }

  /**
   * Get context for a specific path in a collection
   * Uses hierarchical inheritance from parent directories
   */
  getContextForPath(collectionName: string, path: string): string | null {
    const collection = this.collectionRepo.getByName(collectionName);
    if (!collection) return null;

    return this.contextRepo.getContextForPath(collection.id, path);
  }

  /**
   * Get context for a file using its absolute path
   * Resolves to collection and path first
   */
  getContextForFile(filepath: string): string | null {
    // Try to find the document to get its collection_id and path
    const allCollections = this.collectionRepo.list();

    for (const coll of allCollections) {
      if (filepath.startsWith(coll.pwd + "/")) {
        const relativePath = filepath.slice(coll.pwd.length + 1);
        const doc = this.documentRepo.getByCollectionAndPath(coll.id, relativePath);

        if (doc) {
          return this.contextRepo.getContextForPath(coll.id, doc.path);
        }
      }
    }

    return null;
  }

  /**
   * Set or update context for a path in a collection
   */
  setContext(collectionName: string, pathPrefix: string, context: string): void {
    const collection = this.collectionRepo.getByName(collectionName);
    if (!collection) {
      throw new Error(`Collection not found: ${collectionName}`);
    }

    this.contextRepo.upsert(collection.id, pathPrefix, context);
  }

  /**
   * Delete context for a path in a collection
   */
  deleteContext(collectionName: string, pathPrefix: string): void {
    const collection = this.collectionRepo.getByName(collectionName);
    if (!collection) {
      throw new Error(`Collection not found: ${collectionName}`);
    }

    this.contextRepo.deleteByCollectionAndPrefix(collection.id, pathPrefix);
  }

  /**
   * List all contexts for a collection
   */
  listContexts(collectionName: string): ContextInfo[] {
    const collection = this.collectionRepo.getByName(collectionName);
    if (!collection) return [];

    const contexts = this.contextRepo.listByCollection(collection.id);

    return contexts.map((c) => ({
      collectionId: c.collection_id,
      collectionName: collection.name,
      path: c.path_prefix,
      context: c.context,
    }));
  }

  /**
   * Get all contexts across all collections
   */
  listAllContexts(): ContextInfo[] {
    const allContexts = this.contextRepo.listAll();
    const result: ContextInfo[] = [];

    for (const ctx of allContexts) {
      const collection = this.collectionRepo.getById(ctx.collection_id);
      if (collection) {
        result.push({
          collectionId: ctx.collection_id,
          collectionName: collection.name,
          path: ctx.path_prefix,
          context: ctx.context,
        });
      }
    }

    return result;
  }

  /**
   * Get all matching contexts for a path (from root to specific)
   */
  getAllContextsForPath(collectionName: string, path: string): ContextInfo[] {
    const collection = this.collectionRepo.getByName(collectionName);
    if (!collection) return [];

    const contexts = this.contextRepo.getAllContextsForPath(collection.id, path);

    return contexts.map((c) => ({
      collectionId: c.collection_id,
      collectionName: collection.name,
      path: c.path_prefix,
      context: c.context,
    }));
  }

  /**
   * Find contexts by pattern
   */
  findContextsByPattern(pattern: string): ContextInfo[] {
    const contexts = this.contextRepo.findByPattern(pattern);
    const result: ContextInfo[] = [];

    for (const ctx of contexts) {
      const collection = this.collectionRepo.getById(ctx.collection_id);
      if (collection) {
        result.push({
          collectionId: ctx.collection_id,
          collectionName: collection.name,
          path: ctx.path_prefix,
          context: ctx.context,
        });
      }
    }

    return result;
  }

  /**
   * Count contexts in a collection
   */
  countContexts(collectionName: string): number {
    const collection = this.collectionRepo.getByName(collectionName);
    if (!collection) return 0;

    return this.contextRepo.countByCollection(collection.id);
  }

  /**
   * Delete all contexts for a collection
   */
  deleteAllContexts(collectionName: string): void {
    const collection = this.collectionRepo.getByName(collectionName);
    if (!collection) {
      throw new Error(`Collection not found: ${collectionName}`);
    }

    this.contextRepo.deleteByCollection(collection.id);
  }
}
