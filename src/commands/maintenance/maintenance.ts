/**
 * Maintenance and administrative commands
 */

import { Database } from "bun:sqlite";
import { withDb, withDbAsync, getDbPath } from "src/database/connection";
import { extractTitle, chunkDocument } from "src/utils/content";
import { VectorService } from "src/core/vectors";
import { indexFiles } from "src/commands/collections";
import { cleanupDuplicateCollections, updateDisplayPaths, computeDisplayPath } from "src/utils/database";
import { formatBytes, formatTimeAgo, formatETA } from "src/utils/time";
import { colors as c, cursor, progress, renderProgressBar } from "src/utils/terminal";
import { CHUNK_BYTE_SIZE } from "src/config";
import { DEFAULT_EMBED_MODEL } from "src/config";

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

    console.log(`${c.bold}QMD Status${c.reset}\n`);
    console.log(`Index: ${dbPath}`);
    console.log(`Size:  ${formatBytes(indexSize)}\n`);

    console.log(`${c.bold}Documents${c.reset}`);
    console.log(`  Total:    ${totalDocs.count} files indexed`);
    console.log(`  Vectors:  ${vectorCount.count} embedded`);
    if (needsEmbedding > 0) {
      console.log(`  ${c.yellow}Pending:  ${needsEmbedding} need embedding${c.reset} (run 'qmd embed')`);
    }
    if (mostRecent.latest) {
      const lastUpdate = new Date(mostRecent.latest);
      console.log(`  Updated:  ${formatTimeAgo(lastUpdate)}`);
    }

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
      console.log(`\n${c.bold}Collections${c.reset}`);
      for (const col of collections) {
        const lastMod = col.last_modified ? formatTimeAgo(new Date(col.last_modified)) : "never";
        const contextCount = contextCountMap.get(col.id) || 0;

        console.log(`  ${c.cyan}${col.name}${c.reset} ${c.dim}(qmd://${col.name}/)${c.reset}`);
        console.log(`    ${c.dim}Path:${c.reset}     ${col.pwd}`);
        console.log(`    ${c.dim}Pattern:${c.reset}  ${col.glob_pattern}`);
        console.log(`    ${c.dim}Files:${c.reset}    ${col.active_count} (updated ${lastMod})`);
        if (contextCount > 0) {
          console.log(`    ${c.dim}Contexts:${c.reset} ${contextCount}`);
        }
      }

      // Show examples of virtual paths
      console.log(`\n${c.bold}Examples${c.reset}`);
      console.log(`  ${c.dim}# List files in a collection${c.reset}`);
      if (collections.length > 0) {
        console.log(`  qmd ls ${collections[0].name}`);
      }
      console.log(`  ${c.dim}# Get a document${c.reset}`);
      if (collections.length > 0) {
        console.log(`  qmd get qmd://${collections[0].name}/path/to/file.md`);
      }
      console.log(`  ${c.dim}# Search within a collection${c.reset}`);
      if (collections.length > 0) {
        console.log(`  qmd search "query" -c ${collections[0].name}`);
      }
    } else {
      console.log(`\n${c.dim}No collections. Run 'qmd collection add .' to index markdown files.${c.reset}`);
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
    clearCache(db);

    const collections = db.prepare(`SELECT id, pwd, glob_pattern FROM collections`).all() as {
      id: number;
      pwd: string;
      glob_pattern: string;
    }[];

    if (collections.length === 0) {
      console.log(`${c.dim}No collections found. Run 'qmd add .' to index markdown files.${c.reset}`);
      return;
    }

    // Update display_paths for any documents missing them (migration)
    const pathsUpdated = updateDisplayPaths(db);
    if (pathsUpdated > 0) {
      console.log(`${c.green}✓${c.reset} Updated ${pathsUpdated} display paths`);
    }

    // Don't close db here - indexFiles will reuse it and close at the end
    console.log(`${c.bold}Updating ${collections.length} collection(s)...${c.reset}\n`);

    for (let i = 0; i < collections.length; i++) {
      const col = collections[i];
      console.log(`${c.cyan}[${i + 1}/${collections.length}]${c.reset} ${c.bold}${col.pwd}${c.reset}`);
      console.log(`${c.dim}    Pattern: ${col.glob_pattern}${c.reset}`);
      // Temporarily set PWD for indexing
      const originalPwd = process.env.PWD;
      process.env.PWD = col.pwd;
      await indexFiles(col.glob_pattern);
      process.env.PWD = originalPwd;
      console.log("");
    }

    console.log(`${c.green}✓ All collections updated.${c.reset}`);
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
      console.log(`${c.yellow}Force re-indexing: clearing all vectors...${c.reset}`);
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
      console.log(`${c.green}✓ All content hashes already have embeddings.${c.reset}`);
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
          text: chunks[seq].text,
          seq,
          pos: chunks[seq].pos,
          bytes: encoder.encode(chunks[seq].text).length,
          displayName,
        });
      }
    }

    if (allChunks.length === 0) {
      console.log(`${c.green}✓ No non-empty documents to embed.${c.reset}`);
      return;
    }

    const totalBytes = allChunks.reduce((sum, c) => sum + c.bytes, 0);
    const totalChunks = allChunks.length;
    const totalDocs = hashesToEmbed.length;

    console.log(
      `${c.bold}Embedding ${totalDocs} documents${c.reset} ${c.dim}(${totalChunks} chunks, ${formatBytes(totalBytes)})${c.reset}`,
    );
    if (multiChunkDocs > 0) {
      console.log(`${c.dim}${multiChunkDocs} documents split into multiple chunks${c.reset}`);
    }
    console.log(`${c.dim}Model: ${model}${c.reset}\n`);

    // Hide cursor during embedding
    cursor.hide();

    // Get embedding dimensions from first chunk
    progress.indeterminate();
    const firstEmbedding = await getEmbeddingFn(allChunks[0].text, model, false, allChunks[0].title);
    ensureVecTable(db, firstEmbedding.length);

    const insertVecStmt = db.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
    const insertContentVectorStmt = db.prepare(
      `INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`,
    );

    let chunksEmbedded = 0,
      errors = 0,
      bytesProcessed = 0;
    const startTime = Date.now();

    // Insert first chunk
    const firstHashSeq = `${allChunks[0].hash}_${allChunks[0].seq}`;
    insertVecStmt.run(firstHashSeq, new Float32Array(firstEmbedding));
    insertContentVectorStmt.run(allChunks[0].hash, allChunks[0].seq, allChunks[0].pos, model, now);
    chunksEmbedded++;
    bytesProcessed += allChunks[0].bytes;

    for (let i = 1; i < allChunks.length; i++) {
      const chunk = allChunks[i];
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
        console.error(`\n${c.yellow}⚠ Error embedding "${chunk.displayName}" chunk ${chunk.seq}: ${err}${c.reset}`);
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

    console.log(
      `\r${c.green}${renderProgressBar(100)}${c.reset} ${c.bold}100%${c.reset}                                    `,
    );
    console.log(
      `\n${c.green}✓ Done!${c.reset} Embedded ${c.bold}${chunksEmbedded}${c.reset} chunks from ${c.bold}${totalDocs}${c.reset} documents in ${c.bold}${formatETA(totalTimeSec)}${c.reset} ${c.dim}(${avgThroughput}/s)${c.reset}`,
    );
    if (errors > 0) {
      console.log(`${c.yellow}⚠ ${errors} chunks failed${c.reset}`);
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
    console.log(`${c.green}✓${c.reset} Cleared ${cacheCount.c} cached API responses`);

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
      console.log(`${c.green}✓${c.reset} Removed ${orphanedVecs.c} orphaned embedding chunks`);
    } else {
      console.log(`${c.dim}No orphaned embeddings to remove${c.reset}`);
    }

    // 3. Count inactive documents
    const inactiveDocs = db.prepare(`SELECT COUNT(*) as c FROM documents WHERE active = 0`).get() as { c: number };
    if (inactiveDocs.c > 0) {
      db.run(`DELETE FROM documents WHERE active = 0`);
      console.log(`${c.green}✓${c.reset} Removed ${inactiveDocs.c} inactive document records`);
    }

    // 4. Vacuum to reclaim space
    db.run(`VACUUM`);
    console.log(`${c.green}✓${c.reset} Database vacuumed`);
  });
}
