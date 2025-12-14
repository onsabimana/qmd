/**
 * Search commands - FTS, vector, and hybrid search with reranking
 */

import { DEFAULT_EMBED_MODEL, DEFAULT_QUERY_MODEL, DEFAULT_RERANK_MODEL } from "src/config";
import type { Database } from "bun:sqlite";
import type { RerankDocument } from "src/core/llm";
import { ensureModelAvailable, getLLM } from "src/core/llm";
import { SearchService } from "src/core/search";
import { withDb, withDbAsync } from "src/database/connection";
import { checkIndexHealth } from "src/utils/database";
import { escapeCSV } from "src/utils/formatter";
import { logger } from "src/utils/logger";
import { colors as c, formatScore, highlightTerms, progress } from "src/utils/terminal";
import type { OutputFormat, OutputOptions, SearchResult } from "./types";

// OutputOptions is now imported from ./types.ts

/**
 * Get embedding for text using LLM abstraction
 */
export async function getEmbedding(
  text: string,
  model: string,
  isQuery: boolean = false,
  title?: string,
): Promise<number[]> {
  const llm = getLLM();
  const result = await llm.embed(text, { model, isQuery, title });

  if (!result) {
    // Try to pull model if not found
    await ensureModelAvailable(model, (p) => {
      if (p === -1) progress.indeterminate();
      else if (p === -2) progress.error();
      else progress.set(p);
    });
    const retryResult = await llm.embed(text, { model, isQuery, title });
    if (!retryResult) {
      throw new Error(`Failed to get embedding from ${model}`);
    }
    progress.clear();
    return retryResult.embedding;
  }

  return result.embedding;
}

/**
 * Rerank documents using LLM
 */
export async function rerank(
  query: string,
  documents: { file: string; text: string }[],
  model: string = DEFAULT_RERANK_MODEL,
  db?: Database,
): Promise<{ file: string; score: number }[]> {
  const llm = getLLM(db);

  // Convert to RerankDocument format
  const rerankDocs: RerankDocument[] = documents.map((doc) => ({
    file: doc.file,
    text: doc.text,
    title: doc.file.split("/").pop()?.replace(/\.md$/, "") || doc.file,
  }));

  logger.info(`Reranking ${documents.length} documents with ${model}...`);
  progress.indeterminate();

  const result = await llm.rerank(query, rerankDocs, { model, batchSize: 5 });

  progress.clear();
  logger.info("");

  return result.results.map((r) => ({ file: r.file, score: r.score }));
}

// =============================================================================
// Search utilities
// =============================================================================

/**
 * Extract snippet from document body
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
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lower.includes(term)) score++;
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

/**
 * Extract snippet with more context lines for CLI display
 */
export function extractSnippetWithContext(
  body: string,
  query: string,
  contextLines = 3,
  chunkPos?: number,
): { line: number; snippet: string; hasMatch: boolean } {
  // If chunkPos provided, focus search on that area
  let lineOffset = 0;
  let searchBody = body;
  if (chunkPos && chunkPos > 0) {
    const contextStart = Math.max(0, chunkPos - 200);
    searchBody = body.slice(contextStart);
    if (contextStart > 0) {
      lineOffset = body.slice(0, contextStart).split("\n").length - 1;
    }
  }

  const lines = searchBody.split("\n");
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  let bestLine = 0,
    bestScore = -1;

  for (const [i, line] of lines.entries()) {
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lower.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  // No query match found - return beginning of chunk area or file
  if (bestScore <= 0) {
    const preview = lines
      .slice(0, contextLines * 2)
      .join("\n")
      .trim();
    return { line: lineOffset + 1, snippet: preview, hasMatch: false };
  }

  const startLine = Math.max(0, bestLine - contextLines);
  const endLine = Math.min(lines.length, bestLine + contextLines + 1);
  const snippet = lines.slice(startLine, endLine).join("\n").trim();
  return { line: lineOffset + bestLine + 1, snippet, hasMatch: true };
}

/**
 * Output search results in various formats
 */
export function outputResults(
  results: {
    file: string;
    displayPath: string;
    title: string;
    body: string;
    score: number;
    context?: string | null;
    chunkPos?: number;
  }[],
  query: string,
  opts: OutputOptions,
): void {
  const filtered = results.filter((r) => r.score >= opts.minScore).slice(0, opts.limit);

  if (filtered.length === 0) {
    logger.info("No results found above minimum score threshold.");
    return;
  }

  if (opts.format === "json") {
    // JSON output for LLM consumption
    const output = filtered.map((row) => ({
      score: Math.round(row.score * 100) / 100,
      file: row.displayPath,
      title: row.title,
      ...(row.context && { context: row.context }),
      ...(opts.full && { body: row.body }),
      ...(!opts.full && {
        snippet: extractSnippet(row.body, query, 300, row.chunkPos).snippet,
      }),
    }));
    logger.data(JSON.stringify(output, null, 2));
  } else if (opts.format === "files") {
    // Simple score,filepath,context output
    for (const row of filtered) {
      const ctx = row.context ? `,"${row.context.replace(/"/g, '""')}"` : "";
      logger.data(`${row.score.toFixed(2)},${row.displayPath}${ctx}`);
    }
  } else if (opts.format === "cli") {
    for (const [i, row] of filtered.entries()) {
      const { line, snippet, hasMatch } = extractSnippetWithContext(row.body, query, 2, row.chunkPos);

      // Build result entry
      const path = row.displayPath;
      const lineInfo = hasMatch ? `:${line}` : "";
      let result = `${c.cyan}${path}${c.dim}${lineInfo}${c.reset}\n`;

      if (row.title) {
        result += `${c.bold}Title: ${row.title}${c.reset}\n`;
      }

      if (row.context) {
        result += `${c.dim}Context: ${row.context}${c.reset}\n`;
      }

      const score = formatScore(row.score);
      result += `Score: ${c.bold}${score}${c.reset}\n\n`;

      // Snippet with highlighting
      const highlighted = highlightTerms(snippet, query);
      result += highlighted;

      // Double empty line between results
      if (i < filtered.length - 1) result += "\n\n";

      logger.data(result);
    }
  } else if (opts.format === "md") {
    for (const row of filtered) {
      const heading = row.title || row.displayPath;
      if (opts.full) {
        logger.data(`---\n# ${heading}\n\n${row.body}\n`);
      } else {
        const { snippet } = extractSnippet(row.body, query, 500, row.chunkPos);
        logger.data(`---\n# ${heading}\n\n${snippet}\n`);
      }
    }
  } else if (opts.format === "xml") {
    for (const row of filtered) {
      const titleAttr = row.title ? ` title="${row.title.replace(/"/g, "&quot;")}"` : "";
      if (opts.full) {
        logger.data(`<file name="${row.displayPath}"${titleAttr}>\n${row.body}\n</file>\n`);
      } else {
        const { snippet } = extractSnippet(row.body, query, 500, row.chunkPos);
        logger.data(`<file name="${row.displayPath}"${titleAttr}>\n${snippet}\n</file>\n`);
      }
    }
  } else {
    // CSV format
    logger.data("score,file,title,line,snippet");
    for (const row of filtered) {
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos);
      const content = opts.full ? row.body : snippet;
      logger.data(
        `${row.score.toFixed(4)},${escapeCSV(row.displayPath)},${escapeCSV(row.title)},${line},${escapeCSV(content)}`,
      );
    }
  }
}

/**
 * Full-text search command
 */
export function search(query: string, opts: OutputOptions): void {
  withDb((db) => {
    const searchService = new SearchService(db);

    try {
      const collections = opts.collection ? [opts.collection] : undefined;
      const fetchLimit = opts.all ? 100000 : Math.max(50, opts.limit * 2);

      const results = searchService.searchFTS(query, {
        collections,
        limit: fetchLimit,
        minScore: opts.minScore,
      });

      if (results.length === 0) {
        logger.info("No results found.");
        return;
      }

      // Transform to output format and add context
      const resultsWithContext = results.map((r) => ({
        file: r.file,
        displayPath: r.displayPath,
        title: r.title,
        body: r.body,
        score: r.score,
        context: null, // Context will be added by SearchService in future refactor
        chunkPos: r.chunkPos,
      }));

      outputResults(resultsWithContext, query, opts);
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      }
      process.exit(1);
    }
  });
}

/**
 * Vector similarity search command
 */
export async function vectorSearch(
  query: string,
  opts: OutputOptions,
  model: string = DEFAULT_EMBED_MODEL,
): Promise<void> {
  await withDbAsync(async (db) => {
    const searchService = new SearchService(db);

    try {
      const collections = opts.collection ? [opts.collection] : undefined;

      // Check index health
      checkIndexHealth(db);

      // Use SearchService for vector search
      const results = await searchService.searchVector(query, model, {
        collections,
        limit: opts.all ? 500 : opts.limit,
        minScore: opts.minScore,
      });

      if (results.length === 0) {
        logger.info("No results found.");
        return;
      }

      // Transform to output format
      const resultsWithContext = results.map((r) => ({
        file: r.file,
        displayPath: r.displayPath,
        title: r.title,
        body: r.body,
        score: r.score,
        context: null,
        chunkPos: r.chunkPos,
      }));

      outputResults(resultsWithContext, query, opts);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("Vector index not found")) {
          logger.error("Vector index not found. Run 'qmd embed' first to create embeddings.");
        } else {
          logger.error(error.message);
        }
      }
      process.exit(1);
    }
  });
}

/**
 * Expand query to multiple variations
 */
export async function expandQuery(
  query: string,
  model: string = DEFAULT_QUERY_MODEL,
  db?: Database,
): Promise<string[]> {
  const llm = getLLM(db);

  logger.info("Generating query variations...");

  const queries = await llm.expandQuery(query, model, 2);

  logger.dim(`Queries: ${queries.join(" | ")}`);
  return queries;
}

/**
 * Combined search with query expansion and reranking
 */
export async function querySearch(
  query: string,
  opts: OutputOptions,
  embedModel: string = DEFAULT_EMBED_MODEL,
  rerankModel: string = DEFAULT_RERANK_MODEL,
): Promise<void> {
  await withDbAsync(async (db) => {
    const searchService = new SearchService(db);

    try {
      const collections = opts.collection ? [opts.collection] : undefined;

      // Check index health
      checkIndexHealth(db);

      // Use SearchService for hybrid search with reranking
      const results = await searchService.searchHybrid(query, {
        collections,
        limit: opts.limit,
        minScore: opts.minScore,
        model: embedModel,
        rerankModel,
        useRerank: true,
        hybridWeight: 0.5,
      });

      if (results.length === 0) {
        logger.info("No results found.");
        return;
      }

      // Transform to output format
      const resultsWithContext = results.map((r) => ({
        file: r.file,
        displayPath: r.displayPath,
        title: r.title,
        body: r.body,
        score: r.score,
        context: null,
        chunkPos: r.chunkPos,
      }));

      outputResults(resultsWithContext, query, opts);
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      }
      process.exit(1);
    }
  });
}
