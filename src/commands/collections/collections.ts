/**
 * Collection management commands for QMD
 */

import { withDb, withDbAsync } from "src/database/connection";
import { DEFAULT_GLOB } from "src/config";
import { CollectionManager } from "src/core/collections";
import { colors, progress } from "src/utils/terminal";
import { formatETA, formatTimeAgo } from "src/utils/time";

// Short alias for colors
const c = colors;

export function collectionList(): void {
  withDb((db) => {
    const manager = new CollectionManager(db);
    const collections = manager.listWithStats();

    if (collections.length === 0) {
      console.log("No collections found. Run 'qmd add .' to create one.");
      return;
    }

    console.log(`${c.bold}Collections (${collections.length}):${c.reset}\n`);

    for (const coll of collections) {
      const updatedAt = new Date(coll.updated_at);
      const timeAgo = formatTimeAgo(updatedAt);

      console.log(`${c.cyan}${coll.name}${c.reset}`);
      console.log(`  ${c.dim}Path:${c.reset}     ${coll.pwd}`);
      console.log(`  ${c.dim}Pattern:${c.reset}  ${coll.glob_pattern}`);
      console.log(`  ${c.dim}Files:${c.reset}    ${coll.document_count}`);
      console.log(`  ${c.dim}Updated:${c.reset}  ${timeAgo}`);
      console.log();
    }
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
    console.log(`Creating collection '${collection.name}'...`);
    await indexFiles(pwd, globPattern, collection.name);
    console.log(`${c.green}✓${c.reset} Collection '${collection.name}' created successfully`);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("already exists")) {
        console.error(`${c.yellow}${error.message}${c.reset}`);
        if (error.message.includes("name")) {
          console.error(`Use a different name with --name <name>`);
        } else {
          console.error(`\nUse 'qmd add ${globPattern}' to update it, or remove it first.`);
        }
      } else {
        console.error(`${c.red}Error:${c.reset} ${error.message}`);
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

      console.log(`${c.green}✓${c.reset} Removed collection '${name}'`);
      console.log(`  Deleted ${result.deletedDocs} documents`);
      if (result.cleanedHashes > 0) {
        console.log(`  Cleaned up ${result.cleanedHashes} orphaned content hashes`);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`${c.yellow}${error.message}${c.reset}`);
        console.error(`Run 'qmd collection list' to see available collections.`);
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

      console.log(`${c.green}✓${c.reset} Renamed collection '${oldName}' to '${newName}'`);
      console.log(
        `  Virtual paths updated: ${c.cyan}qmd://${oldName}/${c.reset} → ${c.cyan}qmd://${newName}/${c.reset}`,
      );
    } catch (error) {
      if (error instanceof Error) {
        console.error(`${c.yellow}${error.message}${c.reset}`);
        if (error.message.includes("not found")) {
          console.error(`Run 'qmd collection list' to see available collections.`);
        } else if (error.message.includes("already exists")) {
          console.error(`Choose a different name or remove the existing collection first.`);
        }
      }
      process.exit(1);
    }
  });
}

export async function indexFiles(pwd: string, globPattern: string = DEFAULT_GLOB, name?: string): Promise<void> {
  await withDbAsync(async (db) => {
    const manager = new CollectionManager(db);

    // Clear Ollama cache on index
    clearCache(db);

    console.log(`Collection: ${pwd} (${globPattern})`);

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
        console.log("No files found matching pattern.");
        return;
      }

      console.log(
        `\nIndexed: ${result.indexed} new, ${result.updated} updated, ${result.unchanged} unchanged, ${result.removed} removed`,
      );
      if (result.orphanedContent > 0) {
        console.log(`Cleaned up ${result.orphanedContent} orphaned content hash(es)`);
      }

      // Check if vector index needs updating
      const needsEmbedding = getHashesNeedingEmbedding(db);
      if (needsEmbedding > 0) {
        console.log(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
      }
    } catch (error) {
      progress.clear();
      if (error instanceof Error) {
        console.error(`${c.red}Error:${c.reset} ${error.message}`);
      }
      process.exit(1);
    }
  });
}
