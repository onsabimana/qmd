#!/usr/bin/env bun
/**
 * QMD MCP Server - Model Context Protocol server for QMD
 *
 * Exposes QMD search and document retrieval as MCP tools and resources.
 * Documents are accessible via qmd:// URIs.
 *
 * Follows MCP spec 2025-06-18 for proper response types.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RankedResult } from "src/commands/search/types";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_MULTI_GET_MAX_BYTES,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
} from "src/config";
import { CollectionManager } from "src/core/collections";
import { ContextService } from "src/core/context";
import { DocumentService } from "src/core/documents";
import { SearchService } from "src/core/search";
import { CollectionRepository, DocumentRepository } from "src/database";
import { createConnection } from "src/database/connection";
import { reciprocalRankFusion } from "src/utils/search";
import { extractSnippet } from "src/utils/text";
import { logger } from "src/utils/logger";
import { z } from "zod";

// =============================================================================
// Types for structured content
// =============================================================================

type SearchResultItem = {
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
};

type StatusResult = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: {
    id: number;
    path: string;
    pattern: string;
    documents: number;
    lastUpdated: string;
  }[];
};

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Encode a path for use in qmd:// URIs.
 * Encodes special characters but preserves forward slashes for readability.
 */
function encodeQmdPath(path: string): string {
  // Encode each path segment separately to preserve slashes
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Format search results as human-readable text summary
 */
function formatSearchSummary(results: SearchResultItem[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}"`;
  }
  const lines = [`Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n`];
  for (const r of results) {
    lines.push(`${Math.round(r.score * 100)}% ${r.file} - ${r.title}`);
  }
  return lines.join("\n");
}

// =============================================================================
// MCP Server
// =============================================================================

export async function startMcpServer(): Promise<void> {
  // Open database once at startup - keep it open for the lifetime of the server
  const db = createConnection();

  // Initialize repositories and services
  const collRepo = new CollectionRepository(db);
  const docRepo = new DocumentRepository(db);
  const docService = new DocumentService(db);
  const searchService = new SearchService(db);
  const contextService = new ContextService(db);
  const collectionManager = new CollectionManager(db);

  const server = new McpServer({
    name: "qmd",
    version: "1.0.0",
  });

  // ---------------------------------------------------------------------------
  // Resource: qmd://{path}
  // ---------------------------------------------------------------------------

  server.registerResource(
    "document",
    new ResourceTemplate("qmd://{+path}", {
      list: async () => {
        // List all indexed documents using repository
        const docs = docRepo.listAllWithInfo(1000);

        return {
          resources: docs.map((doc) => ({
            uri: `qmd://${encodeQmdPath(doc.display_path)}`,
            name: doc.display_path,
            title: doc.title || doc.display_path,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    {
      title: "QMD Document",
      description: "A markdown document from your QMD knowledge base",
      mimeType: "text/markdown",
    },
    async (uri, { path }) => {
      // Decode URL-encoded path (MCP clients send encoded URIs)
      const decodedPath = decodeURIComponent(path as string);

      // Find document by display_path using repository
      let doc = docRepo.findByDisplayPath(decodedPath);

      // Try suffix match if exact match fails
      if (!doc) {
        doc = docRepo.findByDisplayPathSuffix(decodedPath);
      }

      if (!doc) {
        return {
          contents: [{ uri: uri.href, text: `Document not found: ${decodedPath}` }],
        };
      }

      // Build display path from collection + path
      const collection = collRepo.getById(doc.collection_id);
      const displayPath = collection ? `qmd://${collection.name}/${doc.path}` : doc.path;
      const context = contextService.getContextForFile(displayPath);

      let text = doc.body;
      if (context) {
        text = `<!-- Context: ${context} -->\n\n` + text;
      }

      return {
        contents: [
          {
            uri: uri.href,
            name: displayPath,
            title: doc.title || displayPath,
            mimeType: "text/markdown",
            text,
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Prompt: query guide
  // ---------------------------------------------------------------------------

  server.registerPrompt(
    "query",
    {
      title: "QMD Query Guide",
      description: "How to effectively search your knowledge base with QMD",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# QMD - Quick Markdown Search

QMD is your on-device search engine for markdown knowledge bases. Use it to find information across your notes, documents, and meeting transcripts.

## Available Tools

### 1. search (Fast keyword search)
Best for: Finding documents with specific keywords or phrases.
- Uses BM25 full-text search
- Fast, no LLM required
- Good for exact matches
- Use \`collection\` parameter to filter to a specific collection

### 2. vsearch (Semantic search)
Best for: Finding conceptually related content even without exact keyword matches.
- Uses vector embeddings
- Understands meaning and context
- Good for "how do I..." or conceptual queries
- Use \`collection\` parameter to filter to a specific collection

### 3. query (Hybrid search - highest quality)
Best for: Important searches where you want the best results.
- Combines keyword + semantic search
- Expands your query with variations
- Re-ranks results with LLM
- Slower but most accurate
- Use \`collection\` parameter to filter to a specific collection

### 4. get (Retrieve document)
Best for: Getting the full content of a single document you found.
- Use the file path from search results
- Supports line ranges: \`file.md:100\` or fromLine/maxLines parameters
- Suggests similar files if not found

### 5. multi_get (Retrieve multiple documents)
Best for: Getting content from multiple files at once.
- Use glob patterns: \`journals/2025-05*.md\`
- Or comma-separated: \`file1.md, file2.md\`
- Skips files over maxBytes (default 10KB) - use get for large files

### 6. status (Index info)
Shows collection info, document counts, and embedding status.

## Resources

You can also access documents directly via the \`qmd://\` URI scheme:
- List all documents: \`resources/list\`
- Read a document: \`resources/read\` with uri \`qmd://path/to/file.md\`

## Search Strategy

1. **Start with search** for quick keyword lookups
2. **Use vsearch** when keywords aren't working or for conceptual queries
3. **Use query** for important searches or when you need high confidence
4. **Use get** to retrieve a single full document
5. **Use multi_get** to batch retrieve multiple related files

## Tips

- Use \`minScore: 0.5\` to filter low-relevance results
- Use \`collection: "notes"\` to search only in a specific collection
- Check the "Context" field - it describes what kind of content the file contains
- File paths are relative to their collection (e.g., \`pages/meeting.md\`)
- For glob patterns, match on display_path (e.g., \`journals/2025-*.md\`)`,
          },
        },
      ],
    }),
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_search (BM25 full-text)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "search",
    {
      title: "Search (BM25)",
      description:
        "Fast keyword-based full-text search using BM25. Best for finding documents with specific words or phrases.",
      inputSchema: {
        query: z.string().describe("Search query - keywords or phrases to find"),
        limit: z.number().optional().default(10).describe("Maximum number of results (default: 10)"),
        minScore: z.number().optional().default(0).describe("Minimum relevance score 0-1 (default: 0)"),
        collection: z.string().optional().describe("Filter to a specific collection by name"),
      },
    },
    async ({ query, limit, minScore, collection }) => {
      // Resolve collection filter
      const collections = collection ? [collection] : undefined;

      // Check if collection exists
      if (collection) {
        const coll = collRepo.getByName(collection);
        if (!coll) {
          return {
            content: [{ type: "text", text: `Collection not found: ${collection}` }],
            isError: true,
          };
        }
      }

      const results = searchService.searchFTS(query, { collections, limit: limit || 10 });
      const filtered: SearchResultItem[] = results
        .filter((r) => r.score >= (minScore || 0))
        .map((r) => ({
          file: r.displayPath,
          title: r.title,
          score: Math.round(r.score * 100) / 100,
          context: contextService.getContextForFile(r.file),
          snippet: extractSnippet(r.body, query, 300, r.chunkPos).snippet,
        }));

      return {
        content: [{ type: "text", text: formatSearchSummary(filtered, query) }],
        structuredContent: { results: filtered },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_vsearch (Vector semantic search)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "vsearch",
    {
      title: "Vector Search (Semantic)",
      description:
        "Semantic similarity search using vector embeddings. Finds conceptually related content even without exact keyword matches. Requires embeddings (run 'qmd embed' first).",
      inputSchema: {
        query: z.string().describe("Natural language query - describe what you're looking for"),
        limit: z.number().optional().default(10).describe("Maximum number of results (default: 10)"),
        minScore: z.number().optional().default(0.3).describe("Minimum relevance score 0-1 (default: 0.3)"),
        collection: z.string().optional().describe("Filter to a specific collection by name"),
      },
    },
    async ({ query, limit, minScore, collection }) => {
      // Resolve collection filter
      const collections = collection ? [collection] : undefined;

      // Check if collection exists
      if (collection) {
        const coll = collRepo.getByName(collection);
        if (!coll) {
          return {
            content: [{ type: "text", text: `Collection not found: ${collection}` }],
            isError: true,
          };
        }
      }

      const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
      if (!tableExists) {
        return {
          content: [
            {
              type: "text",
              text: "Vector index not found. Run 'qmd embed' first to create embeddings.",
            },
          ],
          isError: true,
        };
      }

      // Expand query
      const queries = await searchService.expandQuery(query, DEFAULT_QUERY_MODEL);

      // Collect results
      const allResults = new Map<
        string,
        {
          file: string;
          displayPath: string;
          title: string;
          body: string;
          score: number;
        }
      >();
      for (const q of queries) {
        const vecResults = await searchService.searchVector(q, DEFAULT_EMBED_MODEL, {
          collections,
          limit: limit || 10,
        });
        for (const r of vecResults) {
          const existing = allResults.get(r.file);
          if (!existing || r.score > existing.score) {
            allResults.set(r.file, {
              file: r.file,
              displayPath: r.displayPath,
              title: r.title,
              body: r.body,
              score: r.score,
            });
          }
        }
      }

      const filtered: SearchResultItem[] = Array.from(allResults.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit || 10)
        .filter((r) => r.score >= (minScore || 0.3))
        .map((r) => ({
          file: r.displayPath,
          title: r.title,
          score: Math.round(r.score * 100) / 100,
          context: contextService.getContextForFile(r.file),
          snippet: extractSnippet(r.body, query, 300).snippet,
        }));

      return {
        content: [{ type: "text", text: formatSearchSummary(filtered, query) }],
        structuredContent: { results: filtered },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_query (Hybrid with reranking)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "query",
    {
      title: "Hybrid Query (Best Quality)",
      description:
        "Highest quality search combining BM25 + vector + query expansion + LLM reranking. Slower but most accurate. Use for important searches.",
      inputSchema: {
        query: z.string().describe("Natural language query - describe what you're looking for"),
        limit: z.number().optional().default(10).describe("Maximum number of results (default: 10)"),
        minScore: z.number().optional().default(0).describe("Minimum relevance score 0-1 (default: 0)"),
        collection: z.string().optional().describe("Filter to a specific collection by name"),
      },
    },
    async ({ query, limit, minScore, collection }) => {
      // Resolve collection filter
      const collections = collection ? [collection] : undefined;

      // Check if collection exists
      if (collection) {
        const coll = collRepo.getByName(collection);
        if (!coll) {
          return {
            content: [{ type: "text", text: `Collection not found: ${collection}` }],
            isError: true,
          };
        }
      }

      // Expand query
      const queries = await searchService.expandQuery(query, DEFAULT_QUERY_MODEL);

      // Collect ranked lists
      const rankedLists: RankedResult[][] = [];
      const hasVectors = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();

      for (const q of queries) {
        const ftsResults = searchService.searchFTS(q, { collections, limit: 20 });
        if (ftsResults.length > 0) {
          rankedLists.push(
            ftsResults.map((r) => ({
              file: r.file,
              displayPath: r.displayPath,
              title: r.title,
              body: r.body,
              score: r.score,
            })),
          );
        }
        if (hasVectors) {
          const vecResults = await searchService.searchVector(q, DEFAULT_EMBED_MODEL, { collections, limit: 20 });
          if (vecResults.length > 0) {
            rankedLists.push(
              vecResults.map((r) => ({
                file: r.file,
                displayPath: r.displayPath,
                title: r.title,
                body: r.body,
                score: r.score,
              })),
            );
          }
        }
      }

      // RRF fusion
      const weights = rankedLists.map((_, i) => (i < 2 ? 2.0 : 1.0));
      const fused = reciprocalRankFusion(rankedLists, weights);
      const candidates = fused.slice(0, 30);

      // Rerank using SearchService
      const resultsForRerank = candidates.map((c) => ({
        file: c.file,
        displayPath: c.displayPath,
        title: c.title,
        body: c.body,
        score: c.score,
        source: "fts" as const,
      }));
      const reranked = await searchService.rerank(query, resultsForRerank, DEFAULT_RERANK_MODEL);

      // Blend scores
      const candidateMap = new Map(
        candidates.map((c) => [c.file, { displayPath: c.displayPath, title: c.title, body: c.body }]),
      );
      const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

      const filtered: SearchResultItem[] = reranked
        .map((r) => {
          const rrfRank = rrfRankMap.get(r.file) || candidates.length;
          let rrfWeight: number;
          if (rrfRank <= 3) rrfWeight = 0.75;
          else if (rrfRank <= 10) rrfWeight = 0.6;
          else rrfWeight = 0.4;
          const rrfScore = 1 / rrfRank;
          const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * r.score;
          const candidate = candidateMap.get(r.file);
          return {
            file: candidate?.displayPath || "",
            title: candidate?.title || "",
            score: Math.round(blendedScore * 100) / 100,
            context: contextService.getContextForFile(r.file),
            snippet: extractSnippet(candidate?.body || "", query, 300).snippet,
          };
        })
        .filter((r) => r.score >= (minScore || 0))
        .slice(0, limit || 10);

      return {
        content: [{ type: "text", text: formatSearchSummary(filtered, query) }],
        structuredContent: { results: filtered },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_get (Retrieve document)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get",
    {
      title: "Get Document",
      description:
        "Retrieve the full content of a document by its file path. Use paths from search results. Suggests similar files if not found.",
      inputSchema: {
        file: z
          .string()
          .describe(
            "File path from search results (e.g., 'pages/meeting.md' or 'pages/meeting.md:100' to start at line 100)",
          ),
        fromLine: z.number().optional().describe("Start from this line number (1-indexed)"),
        maxLines: z.number().optional().describe("Maximum number of lines to return"),
      },
    },
    async ({ file, fromLine, maxLines }) => {
      const result = docService.findDocument(file, { includeBody: true });

      if ("error" in result) {
        let msg = `Document not found: ${file}`;
        if (result.similarFiles.length > 0) {
          msg += `\n\nDid you mean one of these?\n${result.similarFiles.map((s) => `  - ${s}`).join("\n")}`;
        }
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }

      // Apply line range if specified
      let body = result.body || "";
      if (fromLine !== undefined || maxLines !== undefined) {
        const lines = body.split("\n");
        const start = fromLine ? fromLine - 1 : 0;
        const end = maxLines ? start + maxLines : lines.length;
        body = lines.slice(start, end).join("\n");
        if (end < lines.length) {
          body += `\n\n[... ${lines.length - end} more lines]`;
        }
      }

      let text = body;
      if (result.context) {
        text = `<!-- Context: ${result.context} -->\n\n` + text;
      }

      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: `qmd://${encodeQmdPath(result.displayPath)}`,
              name: result.displayPath,
              title: result.title,
              mimeType: "text/markdown",
              text,
            },
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_multi_get (Retrieve multiple documents)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "multi_get",
    {
      title: "Multi-Get Documents",
      description:
        "Retrieve multiple documents by glob pattern (e.g., 'journals/2025-05*.md') or comma-separated list. Skips files larger than maxBytes.",
      inputSchema: {
        pattern: z.string().describe("Glob pattern or comma-separated list of file paths"),
        maxLines: z.number().optional().describe("Maximum lines per file"),
        maxBytes: z.number().optional().default(10240).describe("Skip files larger than this (default: 10240 = 10KB)"),
      },
    },
    async ({ pattern, maxLines, maxBytes }) => {
      const { docs, errors } = docService.findDocuments(pattern, {
        includeBody: true,
        maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES,
      });

      if (docs.length === 0 && errors.length === 0) {
        return {
          content: [{ type: "text", text: `No files matched pattern: ${pattern}` }],
          isError: true,
        };
      }

      const content: (
        | { type: "text"; text: string }
        | {
            type: "resource";
            resource: {
              uri: string;
              name: string;
              title?: string;
              mimeType: string;
              text: string;
            };
          }
      )[] = [];

      if (errors.length > 0) {
        content.push({ type: "text", text: `Errors:\n${errors.join("\n")}` });
      }

      for (const doc of docs) {
        let body = doc.body;

        // Apply maxLines limit if specified
        if (maxLines !== undefined && maxLines > 0) {
          const lines = body.split("\n");
          body = lines.slice(0, maxLines).join("\n");
          if (lines.length > maxLines) {
            body += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
          }
        }

        let text = body;
        if (doc.context) {
          text = `<!-- Context: ${doc.context} -->\n\n` + text;
        }

        content.push({
          type: "resource",
          resource: {
            uri: `qmd://${encodeQmdPath(doc.file)}`,
            name: doc.file,
            title: doc.title,
            mimeType: "text/markdown",
            text,
          },
        });
      }

      return { content };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_status (Index status)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "status",
    {
      title: "Index Status",
      description: "Show the status of the QMD index: collections, document counts, and health information.",
      inputSchema: {},
    },
    async () => {
      // Get collections
      const collections = db
        .prepare(
          `
        SELECT c.id, c.pwd, c.glob_pattern, c.created_at,
               COUNT(d.id) as active_count,
               MAX(d.modified_at) as last_doc_update
        FROM collections c
        LEFT JOIN documents d ON d.collection_id = c.id AND d.active = 1
        GROUP BY c.id
        ORDER BY last_doc_update DESC
      `,
        )
        .all() as {
        id: number;
        pwd: string;
        glob_pattern: string;
        created_at: string;
        active_count: number;
        last_doc_update: string | null;
      }[];

      // Get document counts
      const totalDocs = (db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 1`).get() as { c: number }).c;

      // Count documents needing embeddings
      const needsEmbedding = (
        db
          .prepare(
            `
        SELECT COUNT(DISTINCT d.hash) as count
        FROM documents d
        LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
        WHERE d.active = 1 AND v.hash IS NULL
      `,
          )
          .get() as { count: number }
      ).count;

      const hasVectors = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();

      const status: StatusResult = {
        totalDocuments: totalDocs,
        needsEmbedding,
        hasVectorIndex: hasVectors,
        collections: collections.map((col) => ({
          id: col.id,
          path: col.pwd,
          pattern: col.glob_pattern,
          documents: col.active_count,
          lastUpdated: col.last_doc_update || col.created_at,
        })),
      };

      const summary = [
        `QMD Index Status:`,
        `  Total documents: ${status.totalDocuments}`,
        `  Needs embedding: ${status.needsEmbedding}`,
        `  Vector index: ${status.hasVectorIndex ? "yes" : "no"}`,
        `  Collections: ${status.collections.length}`,
      ];

      for (const col of status.collections) {
        summary.push(`    - ${col.path} (${col.documents} docs)`);
      }

      return {
        content: [{ type: "text", text: summary.join("\n") }],
        structuredContent: status,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Connect via stdio
  // ---------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Note: Database stays open - it will be closed when the process exits
}

// Run if this is the main module
if (import.meta.main) {
  startMcpServer().catch((err) => {
    logger.error(`MCP server failed to start: ${err}`);
    process.exit(1);
  });
}
