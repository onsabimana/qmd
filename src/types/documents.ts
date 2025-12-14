/**
 * Shared document type definitions
 */

/**
 * Document result - core document metadata without search-specific fields
 */
export type DocumentResult = {
  filepath: string; // Full filesystem path
  displayPath: string; // Short display path (e.g., "docs/readme.md")
  title: string; // Document title (from first heading or filename)
  context: string | null; // Folder context description if configured
  hash: string; // Content hash for caching/change detection
  collectionId: number; // Parent collection ID
  modifiedAt: string; // Last modification timestamp
  bodyLength: number; // Body length in bytes (useful before loading)
  body?: string; // Document body (optional, load with getDocumentBody)
};

/**
 * Error result when document is not found
 */
export type DocumentNotFound = {
  error: "not_found";
  query: string;
  similarFiles: string[];
};

/**
 * Result from multi-get operations
 */
export type MultiGetResult =
  | {
      doc: DocumentResult;
      skipped: false;
    }
  | {
      doc: Pick<DocumentResult, "filepath" | "displayPath">;
      skipped: true;
      skipReason: string;
    };

/**
 * Multi-get file specification
 */
export type MultiGetFile =
  | {
      type: "virtual";
      collectionName: string;
      path: string;
    }
  | {
      type: "filesystem";
      filepath: string;
      fromLine?: number;
      maxLines?: number;
    };
