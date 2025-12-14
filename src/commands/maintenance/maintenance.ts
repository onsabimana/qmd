/**
 * Maintenance and administrative commands
 */

import { indexFiles } from "src/commands/collections";
import { CHUNK_BYTE_SIZE, DEFAULT_EMBED_MODEL } from "src/config";
import { VectorService } from "src/core/vectors";
import { CacheRepository } from "src/database/cache";
import { getDbPath, withDb, withDbAsync } from "src/database/connection";
import { VectorRepository } from "src/database/vectors";
import { chunkDocument, extractTitle } from "src/utils/content";
import { cleanupDuplicateCollections, updateDisplayPaths } from "src/utils/database";
import { logger } from "src/utils/logger";
import { colors as c, cursor, progress, renderProgressBar } from "src/utils/terminal";
import { formatBytes, formatETA, formatTimeAgo } from "src/utils/time";

/**
 * Show index status and collections
 */
export function showStatus(): void {
  const dbPath = getDbPath();
  withDb((db) => {
    // Cleanup any duplicate collections
    cleanupDuplicateCollections(db);

    // Index size
    let indexSize = 0;
    try {
      const stat = Bun.file(dbPath).size;
      indexSize = stat;
    } catch {}

    // Collections info
    const collections = db
      .prepare(`
    SELECT c.id, c.name, c.pwd, c.glob_pattern, c.created_at,
           COUNT(d.id) as doc_count,
           SUM(CASE WHEN d.active = 1 THEN 1 ELSE 0 END) as active_count,
           MAX(d.modified_at) as last_modified
    FROM collections c
    LEFT JOIN documents d ON d.collection_id = c.id
    GROUP BY c.id
    ORDER BY c.name
  `)
      .all() as {
      id: number;
      name: string;
      pwd: string;
      glob_pattern: string;
      created_at: string;
      doc_count: number;
      active_count: number;
      last_modified: string | null;
    }[];

    // Overall stats
    const totalDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
    const vectorCount = db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get() as { count: number };

    // Use VectorService to get hashes needing embedding
    const vectorService = new VectorService(db);
    const needsEmbedding = vectorService.getHashesNeedingEmbedding(DEFAULT_EMBED_MODEL);

    // Most recent update across all collections
    const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as {
      latest: string | null;
    };

    // Build status message
    let statusMsg = `${c.bold}QMD Status${c.reset}\n`;
    statusMsg += `Index: ${dbPath}\n`;
    statusMsg += `Size:  ${formatBytes(indexSize)}\n\n`;
    statusMsg += `${c.bold}Documents${c.reset}\n`;
    statusMsg += `  Total:    ${totalDocs.count} files indexed\n`;
    statusMsg += `  Vectors:  ${vectorCount.count} embedded\n`;
    if (needsEmbedding > 0) {
      statusMsg += `  ${c.yellow}⚠${c.reset} Pending:  ${needsEmbedding} need embedding (run 'qmd embed')\n`;
    }
    if (mostRecent.latest) {
      const lastUpdate = new Date(mostRecent.latest);
      statusMsg += `  Updated:  ${formatTimeAgo(lastUpdate)}`;
    }
    logger.info(statusMsg);

    // Get context counts per collection
    const contextCounts = db
      .prepare(`
    SELECT collection_id, COUNT(*) as count
    FROM path_contexts
    GROUP BY collection_id
  `)
      .all() as { collection_id: number; count: number }[];
    const contextCountMap = new Map(contextCounts.map((c) => [c.collection_id, c.count]));

    if (collections.length > 0) {
      let collectionsMsg = `\n${c.bold}Collections${c.reset}\n`;
      for (const col of collections) {
        const lastMod = col.last_modified ? formatTimeAgo(new Date(col.last_modified)) : "never";
        const contextCount = contextCountMap.get(col.id) || 0;

        collectionsMsg += `  ${c.cyan}${col.name}${c.reset} ${c.dim}(qmd://${col.name}/)${c.reset}\n`;
        collectionsMsg += `    ${c.dim}Path:${c.reset}     ${col.pwd}\n`;
        collectionsMsg += `    ${c.dim}Pattern:${c.reset}  ${col.glob_pattern}\n`;
        collectionsMsg += `    ${c.dim}Files:${c.reset}    ${col.active_count} (updated ${lastMod})`;
        if (contextCount > 0) {
          collectionsMsg += `\n    ${c.dim}Contexts:${c.reset} ${contextCount}`;
        }
        collectionsMsg += "\n";
      }

      // Show examples of virtual paths
      collectionsMsg += `\n${c.bold}Examples${c.reset}\n`;
      collectionsMsg += `${c.dim}  # List files in a collection${c.reset}\n`;
      if (collections.length > 0) {
        collectionsMsg += `  qmd ls ${collections[0]!.name}\n`;
      }
      collectionsMsg += `${c.dim}  # Get a document${c.reset}\n`;
      if (collections.length > 0) {
        collectionsMsg += `  qmd get qmd://${collections[0]!.name}/path/to/file.md\n`;
      }
      collectionsMsg += `${c.dim}  # Search within a collection${c.reset}\n`;
      if (collections.length > 0) {
        collectionsMsg += `  qmd search "query" -c ${collections[0]!.name}`;
      }
      logger.info(collectionsMsg);
    } else {
      logger.dim(`\nNo collections. Run 'qmd collection add .' to index markdown files.`);
    }
  });
}

/**
 * Re-index all collections
 */
export async function updateCollections(): Promise<void> {
  await withDbAsync(async (db) => {
    cleanupDuplicateCollections(db);

    // Clear Ollama cache on update
    const cacheRepo = new CacheRepository(db);
    cacheRepo.clear();

    const collections = db.prepare(`SELECT id, pwd, glob_pattern FROM collections`).all() as {
      id: number;
      pwd: string;
      glob_pattern: string;
    }[];

    if (collections.length === 0) {
      logger.dim(`No collections found. Run 'qmd add .' to index markdown files.`);
      return;
    }

    // Update display_paths for any documents missing them (migration)
    const pathsUpdated = updateDisplayPaths(db);
    if (pathsUpdated > 0) {
      logger.success(`Updated ${pathsUpdated} display paths`);
    }

    // Don't close db here - indexFiles will reuse it and close at the end
    logger.info(`${c.bold}Updating ${collections.length} collection(s)...${c.reset}\n`);

    for (const [i, col] of collections.entries()) {
      logger.info(`${c.cyan}[${i + 1}/${collections.length}]${c.reset} ${c.bold}${col.pwd}${c.reset}`);
      logger.dim(`    Pattern: ${col.glob_pattern}`);
      // Temporarily set PWD for indexing
      const originalPwd = process.env.PWD;
      process.env.PWD = col.pwd;
      await indexFiles(col.glob_pattern);
      process.env.PWD = originalPwd;
      logger.info("");
    }

    logger.success(`All collections updated.`);
  });
}

/**
 * Create vector embeddings for documents
 */
export async function vectorIndex(
  getEmbeddingFn: (text: string, model: string, isQuery: boolean, title?: string) => Promise<number[]>,
  model: string = DEFAULT_EMBED_MODEL,
  force: boolean = false,
): Promise<void> {
  await withDbAsync(async (db) => {
    const now = new Date().toISOString();

    // If force, clear all vectors
    if (force) {
      logger.warn(`Force re-indexing: clearing all vectors...`);
      db.run(`DELETE FROM content_vectors`);
      db.run(`DROP TABLE IF EXISTS vectors_vec`);
    }

    // Find unique hashes that need embedding (from active documents)
    // Join with content table to get document body
    const hashesToEmbed = db
      .prepare(`
    SELECT d.hash, c.doc as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
  `)
      .all() as { hash: string; body: string; path: string }[];

    if (hashesToEmbed.length === 0) {
      logger.success(`All content hashes already have embeddings.`);
      return;
    }

    // Prepare documents with chunks
    type ChunkItem = {
      hash: string;
      title: string;
      text: string;
      seq: number;
      pos: number;
      bytes: number;
      displayName: string;
    };
    const allChunks: ChunkItem[] = [];
    let multiChunkDocs = 0;

    for (const item of hashesToEmbed) {
      const encoder = new TextEncoder();
      const bodyBytes = encoder.encode(item.body).length;
      if (bodyBytes === 0) continue; // Skip empty

      const title = extractTitle(item.body, item.path);
      const displayName = item.path;
      const chunks = chunkDocument(item.body, CHUNK_BYTE_SIZE);

      if (chunks.length > 1) multiChunkDocs++;

      for (let seq = 0; seq < chunks.length; seq++) {
        allChunks.push({
          hash: item.hash,
          title,
          text: chunks[seq]!.text,
          seq,
          pos: chunks[seq]!.pos,
          bytes: encoder.encode(chunks[seq]!.text).length,
          displayName,
        });
      }
    }

    if (allChunks.length === 0) {
      logger.success(`No non-empty documents to embed.`);
      return;
    }

    const totalBytes = allChunks.reduce((sum, c) => sum + c.bytes, 0);
    const totalChunks = allChunks.length;
    const totalDocs = hashesToEmbed.length;

    logger.info(
      `${c.bold}Embedding ${totalDocs} documents${c.reset} ${c.dim}(${totalChunks} chunks, ${formatBytes(totalBytes)})${c.reset}`,
    );
    if (multiChunkDocs > 0) {
      logger.dim(`${multiChunkDocs} documents split into multiple chunks`);
    }
    logger.dim(`Model: ${model}\n`);

    // Hide cursor during embedding
    cursor.hide();

    // Get embedding dimensions from first chunk
    progress.indeterminate();
    const firstEmbedding = await getEmbeddingFn(allChunks[0]!.text, model, false, allChunks[0]!.title);
    const vecRepo = new VectorRepository(db);
    vecRepo.ensureVecTable(firstEmbedding.length);

    const insertVecStmt = db.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
    const insertContentVectorStmt = db.prepare(
      `INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`,
    );

    let chunksEmbedded = 0,
      errors = 0,
      bytesProcessed = 0;
    const startTime = Date.now();

    // Insert first chunk
    const firstHashSeq = `${allChunks[0]!.hash}_${allChunks[0]!.seq}`;
    insertVecStmt.run(firstHashSeq, new Float32Array(firstEmbedding));
    insertContentVectorStmt.run(allChunks[0]!.hash, allChunks[0]!.seq, allChunks[0]!.pos, model, now);
    chunksEmbedded++;
    bytesProcessed += allChunks[0]!.bytes;

    for (const chunk of allChunks.slice(1)) {
      try {
        const embedding = await getEmbeddingFn(chunk.text, model, false, chunk.title);
        const hashSeq = `${chunk.hash}_${chunk.seq}`;
        insertVecStmt.run(hashSeq, new Float32Array(embedding));
        insertContentVectorStmt.run(chunk.hash, chunk.seq, chunk.pos, model, now);
        chunksEmbedded++;
        bytesProcessed += chunk.bytes;
      } catch (err) {
        errors++;
        bytesProcessed += chunk.bytes;
        progress.error();
        logger.error(`Error embedding "${chunk.displayName}" chunk ${chunk.seq}: ${err}`);
      }

      const percent = (bytesProcessed / totalBytes) * 100;
      progress.set(percent);

      const elapsed = (Date.now() - startTime) / 1000;
      const bytesPerSec = bytesProcessed / elapsed;
      const remainingBytes = totalBytes - bytesProcessed;
      const etaSec = remainingBytes / bytesPerSec;

      const bar = renderProgressBar(percent);
      const percentStr = percent.toFixed(0).padStart(3);
      const throughput = `${formatBytes(bytesPerSec)}/s`;
      const eta = elapsed > 2 ? formatETA(etaSec) : "...";
      const errStr = errors > 0 ? ` ${c.yellow}${errors} err${c.reset}` : "";

      process.stderr.write(
        `\r${c.cyan}${bar}${c.reset} ${c.bold}${percentStr}%${c.reset} ${c.dim}${chunksEmbedded}/${totalChunks}${c.reset}${errStr} ${c.dim}${throughput} ETA ${eta}${c.reset}   `,
      );
    }

    progress.clear();
    cursor.show();
    const totalTimeSec = (Date.now() - startTime) / 1000;
    const avgThroughput = formatBytes(totalBytes / totalTimeSec);

    logger.info(
      `\r${c.green}${renderProgressBar(100)}${c.reset} ${c.bold}100%${c.reset}                                    `,
    );
    logger.success(
      `Done! Embedded ${c.bold}${chunksEmbedded}${c.reset} chunks from ${c.bold}${totalDocs}${c.reset} documents in ${c.bold}${formatETA(totalTimeSec)}${c.reset} ${c.dim}(${avgThroughput}/s)${c.reset}`,
    );
    if (errors > 0) {
      logger.warn(`${errors} chunks failed`);
    }
  });
}

/**
 * Remove cache and orphaned data, vacuum DB
 */
export function cleanup(): void {
  withDb((db) => {
    // 1. Clear ollama_cache
    const cacheCount = db.prepare(`SELECT COUNT(*) as c FROM ollama_cache`).get() as { c: number };
    db.run(`DELETE FROM ollama_cache`);
    logger.success(`Cleared ${cacheCount.c} cached API responses`);

    // 2. Remove orphaned vectors (no active document with that hash)
    const orphanedVecs = db
      .prepare(`
        SELECT COUNT(*) as c FROM content_vectors cv
        WHERE NOT EXISTS (
          SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
        )
      `)
      .get() as { c: number };

    if (orphanedVecs.c > 0) {
      db.run(`
          DELETE FROM vectors_vec WHERE hash_seq IN (
            SELECT cv.hash || '_' || cv.seq FROM content_vectors cv
            WHERE NOT EXISTS (
              SELECT 1 FROM documents d WHERE d.hash = cv.hash AND d.active = 1
            )
          )
        `);
      db.run(`
          DELETE FROM content_vectors WHERE hash NOT IN (
            SELECT hash FROM documents WHERE active = 1
          )
        `);
      logger.success(`Removed ${orphanedVecs.c} orphaned embedding chunks`);
    } else {
      logger.dim(`No orphaned embeddings to remove`);
    }

    // 3. Count inactive documents
    const inactiveDocs = db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 0`).get() as { c: number };
    if (inactiveDocs.c > 0) {
      db.run(`DELETE FROM documents WHERE active = 0`);
      logger.success(`Removed ${inactiveDocs.c} inactive document records`);
    }

    // 4. Vacuum to reclaim space
    db.run(`VACUUM`);
    logger.success(`Database vacuumed`);
  });
}
