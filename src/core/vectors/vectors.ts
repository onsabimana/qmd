/**
 * Vector Service - Business logic for embedding operations
 *
 * Orchestrates embedding generation, vector indexing, and chunking.
 * Uses repositories for data access and LLM for embeddings.
 */

import type { Database } from "bun:sqlite";
import { CHUNK_BYTE_SIZE } from "src/config";
import { formatDocForEmbedding, getLLM } from "src/core/llm";
import { CollectionRepository, DocumentRepository, VectorRepository } from "src/database";
import type { EmbeddingOptions } from "./types";

export interface EmbeddingOptionsWithCallback extends EmbeddingOptions {
  onProgress?: (current: number, total: number, hash: string) => void;
}

export interface EmbeddingResult {
  totalHashes: number;
  embedded: number;
  chunks: number;
  skipped: number;
}

export interface ChunkInfo {
  text: string;
  pos: number;
}

export class VectorService {
  private vectorRepo: VectorRepository;
  private documentRepo: DocumentRepository;
  private collectionRepo: CollectionRepository;

  constructor(private db: Database) {
    this.vectorRepo = new VectorRepository(db);
    this.documentRepo = new DocumentRepository(db);
    this.collectionRepo = new CollectionRepository(db);
  }

  /**
   * Get count of hashes needing embedding
   */
  getHashesNeedingEmbedding(model: string): number {
    return this.vectorRepo.countHashesNeedingEmbedding(model);
  }

  /**
   * Generate embeddings for documents
   */
  async embedDocuments(options: EmbeddingOptionsWithCallback): Promise<EmbeddingResult> {
    const { model, onProgress } = options;
    const llm = getLLM(this.db);

    // Get hashes that need embedding
    const hashes = this.vectorRepo.getHashesNeedingEmbedding(model);
    const totalHashes = hashes.length;

    if (totalHashes === 0) {
      return { totalHashes: 0, embedded: 0, chunks: 0, skipped: 0 };
    }

    // Ensure vec table exists with correct dimensions
    // We'll create it when we get the first embedding
    let dimensions: number | null = null;

    let embedded = 0;
    let totalChunks = 0;
    let skipped = 0;

    for (const [i, hash] of hashes.entries()) {

      if (onProgress) {
        onProgress(i + 1, totalHashes, hash);
      }

      // Get content
      const content = this.documentRepo.getContent(hash);
      if (!content) {
        skipped++;
        continue;
      }

      // Get a sample document for this hash to extract title
      const docs = this.documentRepo.findByHash(hash);
      const title = docs.length > 0 ? docs[0]!.title : "";

      // Chunk the document
      const chunks = this.chunkDocument(content.doc);

      // Generate embeddings for each chunk
      for (let seq = 0; seq < chunks.length; seq++) {
        const chunk = chunks[seq]!;

        // Format chunk for embedding
        const formatted = formatDocForEmbedding(chunk.text, title);

        // Get embedding
        const result = await llm.embed(formatted, { model, isQuery: false });
        if (!result || !result.embedding) {
          skipped++;
          continue;
        }

        // Initialize vec table with correct dimensions on first embedding
        if (dimensions === null) {
          dimensions = result.embedding.length;
          this.vectorRepo.ensureVecTable(dimensions);
        }

        // Store vector and metadata
        this.vectorRepo.insertVectorWithMetadata(hash, seq, chunk.pos, model, new Float32Array(result.embedding));

        totalChunks++;
      }

      embedded++;
    }

    return {
      totalHashes,
      embedded,
      chunks: totalChunks,
      skipped,
    };
  }

  /**
   * Chunk document content into smaller pieces
   */
  chunkDocument(content: string, maxBytes: number = CHUNK_BYTE_SIZE): ChunkInfo[] {
    const encoder = new TextEncoder();
    const totalBytes = encoder.encode(content).length;

    if (totalBytes <= maxBytes) {
      return [{ text: content, pos: 0 }];
    }

    const chunks: ChunkInfo[] = [];
    let charPos = 0;

    while (charPos < content.length) {
      let endPos = charPos;
      let byteCount = 0;

      // Find end position that fits within maxBytes
      while (endPos < content.length && byteCount < maxBytes) {
        const charBytes = encoder.encode(content[endPos]).length;
        if (byteCount + charBytes > maxBytes) break;
        byteCount += charBytes;
        endPos++;
      }

      if (endPos < content.length && endPos > charPos) {
        const slice = content.slice(charPos, endPos);

        // Try to break at natural boundaries
        const paragraphBreak = slice.lastIndexOf("\n\n");
        const sentenceEnd = Math.max(
          slice.lastIndexOf(". "),
          slice.lastIndexOf(".\n"),
          slice.lastIndexOf("? "),
          slice.lastIndexOf("?\n"),
          slice.lastIndexOf("! "),
          slice.lastIndexOf("!\n"),
        );
        const lineBreak = slice.lastIndexOf("\n");
        const spaceBreak = slice.lastIndexOf(" ");

        let breakPoint = -1;
        if (paragraphBreak > slice.length * 0.5) {
          breakPoint = paragraphBreak + 2;
        } else if (sentenceEnd > slice.length * 0.5) {
          breakPoint = sentenceEnd + 2;
        } else if (lineBreak > slice.length * 0.3) {
          breakPoint = lineBreak + 1;
        } else if (spaceBreak > slice.length * 0.3) {
          breakPoint = spaceBreak + 1;
        }

        if (breakPoint > 0) {
          endPos = charPos + breakPoint;
        }
      }

      if (endPos <= charPos) {
        endPos = charPos + 1;
      }

      chunks.push({
        text: content.slice(charPos, endPos),
        pos: charPos,
      });
      charPos = endPos;
    }

    return chunks;
  }

  /**
   * Delete all vectors for a specific model
   */
  deleteVectorsByModel(model: string): number {
    const count = this.vectorRepo.countVectorsByModel(model);
    this.vectorRepo.deleteVectorsByModel(model);
    return count;
  }

  /**
   * Get vector statistics
   */
  getVectorStats(model?: string): {
    totalVectors: number;
    models: string[];
    needsEmbedding: number;
  } {
    const models = this.vectorRepo.getModels();
    const totalVectors = this.vectorRepo.countVectors();
    const needsEmbedding = model ? this.vectorRepo.countHashesNeedingEmbedding(model) : 0;

    return {
      totalVectors,
      models,
      needsEmbedding,
    };
  }

  /**
   * Clean up orphaned vectors
   */
  cleanupOrphanedVectors(): number {
    return this.vectorRepo.cleanupOrphanedVectors();
  }

  /**
   * Check if vec table exists
   */
  vecTableExists(): boolean {
    return this.vectorRepo.vecTableExists();
  }

  /**
   * Ensure vec table exists with specific dimensions
   */
  ensureVecTable(dimensions: number): void {
    this.vectorRepo.ensureVecTable(dimensions);
  }
}
