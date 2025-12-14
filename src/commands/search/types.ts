/**
 * Search-related type definitions
 */

/**
 * Search result - lightweight result from FTS and vector search
 * Note: Uses 'file' instead of 'filepath' for backward compatibility with existing code
 */
export type SearchResult = {
  file: string; // Full filesystem path (named 'file' for historical reasons)
  displayPath: string; // Short display path (e.g., "docs/readme.md")
  title: string; // Document title
  body: string; // Document body
  context?: string | null; // Optional context information
  score: number; // Relevance score (0-1)
  source: "fts" | "vec"; // Search source (full-text or vector)
  chunkPos?: number; // Character position of matching chunk (for vector search)
};

/**
 * Ranked result for RRF fusion (simplified structure for ranking)
 */
export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
};

/**
 * Snippet extraction result
 */
export type SnippetResult = {
  line: number; // 1-indexed line number of best match
  snippet: string; // The snippet text with diff-style header
  linesBefore: number; // Lines in document before snippet
  linesAfter: number; // Lines in document after snippet
  snippetLines: number; // Number of lines in snippet
};

/**
 * Output format options for search results
 */
export type OutputFormat = "cli" | "csv" | "md" | "xml" | "files" | "json";

/**
 * Output options for search commands
 */
export type OutputOptions = {
  format: OutputFormat;
  full: boolean;
  limit: number;
  minScore: number;
  all?: boolean;
  collection?: string;
};

/**
 * Format options for result formatting
 */
export type FormatOptions = {
  format?: OutputFormat; // Optional format type
  full?: boolean; // Show full document content instead of snippet
  query?: string; // Query for snippet extraction and highlighting
  useColor?: boolean; // Enable terminal colors (default: false for non-CLI)
  maxLines?: number;
};
