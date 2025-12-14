/**
 * Context management commands
 */

import { CollectionManager } from "src/core/collections";
import { ContextService } from "src/core/context";
import { withDb, withDbAsync } from "src/database/connection";
import { detectCollectionFromPath } from "src/utils/database";
import { logger } from "src/utils/logger";
import { getPwd, homedir, resolve } from "src/utils/path";
import { colors as c } from "src/utils/terminal";
import { isVirtualPath, parseVirtualPath } from "src/utils/virtual-path";

/**
 * Add context for a path
 */
export async function contextAdd(pathArg: string | undefined, contextText: string): Promise<void> {
  await withDbAsync(async (db) => {
    const contextService = new ContextService(db);
    const collectionManager = new CollectionManager(db);

    try {
      // Handle "/" as global/root context (applies to all collections)
      if (pathArg === "/") {
        const collections = collectionManager.listWithStats();
        for (const coll of collections) {
          contextService.setContext(coll.name, "", contextText);
        }
        logger.success(`Added global context to ${collections.length} collection(s)`);
        logger.dim(`Context: ${contextText}`);
        return;
      }

      // Resolve path - defaults to current directory if not provided
      let fsPath = pathArg || ".";
      if (fsPath === "." || fsPath === "./") {
        fsPath = getPwd();
      } else if (fsPath.startsWith("~/")) {
        fsPath = homedir() + fsPath.slice(1);
      } else if (!fsPath.startsWith("/") && !fsPath.startsWith("qmd://")) {
        fsPath = resolve(getPwd(), fsPath);
      }

      // Handle virtual paths (qmd://collection/path)
      if (isVirtualPath(fsPath)) {
        const parsed = parseVirtualPath(fsPath);
        if (!parsed) {
          logger.error(`Invalid virtual path: ${fsPath}`);
          process.exit(1);
        }

        contextService.setContext(parsed.collectionName, parsed.path, contextText);
        logger.success(`Added context for: qmd://${parsed.collectionName}/${parsed.path || ""}`);
        logger.dim(`Context: ${contextText}`);
        return;
      }

      // Detect collection from filesystem path
      const detected = detectCollectionFromPath(db, fsPath);
      if (!detected) {
        logger.error(`Path is not in any indexed collection: ${fsPath}`);
        logger.info(`Run 'qmd status' to see indexed collections`);
        process.exit(1);
      }

      contextService.setContext(detected.collectionName, detected.relativePath, contextText);

      const displayPath = detected.relativePath
        ? `qmd://${detected.collectionName}/${detected.relativePath}`
        : `qmd://${detected.collectionName}/`;
      logger.success(`Added context for: ${displayPath}`);
      logger.dim(`Context: ${contextText}`);
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      }
      process.exit(1);
    }
  });
}

/**
 * List all configured contexts
 */
export function contextList(): void {
  withDb((db) => {
    const contextService = new ContextService(db);

    const contexts = contextService.listAllContexts();

    if (contexts.length === 0) {
      logger.dim(`No contexts configured. Use 'qmd context add' to add one.`);
      return;
    }

    let output = `\n${c.bold}Configured Contexts${c.reset}\n\n`;

    let lastCollection = "";
    for (const ctx of contexts) {
      if (ctx.collectionName !== lastCollection) {
        output += `${c.cyan}${ctx.collectionName}${c.reset}\n`;
        lastCollection = ctx.collectionName;
      }

      const path = ctx.path || "/";
      const displayPath = ctx.path ? `  ${path}` : "  / (root)";
      output += `${displayPath}\n`;
      output += `    ${c.dim}${ctx.context}${c.reset}\n`;
    }
    logger.info(output);
  });
}

/**
 * Remove context for a path
 */
export function contextRemove(pathArg: string): void {
  withDb((db) => {
    const contextService = new ContextService(db);
    const collectionManager = new CollectionManager(db);

    try {
      if (pathArg === "/") {
        // Remove all root contexts
        const collections = collectionManager.listWithStats();
        let removed = 0;
        for (const coll of collections) {
          try {
            contextService.deleteContext(coll.name, "");
            removed++;
          } catch (e) {
            // Context might not exist for this collection
          }
        }
        logger.success(`Removed ${removed} global context(s)`);
        return;
      }

      // Handle virtual paths
      if (isVirtualPath(pathArg)) {
        const parsed = parseVirtualPath(pathArg);
        if (!parsed) {
          logger.error(`Invalid virtual path: ${pathArg}`);
          process.exit(1);
        }

        contextService.deleteContext(parsed.collectionName, parsed.path);
        logger.success(`Removed context for: ${pathArg}`);
        return;
      }

      // Detect from filesystem path
      const detected = detectCollectionFromPath(db, pathArg);
      if (!detected) {
        logger.error(`Path is not in any indexed collection: ${pathArg}`);
        process.exit(1);
      }

      contextService.deleteContext(detected.collectionName, detected.relativePath);

      const displayPath = detected.relativePath
        ? `qmd://${detected.collectionName}/${detected.relativePath}`
        : `qmd://${detected.collectionName}/`;
      logger.success(`Removed context for: ${displayPath}`);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("not found")) {
          logger.warn(error.message);
        } else {
          logger.error(error.message);
        }
      }
      process.exit(1);
    }
  });
}
