/**
 * Types for search functionality
 */

export interface SearchOptions {
  collections?: string[];
  limit?: number;
  minScore?: number;
}

export interface SearchResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  source: "fts" | "vec";
  chunkPos?: number;
}
