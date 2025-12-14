/**
 * Centralized configuration and constants
 */

// ============================================================================
// Ollama Configuration
// ============================================================================

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_EMBED_MODEL = "embeddinggemma";
export const DEFAULT_QUERY_MODEL = "qwen3:0.6b";
export const DEFAULT_GENERATE_MODEL = "qwen3:0.6b"; // Alias for QUERY_MODEL
export const DEFAULT_RERANK_MODEL = "ExpedientFalcon/qwen3-reranker:0.6b-q8_0";

// ============================================================================
// File Processing Configuration
// ============================================================================

export const DEFAULT_GLOB = "**/*.md";
export const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024; // 10KB

// Chunking: ~2000 tokens per chunk, ~3 bytes/token = 6KB
export const CHUNK_BYTE_SIZE = 6 * 1024;

// ============================================================================
// Reranking Configuration
// ============================================================================

export const RERANK_SYSTEM = `Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".`;

// ============================================================================
// Environment Detection
// ============================================================================

export const HOME = Bun.env.HOME || "/tmp";
