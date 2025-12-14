/**
 * Types for context management
 */

export interface ContextWindow {
  query: string;
  documents: string[];
  maxTokens?: number;
  includeMetadata?: boolean;
}

export interface ContextResult {
  content: string;
  documents: string[];
  tokenCount: number;
  truncated: boolean;
}
