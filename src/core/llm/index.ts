/**
 * LLM abstraction layer
 */

export type {
  TokenLogProb,
  EmbeddingResult,
  GenerateResult,
  RerankDocumentResult,
  RerankResult,
  ModelInfo,
  EmbedOptions,
  GenerateOptions,
  RerankOptions,
  RerankDocument,
  LLM,
  OllamaConfig,
} from "./types";

export {
  formatQueryForEmbedding,
  formatDocForEmbedding,
  Ollama,
  getDefaultOllama,
  setDefaultOllama,
  getLLM,
  ensureModelAvailable,
} from "./llm";
