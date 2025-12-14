/**
 * Types for collection management
 */

export interface CollectionInfo {
  name: string;
  document_count: number;
  total_size: number;
  index_type: "fts" | "vector" | "both";
  embedding_model?: string;
  created_at: string;
  last_indexed?: string;
}

export interface CollectionStats {
  name: string;
  documentCount: number;
  totalSize: number;
  indexType: "fts" | "vector" | "both";
  embeddingModel?: string;
  createdAt: Date;
  lastIndexed?: Date;
}

export interface CreateCollectionOptions {
  name: string;
  indexType?: "fts" | "vector" | "both";
  embeddingModel?: string;
}
