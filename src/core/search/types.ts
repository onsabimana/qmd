/**
 * Types for search functionality
 */

export interface SearchOptions {
  collections?: string[];
  limit?: number;
  hybridWeight?: number;
  rerankModel?: string;
  includeContent?: boolean;
  minScore?: number;
}

export interface SearchResult {
  path: string;
  score: number;
  content?: string;
  collection?: string;
  snippet?: string;
}

export interface RankedResult extends SearchResult {
  finalScore: number;
  ftsScore?: number;
  vectorScore?: number;
}
