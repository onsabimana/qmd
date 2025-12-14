/**
 * LLM abstraction layer
 */

export {
  ensureModelAvailable,
  formatDocForEmbedding,
  formatQueryForEmbedding,
  getDefaultOllama,
  getLLM,
  Ollama,
  setDefaultOllama,
} from "./llm";
export type {
  EmbeddingResult,
  EmbedOptions,
  GenerateOptions,
  GenerateResult,
  LLM,
  ModelInfo,
  OllamaConfig,
  RerankDocument,
  RerankDocumentResult,
  RerankOptions,
  RerankResult,
  TokenLogProb,
} from "./types";
