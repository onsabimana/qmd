/**
 * Text and string utilities
 */

import { homedir } from "os";

/**
 * Shorten a file path relative to home directory
 */
export function shortPath(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/**
 * Sanitize a term for FTS5 MATCH queries
 * - Remove quotes and special chars
 * - Preserve wildcards if present
 */
export function sanitizeFTS5Term(term: string): string {
  return term.replace(/["*]/g, "").trim();
}

/**
 * Build FTS5 MATCH query from search terms
 * - Each term is OR'd together
 * - Terms are sanitized for FTS5
 */
export function buildFTS5Query(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(sanitizeFTS5Term)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return "";

  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Extract snippet from document body with query term highlighting
 */
export function extractSnippet(
  body: string,
  query: string,
  maxChars: number = 300,
  chunkPos?: number,
): { line: number; snippet: string } {
  const lines = body.split("\n");
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  let bestLine = 0;
  let bestScore = -1;

  // Find line with most query term matches
  for (const [i, line] of lines.entries()) {
    const lineLower = line.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lineLower.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  // Extract snippet around best line
  const contextLines = 2;
  const startLine = Math.max(0, bestLine - contextLines);
  const endLine = Math.min(lines.length, bestLine + contextLines + 1);
  let snippet = lines.slice(startLine, endLine).join("\n");

  // Truncate if needed
  if (snippet.length > maxChars) {
    snippet = snippet.slice(0, maxChars) + "...";
  }

  return { line: bestLine + 1, snippet };
}
