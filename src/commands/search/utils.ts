/**
 * Search-related utility functions
 */

import type { RankedResult } from "./types";

/**
 * Normalize BM25 scores to 0-1 range using min-max scaling
 */
export function normalizeBM25(scores: number[]): number[] {
  if (scores.length === 0) return [];

  const min = Math.min(...scores);
  const max = Math.max(...scores);

  if (max === min) {
    return scores.map(() => 1.0);
  }

  return scores.map((s) => (s - min) / (max - min));
}

/**
 * Normalize scores to 0-1 range (generic version)
 */
export function normalizeScores<T extends { score: number }>(results: T[]): T[] {
  if (results.length === 0) return results;
  const maxScore = Math.max(...results.map((r) => r.score));
  const minScore = Math.min(...results.map((r) => r.score));
  const range = maxScore - minScore || 1;
  return results.map((r) => ({ ...r, score: (r.score - minScore) / range }));
}

/**
 * Reciprocal Rank Fusion: combines multiple ranked lists
 * RRF score = sum(1 / (k + rank)) across all lists where doc appears
 * k=60 is standard, provides good balance between top and lower ranks
 */
export function reciprocalRankFusion(
  resultLists: RankedResult[][],
  weights: number[] = [],
  k: number = 60,
): RankedResult[] {
  const scores = new Map<
    string,
    {
      score: number;
      displayPath: string;
      title: string;
      body: string;
      bestRank: number;
    }
  >();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const results = resultLists[listIdx]!;
    const weight = weights[listIdx] ?? 1.0;
    for (let rank = 0; rank < results.length; rank++) {
      const doc = results[rank]!;
      const rrfScore = weight / (k + rank + 1);
      const existing = scores.get(doc.file);
      if (existing) {
        existing.score += rrfScore;
        existing.bestRank = Math.min(existing.bestRank, rank);
      } else {
        scores.set(doc.file, {
          score: rrfScore,
          displayPath: doc.displayPath,
          title: doc.title,
          body: doc.body,
          bestRank: rank,
        });
      }
    }
  }

  // Add bonus for best rank: documents that ranked #1-3 in any list get a boost
  // This prevents dilution of exact matches by expansion queries
  return Array.from(scores.entries())
    .map(([file, { score, displayPath, title, body, bestRank }]) => {
      let bonus = 0;
      if (bestRank === 0) bonus = 0.05;
      else if (bestRank <= 2) bonus = 0.02;
      return { file, displayPath, title, body, score: score + bonus };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Extract a snippet from content around the best match
 * Returns highlighted snippet with context
 */
export function extractSnippetWithContext(content: string, query: string, maxLength: number = 200): string {
  if (!content || !query) return "";

  const contentLower = content.toLowerCase();
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/).filter((t) => t.length >= 3);

  if (terms.length === 0) {
    return content.slice(0, maxLength) + (content.length > maxLength ? "..." : "");
  }

  // Find best matching position
  let bestPos = -1;
  let bestScore = 0;

  for (const term of terms) {
    const pos = contentLower.indexOf(term);
    if (pos !== -1) {
      // Simple scoring: earlier matches + term length
      const score = 1000 - pos + term.length * 10;
      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }
  }

  if (bestPos === -1) {
    return content.slice(0, maxLength) + (content.length > maxLength ? "..." : "");
  }

  // Extract snippet around match
  const contextBefore = 50;
  const start = Math.max(0, bestPos - contextBefore);
  const end = Math.min(content.length, start + maxLength);

  let snippet = content.slice(start, end);

  // Add ellipsis if truncated
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";

  return snippet.trim();
}
