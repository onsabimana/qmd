/**
 * Collection management commands for QMD
 */

import { DEFAULT_EMBED_MODEL, DEFAULT_GLOB } from "src/config";
import { CollectionManager } from "src/core/collections";
import { VectorService } from "src/core/vectors";
import { CacheRepository } from "src/database/cache";
import { withDb, withDbAsync } from "src/database/connection";
import { logger } from "src/utils/logger";
import { colors, progress } from "src/utils/terminal";
import { formatETA, formatTimeAgo } from "src/utils/time";

// Short alias for colors (still used for inline formatting)
const c = colors;

export function collectionList(): void {
  withDb((db) => {
    const manager = new CollectionManager(db);
    const collections = manager.listWithStats();

    if (collections.length === 0) {
      logger.info("No collections found. Run 'qmd add .' to create one.");
      return;
    }

    let output = `${c.bold}Collections (${collections.length}):${c.reset}\n\n`;

    for (const coll of collections) {
      const updatedAt = new Date(coll.updated_at);
      const timeAgo = formatTimeAgo(updatedAt);

      output += `${c.cyan}${coll.name}${c.reset}\n`;
      output += `  ${c.dim}Path:${c.reset}     ${coll.pwd}\n`;
      output += `  ${c.dim}Pattern:${c.reset}  ${coll.glob_pattern}\n`;
      output += `  ${c.dim}Files:${c.reset}    ${coll.document_count}\n`;
      output += `  ${c.dim}Updated:${c.reset}  ${timeAgo}\n\n`;
    }
    logger.data(output);
  });
}

export async function collectionAdd(pwd: string, globPattern: string, name?: string): Promise<void> {
  const collection = await withDbAsync(async (db) => {
    const manager = new CollectionManager(db);
    // This will validate and create the collection
    return manager.create(pwd, globPattern, name);
  });

  try {
    // Now index the files
    logger.info(`Creating collection '${collection.name}'...`);
    await indexFiles(pwd, globPattern, collection.name);
    logger.success(`Collection '${collection.name}' created successfully`);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("already exists")) {
        let msg = error.message;
        if (error.message.includes("name")) {
          msg += "\nUse a different name with --name <name>";
        } else {
          msg += `\n\nUse 'qmd add ${globPattern}' to update it, or remove it first.`;
        }
        logger.warn(msg);
      } else {
        logger.error(error.message);
      }
    }
    process.exit(1);
  }
}

export function collectionRemove(name: string): void {
  withDb((db) => {
    const manager = new CollectionManager(db);

    try {
      const result = manager.remove(name);

      let msg = `Removed collection '${name}'\n  Deleted ${result.deletedDocs} documents`;
      if (result.cleanedHashes > 0) {
        msg += `\n  Cleaned up ${result.cleanedHashes} orphaned content hashes`;
      }
      logger.success(msg);
    } catch (error) {
      if (error instanceof Error) {
        logger.warn(`${error.message}\nRun 'qmd collection list' to see available collections.`);
      }
      process.exit(1);
    }
  });
}

export function collectionRename(oldName: string, newName: string): void {
  withDb((db) => {
    const manager = new CollectionManager(db);

    try {
      manager.rename(oldName, newName);

      logger.success(`Renamed collection '${oldName}' to '${newName}'`);
      logger.info(
        `  Virtual paths updated: ${c.cyan}qmd://${oldName}/${c.reset} → ${c.cyan}qmd://${newName}/${c.reset}`,
      );
    } catch (error) {
      if (error instanceof Error) {
        let msg = error.message;
        if (error.message.includes("not found")) {
          msg += "\nRun 'qmd collection list' to see available collections.";
        } else if (error.message.includes("already exists")) {
          msg += "\nChoose a different name or remove the existing collection first.";
        }
        logger.warn(msg);
      }
      process.exit(1);
    }
  });
}

export async function indexFiles(pwd: string, globPattern: string = DEFAULT_GLOB, name?: string): Promise<void> {
  await withDbAsync(async (db) => {
    const manager = new CollectionManager(db);

    // Clear Ollama cache on index
    const cacheRepo = new CacheRepository(db);
    cacheRepo.clear();

    logger.info(`Collection: ${pwd} (${globPattern})`);

    progress.indeterminate();

    let processed = 0;
    let total = 0;
    const startTime = Date.now();

    try {
      const result = await manager.indexFiles(pwd, globPattern, {
        name,
        onProgress: (current, totalFiles, path) => {
          processed = current;
          total = totalFiles;

          progress.set((processed / total) * 100);
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = processed / elapsed;
          const remaining = (total - processed) / rate;
          const eta = processed > 2 ? ` ETA: ${formatETA(remaining)}` : "";
          process.stderr.write(`\rIndexing: ${processed}/${total}${eta}        `);
        },
      });

      progress.clear();

      if (total === 0) {
        logger.info("No files found matching pattern.");
        return;
      }

      let resultMsg = `\nIndexed: ${result.indexed} new, ${result.updated} updated, ${result.removed} removed, ${result.skipped} skipped`;
      if (result.orphanedContent > 0) {
        resultMsg += `\nCleaned up ${result.orphanedContent} orphaned content hash(es)`;
      }
      logger.info(resultMsg);

      // Check if vector index needs updating
      const vectorService = new VectorService(db);
      const needsEmbedding = vectorService.getHashesNeedingEmbedding(DEFAULT_EMBED_MODEL);
      if (needsEmbedding > 0) {
        logger.info(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
      }
    } catch (error) {
      progress.clear();
      if (error instanceof Error) {
        logger.error(error.message);
      }
      process.exit(1);
    }
  });
}
