/**
 * Document Service - Business logic for document operations
 *
 * Orchestrates document retrieval, finding, and content access.
 * Uses repositories for data access.
 */

import type { Database } from "bun:sqlite";
import { DocumentRepository, CollectionRepository, ContextRepository, type DocumentWithContent } from "src/database";

export interface DocumentResult {
  filepath: string;
  displayPath: string;
  title: string;
  context: string | null;
  hash: string;
  collectionId: number;
  modifiedAt: string;
  bodyLength: number;
  body?: string;
}

export interface DocumentNotFound {
  error: "not_found";
  query: string;
  similarFiles: string[];
}

export interface MultiGetFile {
  file: string;
  title: string;
  context: string | null;
  body: string;
}

export class DocumentService {
  private documentRepo: DocumentRepository;
  private collectionRepo: CollectionRepository;
  private contextRepo: ContextRepository;

  constructor(private db: Database) {
    this.documentRepo = new DocumentRepository(db);
    this.collectionRepo = new CollectionRepository(db);
    this.contextRepo = new ContextRepository(db);
  }

  /**
   * Find a document by filename/path with fuzzy matching
   */
  findDocument(filename: string, options: { includeBody?: boolean } = {}): DocumentResult | DocumentNotFound {
    let filepath = filename;

    // Strip :line suffix if present
    const colonMatch = filepath.match(/:(\d+)$/);
    if (colonMatch) {
      filepath = filepath.slice(0, -colonMatch[0].length);
    }

    // Expand ~ to home directory
    if (filepath.startsWith("~/")) {
      const home = Bun.env.HOME || "/";
      filepath = home + filepath.slice(1);
    }

    // Try to find document by various strategies
    let doc: DocumentWithContent | null = null;

    // Try exact collection + path match from virtual path
    if (filepath.startsWith("qmd://")) {
      const parts = filepath.slice(6).split("/");
      const collectionName = parts[0];
      const path = parts.slice(1).join("/");

      const collection = this.collectionRepo.getByName(collectionName);
      if (collection) {
        doc = this.documentRepo.getByCollectionAndPathWithContent(collection.id, path);
      }
    }

    // Try absolute path matching
    if (!doc) {
      // Query all collections to find matching document
      const allCollections = this.collectionRepo.list();
      for (const coll of allCollections) {
        const fullPath = `${coll.pwd}/${filepath}`;
        const relativePath = fullPath.startsWith(coll.pwd + "/") ? fullPath.slice(coll.pwd.length + 1) : fullPath;

        doc = this.documentRepo.getByCollectionAndPathWithContent(coll.id, relativePath);
        if (doc) break;
      }
    }

    // Try fuzzy path matching
    if (!doc) {
      const pattern = `%${filepath}%`;
      const matches = this.documentRepo.findByPathPattern(pattern, 1);
      if (matches.length > 0) {
        doc = this.documentRepo.getWithContent(matches[0].id);
      }
    }

    if (!doc) {
      const similar = this.findSimilarFiles(filepath, 5);
      return { error: "not_found", query: filename, similarFiles: similar };
    }

    // Get collection info for display path
    const collection = this.collectionRepo.getById(doc.collection_id);
    if (!collection) {
      throw new Error(`Collection not found for document ${doc.id}`);
    }

    const displayPath = `qmd://${collection.name}/${doc.path}`;
    const context = this.contextRepo.getContextForPath(doc.collection_id, doc.path);

    const result: DocumentResult = {
      filepath: `${collection.pwd}/${doc.path}`,
      displayPath,
      title: doc.title,
      context,
      hash: doc.hash,
      collectionId: doc.collection_id,
      modifiedAt: doc.modified_at,
      bodyLength: doc.doc_length,
    };

    if (options.includeBody) {
      result.body = doc.doc;
    }

    return result;
  }

  /**
   * Get document body with optional line slicing
   */
  getDocumentBody(filepath: string, fromLine?: number, maxLines?: number): string | null {
    const doc = this.findDocument(filepath, { includeBody: true });
    if ("error" in doc) return null;

    let body = doc.body || "";

    if (fromLine !== undefined || maxLines !== undefined) {
      const lines = body.split("\n");
      const start = (fromLine || 1) - 1;
      const end = maxLines !== undefined ? start + maxLines : lines.length;
      body = lines.slice(start, end).join("\n");
    }

    return body;
  }

  /**
   * Find multiple documents by glob pattern or comma-separated list
   */
  findDocuments(
    pattern: string,
    options: { includeBody?: boolean; maxBytes?: number } = {},
  ): { docs: MultiGetFile[]; errors: string[] } {
    const { includeBody = true, maxBytes = 1024 * 1024 } = options;
    const errors: string[] = [];
    const docs: MultiGetFile[] = [];

    const isCommaSeparated = pattern.includes(",") && !pattern.includes("*") && !pattern.includes("?");

    if (isCommaSeparated) {
      // Handle comma-separated list
      const names = pattern
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      for (const name of names) {
        const result = this.findDocument(name, { includeBody });
        if ("error" in result) {
          const similar = result.similarFiles;
          let msg = `File not found: ${name}`;
          if (similar.length > 0) {
            msg += ` (did you mean: ${similar.join(", ")}?)`;
          }
          errors.push(msg);
        } else {
          docs.push({
            file: result.displayPath,
            title: result.title,
            context: result.context,
            body: result.body || "",
          });
        }
      }
    } else {
      // Handle glob pattern
      const matchingDocs = this.documentRepo.findByPathPattern(pattern.replace("*", "%"), 100);

      let totalBytes = 0;
      for (const doc of matchingDocs) {
        const collection = this.collectionRepo.getById(doc.collection_id);
        if (!collection) continue;

        const displayPath = `qmd://${collection.name}/${doc.path}`;
        const context = this.contextRepo.getContextForPath(doc.collection_id, doc.path);

        let body = "";
        if (includeBody) {
          const content = this.documentRepo.getContent(doc.hash);
          if (content) {
            body = content.doc;
            totalBytes += body.length;

            if (totalBytes > maxBytes) {
              errors.push(`Maximum size limit (${maxBytes} bytes) reached. Some files omitted.`);
              break;
            }
          }
        }

        docs.push({
          file: displayPath,
          title: doc.title,
          context,
          body,
        });
      }
    }

    return { docs, errors };
  }

  /**
   * Find similar file paths using fuzzy matching
   */
  findSimilarFiles(query: string, limit: number = 5): string[] {
    const results = this.documentRepo.findSimilarPaths(query, limit);
    return results.map((d) => `qmd://${d.collection_name}/${d.path}`);
  }

  /**
   * Get documents by collection
   */
  listByCollection(collectionName: string): DocumentResult[] {
    const collection = this.collectionRepo.getByName(collectionName);
    if (!collection) return [];

    const docs = this.documentRepo.listByCollection(collection.id);

    return docs.map((doc) => {
      const displayPath = `qmd://${collection.name}/${doc.path}`;
      const context = this.contextRepo.getContextForPath(doc.collection_id, doc.path);

      // Get content length
      const content = this.documentRepo.getContent(doc.hash);
      const bodyLength = content ? content.doc.length : 0;

      return {
        filepath: `${collection.pwd}/${doc.path}`,
        displayPath,
        title: doc.title,
        context,
        hash: doc.hash,
        collectionId: doc.collection_id,
        modifiedAt: doc.modified_at,
        bodyLength,
      };
    });
  }

  /**
   * Get document count across all collections
   */
  getTotalDocumentCount(): number {
    return this.documentRepo.count();
  }

  /**
   * Get total content size across all collections
   */
  getTotalContentSize(): number {
    return this.documentRepo.getTotalContentSize();
  }
}
