/**
 * Context management commands
 */

import { withDbAsync, withDb } from "src/database/connection";
import { getPwd, homedir, resolve } from "src/utils/path";
import { isVirtualPath, parseVirtualPath } from "src/utils/virtual-path";
import { ContextService } from "src/core/context";
import { CollectionManager } from "src/core/collections";
import { detectCollectionFromPath } from "src/utils/database";
import { colors as c } from "src/utils/terminal";

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
        console.log(`${c.green}✓${c.reset} Added global context to ${collections.length} collection(s)`);
        console.log(`${c.dim}Context: ${contextText}${c.reset}`);
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
          console.error(`${c.yellow}Invalid virtual path: ${fsPath}${c.reset}`);
          process.exit(1);
        }

        contextService.setContext(parsed.collectionName, parsed.path, contextText);
        console.log(`${c.green}✓${c.reset} Added context for: qmd://${parsed.collectionName}/${parsed.path || ""}`);
        console.log(`${c.dim}Context: ${contextText}${c.reset}`);
        return;
      }

      // Detect collection from filesystem path
      const detected = detectCollectionFromPath(db, fsPath);
      if (!detected) {
        console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
        console.error(`${c.dim}Run 'qmd status' to see indexed collections${c.reset}`);
        process.exit(1);
      }

      contextService.setContext(detected.collectionName, detected.relativePath, contextText);

      const displayPath = detected.relativePath
        ? `qmd://${detected.collectionName}/${detected.relativePath}`
        : `qmd://${detected.collectionName}/`;
      console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
      console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`${c.red}Error:${c.reset} ${error.message}`);
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
      console.log(`${c.dim}No contexts configured. Use 'qmd context add' to add one.${c.reset}`);
      return;
    }

    console.log(`\n${c.bold}Configured Contexts${c.reset}\n`);

    let lastCollection = "";
    for (const ctx of contexts) {
      if (ctx.collectionName !== lastCollection) {
        console.log(`${c.cyan}${ctx.collectionName}${c.reset}`);
        lastCollection = ctx.collectionName;
      }

      const path = ctx.path || "/";
      const displayPath = ctx.path ? `  ${path}` : "  / (root)";
      console.log(`${displayPath}`);
      console.log(`    ${c.dim}${ctx.context}${c.reset}`);
    }
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
        console.log(`${c.green}✓${c.reset} Removed ${removed} global context(s)`);
        return;
      }

      // Handle virtual paths
      if (isVirtualPath(pathArg)) {
        const parsed = parseVirtualPath(pathArg);
        if (!parsed) {
          console.error(`${c.yellow}Invalid virtual path: ${pathArg}${c.reset}`);
          process.exit(1);
        }

        contextService.deleteContext(parsed.collectionName, parsed.path);
        console.log(`${c.green}✓${c.reset} Removed context for: ${pathArg}`);
        return;
      }

      // Detect from filesystem path
      const detected = detectCollectionFromPath(db, pathArg);
      if (!detected) {
        console.error(`${c.yellow}Path is not in any indexed collection: ${pathArg}${c.reset}`);
        process.exit(1);
      }

      contextService.deleteContext(detected.collectionName, detected.relativePath);

      const displayPath = detected.relativePath
        ? `qmd://${detected.collectionName}/${detected.relativePath}`
        : `qmd://${detected.collectionName}/`;
      console.log(`${c.green}✓${c.reset} Removed context for: ${displayPath}`);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("not found")) {
          console.error(`${c.yellow}${error.message}${c.reset}`);
        } else {
          console.error(`${c.red}Error:${c.reset} ${error.message}`);
        }
      }
      process.exit(1);
    }
  });
}
