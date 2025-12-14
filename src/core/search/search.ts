/**
 * Search Service - Business logic for search operations
 *
 * Orchestrates FTS, vector, and hybrid search with reranking.
 * Uses repositories for data access and LLM for embeddings/reranking.
 */

import type { Database } from "bun:sqlite";
import { normalizeScores, reciprocalRankFusion } from "src/commands/search/utils";
import type { RerankDocument } from "src/core/llm";
import { getLLM } from "src/core/llm";
import {
  CacheRepository,
  CollectionRepository,
  DocumentRepository,
  SearchRepository,
  VectorRepository,
} from "src/database";
import type { SearchOptions, SearchResult } from "./types";

export interface HybridSearchOptions extends SearchOptions {
  hybridWeight?: number;
  model?: string;
  rerankModel?: string;
  useRerank?: boolean;
}

export class SearchService {
  private searchRepo: SearchRepository;
  private vectorRepo: VectorRepository;
  private collectionRepo: CollectionRepository;
  private cacheRepo: CacheRepository;
  private documentRepo: DocumentRepository;

  constructor(private db: Database) {
    this.searchRepo = new SearchRepository(db);
    this.vectorRepo = new VectorRepository(db);
    this.collectionRepo = new CollectionRepository(db);
    this.cacheRepo = new CacheRepository(db);
    this.documentRepo = new DocumentRepository(db);
  }

  /**
   * Full-text search using FTS5
   */
  searchFTS(query: string, options: SearchOptions = {}): SearchResult[] {
    const { collections, limit = 20 } = options;

    let collectionId: number | undefined;
    if (collections && collections.length > 0) {
      const coll = this.collectionRepo.getByName(collections[0]!);
      collectionId = coll?.id;
    }

    const results = this.searchRepo.searchFTS(query, limit, collectionId);

    // Transform to standard format
    return results.map((r) => ({
      file: `qmd://${r.collection_name}/${r.path}`,
      displayPath: `qmd://${r.collection_name}/${r.path}`,
      title: r.title,
      body: r.body,
      score: Math.abs(r.score),
      source: "fts" as const,
    }));
  }

  /**
   * Vector search using embeddings
   */
  async searchVector(query: string, model: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { collections, limit = 20 } = options;

    // Check if vector table exists
    if (!this.vectorRepo.vecTableExists()) {
      return [];
    }

    // Get embedding for query
    const embedding = await this.getEmbedding(query, model, true);
    if (!embedding) return [];

    let collectionId: number | undefined;
    if (collections && collections.length > 0) {
      const coll = this.collectionRepo.getByName(collections[0]!);
      collectionId = coll?.id;
    }

    // Search vectors (get more results initially to deduplicate)
    const vectorResults = this.vectorRepo.searchVectors(new Float32Array(embedding), limit * 3, collectionId);

    // Deduplicate by document, keeping best score
    const seen = new Map<string, { result: (typeof vectorResults)[0]; bestDist: number }>();

    for (const result of vectorResults) {
      // Get document info from repository
      const doc = this.documentRepo.getDocumentInfoByHash(result.hash);
      if (!doc) continue;

      const filepath = `qmd://${doc.collection_name}/${doc.path}`;
      const existing = seen.get(filepath);

      if (!existing || result.distance < existing.bestDist) {
        seen.set(filepath, { result, bestDist: result.distance });
      }
    }

    // Convert to search results
    return Array.from(seen.values())
      .sort((a, b) => a.bestDist - b.bestDist)
      .slice(0, limit)
      .map(({ result }) => {
        const doc = this.documentRepo.getDocumentInfoByHash(result.hash)!;

        return {
          file: `qmd://${doc.collection_name}/${doc.path}`,
          displayPath: `qmd://${doc.collection_name}/${doc.path}`,
          title: doc.title,
          body: doc.doc,
          score: 1 / (1 + result.distance),
          source: "vec" as const,
          chunkPos: result.pos,
        };
      });
  }

  /**
   * Hybrid search combining FTS and vector search
   */
  async searchHybrid(query: string, options: HybridSearchOptions = {}): Promise<SearchResult[]> {
    const {
      collections,
      limit = 20,
      hybridWeight = 0.5,
      model = "nomic-embed-text",
      rerankModel = "llama3.2:1b",
      useRerank = false,
    } = options;

    // Run both searches in parallel
    const [ftsResults, vecResults] = await Promise.all([
      Promise.resolve(this.searchFTS(query, { collections, limit })),
      this.searchVector(query, model, { collections, limit }),
    ]);

    // Apply RRF - pass as separate arrays
    const fusedResults = reciprocalRankFusion([ftsResults, vecResults], [1 - hybridWeight, hybridWeight]);

    // Convert RankedResult back to SearchResult (RRF strips source/chunkPos)
    const searchResults: SearchResult[] = fusedResults.map((r) => ({
      ...r,
      source: "fts" as const, // Hybrid results - pick dominant source
      chunkPos: undefined,
    }));

    // Optionally rerank
    if (useRerank && searchResults.length > 0) {
      return await this.rerank(query, searchResults, rerankModel);
    }

    return searchResults.slice(0, limit);
  }

  /**
   * Rerank search results using LLM
   */
  async rerank(query: string, results: SearchResult[], model: string): Promise<SearchResult[]> {
    const llm = getLLM(this.db);

    // Prepare documents for reranking
    const rerankDocs: RerankDocument[] = results.map((r) => ({
      file: r.file,
      text: r.body,
      title: r.title,
    }));

    // Rerank using LLM
    const rerankResult = await llm.rerank(query, rerankDocs, {
      model,
      batchSize: 5,
    });

    // Create score map
    const scoreMap = new Map<string, number>();
    for (const r of rerankResult.results) {
      scoreMap.set(r.file, r.score);
    }

    // Apply rerank scores and sort
    return results
      .map((r) => ({
        ...r,
        score: scoreMap.get(r.file) || 0,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Expand query using LLM
   */
  async expandQuery(query: string, model: string, count: number = 2): Promise<string[]> {
    // Check cache first
    const cacheKey = this.cacheRepo.generateKey("expandQuery", { query, model });
    const cached = this.cacheRepo.get(cacheKey);

    if (cached) {
      const lines = cached
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return [query, ...lines.slice(0, count)];
    }

    const llm = getLLM(this.db);
    const results = await llm.expandQuery(query, model, count);

    // Cache the expanded queries (excluding original)
    if (results.length > 1) {
      this.cacheRepo.setWithAutoCleanup(cacheKey, results.slice(1).join("\n"));
    }

    return results;
  }

  /**
   * Get embedding for text
   */
  private async getEmbedding(text: string, model: string, isQuery: boolean = false): Promise<number[] | null> {
    const llm = getLLM(this.db);
    const result = await llm.embed(text, { model, isQuery });
    return result?.embedding || null;
  }

  /**
   * Extract snippet from body around query terms
   */
  extractSnippet(body: string, query: string, maxLength: number = 200): { line: number; snippet: string } {
    const queryLower = query.toLowerCase();
    const lines = body.split("\n");

    // Find first line containing query terms
    let matchLine = -1;
    for (const [i, line] of lines.entries()) {
      if (line.toLowerCase().includes(queryLower)) {
        matchLine = i;
        break;
      }
    }

    if (matchLine === -1) {
      // No match, return first lines
      const snippet = lines.slice(0, 3).join(" ").slice(0, maxLength);
      return { line: 1, snippet };
    }

    // Extract context around match
    const start = Math.max(0, matchLine - 1);
    const end = Math.min(lines.length, matchLine + 2);
    const snippet = lines.slice(start, end).join(" ").slice(0, maxLength);

    return { line: matchLine + 1, snippet };
  }
}
