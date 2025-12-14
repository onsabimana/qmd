/**
 * Types for vector operations
 */

export interface VectorSearchOptions {
  limit?: number;
  collections?: string[];
  minScore?: number;
}

export interface VectorResult {
  path: string;
  score: number;
  embedding?: number[];
  collection?: string;
}

export interface EmbeddingOptions {
  model: string;
  dimensions?: number;
}
