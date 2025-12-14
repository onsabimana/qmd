/**
 * Shared collection type definitions
 */

/**
 * Collection information
 */
export type CollectionInfo = {
  id: number;
  path: string;
  pattern: string;
  documents: number;
  lastUpdated: string;
};

/**
 * Index status information
 */
export type IndexStatus = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: CollectionInfo[];
};

/**
 * Index health information
 */
export type IndexHealthInfo = {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
};

/**
 * Virtual path components (qmd://collection/path)
 */
export type VirtualPath = {
  collectionName: string;
  path: string; // relative path within collection
};
