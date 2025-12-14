/**
 * LLM-related type definitions
 */

import type { Database } from "bun:sqlite";

export type TokenLogProb = {
  token: string;
  logprob: number;
};

export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

export type GenerateResult = {
  text: string;
  model: string;
  logprobs?: TokenLogProb[];
  done: boolean;
};

export type RerankDocumentResult = {
  file: string;
  relevant: boolean;
  confidence: number;
  score: number;
  rawToken: string;
  logprob: number;
};

export type RerankResult = {
  results: RerankDocumentResult[];
  model: string;
};

export type ModelInfo = {
  name: string;
  exists: boolean;
  size?: number;
  modifiedAt?: string;
};

export type EmbedOptions = {
  model: string;
  isQuery?: boolean;
  title?: string;
};

export type GenerateOptions = {
  model: string;
  maxTokens?: number;
  temperature?: number;
  logprobs?: boolean;
  raw?: boolean;
  stop?: string[];
};

export type RerankOptions = {
  model: string;
  batchSize?: number;
};

export type RerankDocument = {
  file: string;
  text: string;
  title?: string;
};

export interface LLM {
  embed(text: string, options: EmbedOptions): Promise<EmbeddingResult | null>;
  generate(prompt: string, options: GenerateOptions): Promise<GenerateResult | null>;
  modelExists(model: string): Promise<ModelInfo>;
  pullModel(model: string, onProgress?: (progress: number) => void): Promise<boolean>;
  expandQuery(query: string, model: string, numVariations?: number): Promise<string[]>;
  rerank(query: string, documents: RerankDocument[], options: RerankOptions): Promise<RerankResult>;
  rerankerLogprobsCheck(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions,
  ): Promise<RerankDocumentResult[]>;
}

export type OllamaConfig = {
  baseUrl?: string;
  defaultEmbedModel?: string;
  defaultGenerateModel?: string;
  defaultRerankModel?: string;
  cache?: Database;
};
