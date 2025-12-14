/**
 * Types for document management
 */

export interface DocumentResult {
  path: string;
  content: string;
  hash: string;
  size: number;
  modified: number;
  indexed_at: string;
  collection?: string;
}

export interface DocumentMetadata {
  path: string;
  hash: string;
  size: number;
  modified: number;
  collection?: string;
}

export interface IndexingProgress {
  current: number;
  total: number;
  path: string;
}
