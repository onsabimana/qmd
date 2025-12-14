#!/usr/bin/env bun
import { Command } from "commander";
import { collectionAdd, collectionList, collectionRemove, collectionRename } from "src/commands/collections";
import { contextAdd, contextList, contextRemove } from "src/commands/context";
import { getDocument, listFiles, multiGet } from "src/commands/documents";
import {
  cleanup as maintenanceCleanup,
  showStatus as maintenanceShowStatus,
  updateCollections as maintenanceUpdateCollections,
  vectorIndex as maintenanceVectorIndex,
} from "src/commands/maintenance";
import { getEmbedding, querySearch, search, vectorSearch } from "src/commands/search";
import type { OutputOptions } from "src/commands/search/types";
import { DEFAULT_EMBED_MODEL, DEFAULT_GLOB, DEFAULT_MULTI_GET_MAX_BYTES } from "src/config";
import { setCustomIndexName } from "src/database/connection";
import type { OutputFormat } from "src/utils/formatter";
import { getPwd, getRealPath, resolve } from "src/utils/path";
import { colors as c, cursor, progress } from "src/utils/terminal";

// Ensure cursor is restored on exit
process.on("SIGINT", () => {
  cursor.show();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cursor.show();
  process.exit(143);
});

// Helper function to build OutputOptions from Commander options
function buildOutputOptions(options: any): OutputOptions {
  let format: OutputFormat = "cli";
  if (options.csv) format = "csv";
  else if (options.md) format = "md";
  else if (options.xml) format = "xml";
  else if (options.files) format = "files";
  else if (options.json) format = "json";

  // Default limit: 20 for --files/--json, 5 otherwise
  const defaultLimit = format === "files" || format === "json" ? 20 : 5;
  const isAll = options.all || false;

  return {
    format,
    full: options.full || false,
    limit: isAll ? 100000 : options.n ? parseInt(options.n, 10) || defaultLimit : defaultLimit,
    minScore: options.minScore ? parseFloat(options.minScore) || 0 : 0,
    all: isAll,
    collection: options.collection,
  };
}

// Main CLI - only run if this is the main module
async function main() {
  const program = new Command();

  program
    .name("qmd")
    .description("Quick Markdown Search - Full-text and vector search for markdown files")
    .version("1.0.0")
    .option("--index <name>", "Use custom index name (default: index)")
    .hook("preAction", (thisCommand) => {
      const opts = thisCommand.optsWithGlobals();
      if (opts.index) {
        setCustomIndexName(opts.index);
      }
    });

  // Collection commands
  const collection = program.command("collection").description("Manage document collections");

  collection
    .command("add [path]")
    .description("Create or update a collection")
    .option("--name <name>", "Collection name")
    .option("--mask <pattern>", `Glob pattern (default: ${DEFAULT_GLOB})`)
    .action(async (path, options) => {
      const pwd = path || getPwd();
      const resolvedPwd = pwd === "." ? getPwd() : getRealPath(resolve(pwd));
      const globPattern = options.mask || DEFAULT_GLOB;
      await collectionAdd(resolvedPwd, globPattern, options.name);
    });

  collection
    .command("list")
    .description("List all collections with details")
    .action(() => {
      collectionList();
    });

  collection
    .command("remove <name>")
    .alias("rm")
    .description("Remove a collection by name")
    .action((name) => {
      collectionRemove(name);
    });

  collection
    .command("rename <oldName> <newName>")
    .alias("mv")
    .description("Rename a collection")
    .action((oldName, newName) => {
      collectionRename(oldName, newName);
    });

  // Context commands
  const context = program.command("context").description("Manage search context for paths");

  context
    .command("add [path] <text...>")
    .description("Add context for a path (defaults to current dir)")
    .action(async (path, textArgs) => {
      let pathArg: string | undefined;
      let contextText: string;

      // If path looks like it might be context text, treat it as such
      if (
        textArgs.length === 0 &&
        path &&
        !path.startsWith("/") &&
        !path.startsWith(".") &&
        path !== "/" &&
        !path.startsWith("qmd://")
      ) {
        pathArg = undefined;
        contextText = path;
      } else {
        pathArg = path;
        contextText = textArgs.join(" ");
      }

      await contextAdd(pathArg, contextText);
    });

  context
    .command("list")
    .description("List all contexts")
    .action(() => {
      contextList();
    });

  context
    .command("rm <path>")
    .alias("remove")
    .description("Remove context for a path")
    .action((path) => {
      contextRemove(path);
    });

  // Legacy command for backwards compatibility
  program
    .command("add-context [path] <text...>")
    .description("(deprecated) Add context - use 'qmd context add' instead")
    .action(async (path, textArgs) => {
      console.error(`${c.yellow}Note: 'qmd add-context' is deprecated. Use 'qmd context add' instead.${c.reset}`);
      let pathArg: string | undefined;
      let contextText: string;

      if (textArgs.length === 0) {
        pathArg = undefined;
        contextText = path;
      } else {
        pathArg = path;
        contextText = textArgs.join(" ");
      }

      await contextAdd(pathArg, contextText);
    });

  // Document retrieval commands
  program
    .command("get <file>")
    .description("Get a document (optionally from specific line)")
    .option("--from <line>", "Start from line number")
    .option("-l <lines>", "Maximum number of lines to return")
    .action((file, options) => {
      const fromLine = options.from ? parseInt(options.from, 10) : undefined;
      const maxLines = options.l ? parseInt(options.l, 10) : undefined;
      getDocument(file, fromLine, maxLines);
    });

  program
    .command("multi-get <pattern>")
    .description("Get multiple documents by glob pattern or comma-separated list")
    .option("-l <lines>", "Maximum lines per file")
    .option("--max-bytes <bytes>", `Skip files larger than N bytes (default: ${DEFAULT_MULTI_GET_MAX_BYTES})`)
    .option("--json", "Output as JSON")
    .option("--csv", "Output as CSV")
    .option("--md", "Output as Markdown")
    .option("--xml", "Output as XML")
    .option("--files", "Output as score,filepath,context format")
    .action((pattern, options) => {
      const maxLines = options.l ? parseInt(options.l, 10) : undefined;
      const maxBytes = options.maxBytes ? parseInt(options.maxBytes, 10) : DEFAULT_MULTI_GET_MAX_BYTES;

      let format: OutputFormat = "cli";
      if (options.csv) format = "csv";
      else if (options.md) format = "md";
      else if (options.xml) format = "xml";
      else if (options.files) format = "files";
      else if (options.json) format = "json";

      multiGet(pattern, maxLines, maxBytes, format);
    });

  program
    .command("ls [path]")
    .description("List collections or files in a collection")
    .action((path) => {
      listFiles(path);
    });

  // Search commands
  function addSearchOptions(cmd: Command) {
    return cmd
      .option("-n <num>", "Number of results")
      .option("--all", "Return all matches (use with --min-score)")
      .option("--min-score <num>", "Minimum similarity score")
      .option("--full", "Output full document instead of snippet")
      .option("--files", "Output as score,filepath,context format")
      .option("--json", "Output as JSON")
      .option("--csv", "Output as CSV")
      .option("--md", "Output as Markdown")
      .option("--xml", "Output as XML")
      .option("-c, --collection <name>", "Filter to specific collection");
  }

  addSearchOptions(program.command("search <query...>").description("Full-text search using BM25")).action(
    (queryArgs, options) => {
      const query = queryArgs.join(" ");
      const opts = buildOutputOptions(options);
      search(query, opts);
    },
  );

  addSearchOptions(program.command("vsearch <query...>").description("Vector similarity search")).action(
    async (queryArgs, options) => {
      const query = queryArgs.join(" ");
      const opts = buildOutputOptions(options);
      // Default min-score for vector search is 0.3
      if (!options.minScore) {
        opts.minScore = 0.3;
      }
      await vectorSearch(query, opts);
    },
  );

  addSearchOptions(
    program.command("query <query...>").description("Combined search with query expansion and reranking"),
  ).action(async (queryArgs, options) => {
    const query = queryArgs.join(" ");
    const opts = buildOutputOptions(options);
    await querySearch(query, opts);
  });

  // Maintenance commands
  program
    .command("status")
    .description("Show index status and collections")
    .action(() => {
      maintenanceShowStatus();
    });

  program
    .command("update")
    .description("Re-index all collections")
    .action(async () => {
      await maintenanceUpdateCollections();
    });

  program
    .command("embed")
    .description("Create vector embeddings (chunks ~6KB each)")
    .option("-f, --force", "Force re-embedding of all documents")
    .action(async (options) => {
      await maintenanceVectorIndex(getEmbedding, DEFAULT_EMBED_MODEL, options.force || false);
    });

  program
    .command("cleanup")
    .description("Remove cache and orphaned data, vacuum DB")
    .action(() => {
      maintenanceCleanup();
    });

  // MCP server command
  program
    .command("mcp")
    .description("Start MCP server for AI agent integration")
    .action(async () => {
      const { startMcpServer } = await import("src/core/mcp");
      await startMcpServer();
    });

  // Parse and execute
  program.parse();
}

// Run main if this is the main module
main().catch((err) => {
  cursor.show();
  console.error(`${c.magenta}Error: ${err.message}${c.reset}`);
  process.exit(1);
});
