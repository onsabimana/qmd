/**
 * Document retrieval commands
 */

import { withDb } from "src/database/connection";
import { isVirtualPath, parseVirtualPath, buildVirtualPath } from "src/utils/virtual-path";
import { DEFAULT_MULTI_GET_MAX_BYTES } from "src/config";
import { DocumentService } from "src/core/documents";
import { CollectionManager } from "src/core/collections";
import type { OutputFormat } from "src/commands/search/types";
import { escapeXml } from "src/utils/formatter";
import { colors as c } from "src/utils/terminal";

/**
 * Get a single document with optional line filtering
 */
export function getDocument(filename: string, fromLine?: number, maxLines?: number): void {
  withDb((db) => {
    const service = new DocumentService(db);

    // Parse :linenum suffix from filename (e.g., "file.md:100")
    let inputPath = filename;
    const colonMatch = inputPath.match(/:(\d+)$/);
    if (colonMatch && !fromLine) {
      fromLine = parseInt(colonMatch[1], 10);
      inputPath = inputPath.slice(0, -colonMatch[0].length);
    }

    const result = service.findDocument(inputPath, { includeBody: true });

    if ("error" in result) {
      console.error(`Document not found: ${filename}`);
      if (result.similarFiles.length > 0) {
        console.error(`\nDid you mean one of these?`);
        result.similarFiles.forEach((f) => console.error(`  ${f}`));
      }
      process.exit(1);
    }

    let output = result.body || "";

    // Apply line filtering if specified
    if (fromLine !== undefined || maxLines !== undefined) {
      const lines = output.split("\n");
      const start = (fromLine || 1) - 1; // Convert to 0-indexed
      const end = maxLines !== undefined ? start + maxLines : lines.length;
      output = lines.slice(start, end).join("\n");
    }

    // Output context header if exists
    if (result.context) {
      console.log(`Folder Context: ${result.context}\n---\n`);
    }
    console.log(output);
  });
}

/**
 * Multi-get: fetch multiple documents by glob pattern or comma-separated list
 */
export function multiGet(
  pattern: string,
  maxLines?: number,
  maxBytes: number = DEFAULT_MULTI_GET_MAX_BYTES,
  format: OutputFormat = "cli",
): void {
  const results = withDb((db) => {
    const service = new DocumentService(db);

    const { docs, errors } = service.findDocuments(pattern, {
      includeBody: true,
      maxBytes,
    });

    // Report any errors
    for (const error of errors) {
      console.error(error);
    }

    if (docs.length === 0) {
      console.error(`No files matched pattern: ${pattern}`);
      process.exit(1);
    }

    // Apply maxBytes limit and prepare results
    const results: {
      file: string;
      displayPath: string;
      title: string;
      body: string;
      context: string | null;
      skipped: boolean;
      skipReason?: string;
    }[] = [];

    for (const doc of docs) {
      const bodyLength = doc.body.length;

      if (bodyLength > maxBytes) {
        results.push({
          file: doc.file,
          displayPath: doc.file,
          title: doc.title,
          body: "",
          context: doc.context,
          skipped: true,
          skipReason: `File too large (${Math.round(bodyLength / 1024)}KB > ${Math.round(maxBytes / 1024)}KB). Use 'qmd get ${doc.file}' to retrieve.`,
        });
        continue;
      }

      let body = doc.body;

      // Apply line limit if specified
      if (maxLines !== undefined) {
        const lines = body.split("\n");
        body = lines.slice(0, maxLines).join("\n");
        if (lines.length > maxLines) {
          body += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
        }
      }

      results.push({
        file: doc.file,
        displayPath: doc.file,
        title: doc.title,
        body,
        context: doc.context,
        skipped: false,
      });
    }

    return results;
  });

  // Output based on format
  if (format === "json") {
    const output = results.map((r) => ({
      file: r.displayPath,
      title: r.title,
      ...(r.context && { context: r.context }),
      ...(r.skipped ? { skipped: true, reason: r.skipReason } : { body: r.body }),
    }));
    console.log(JSON.stringify(output, null, 2));
  } else if (format === "csv") {
    const escapeField = (val: string | null): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    console.log("file,title,context,skipped,body");
    for (const r of results) {
      console.log(
        [r.displayPath, r.title, r.context || "", r.skipped ? "true" : "false", r.skipped ? r.skipReason : r.body]
          .map(escapeField)
          .join(","),
      );
    }
  } else if (format === "files") {
    for (const r of results) {
      const ctx = r.context ? `,"${r.context.replace(/"/g, '""')}"` : "";
      const status = r.skipped ? "[SKIPPED]" : "";
      console.log(`${r.displayPath}${ctx}${status ? `,${status}` : ""}`);
    }
  } else if (format === "md") {
    for (const r of results) {
      console.log(`## ${r.displayPath}\n`);
      if (r.title && r.title !== r.displayPath) console.log(`**Title:** ${r.title}\n`);
      if (r.context) console.log(`**Context:** ${r.context}\n`);
      if (r.skipped) {
        console.log(`> ${r.skipReason}\n`);
      } else {
        console.log("```");
        console.log(r.body);
        console.log("```\n");
      }
    }
  } else if (format === "xml") {
    console.log('<?xml version="1.0" encoding="UTF-8"?>');
    console.log("<documents>");
    for (const r of results) {
      console.log("  <document>");
      console.log(`    <file>${escapeXml(r.displayPath)}</file>`);
      console.log(`    <title>${escapeXml(r.title)}</title>`);
      if (r.context) console.log(`    <context>${escapeXml(r.context)}</context>`);
      if (r.skipped) {
        console.log(`    <skipped>true</skipped>`);
        console.log(`    <reason>${escapeXml(r.skipReason || "")}</reason>`);
      } else {
        console.log(`    <body>${escapeXml(r.body)}</body>`);
      }
      console.log("  </document>");
    }
    console.log("</documents>");
  } else {
    // CLI format (default)
    for (const r of results) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`File: ${r.displayPath}`);
      console.log(`${"=".repeat(60)}\n`);

      if (r.skipped) {
        console.log(`[SKIPPED: ${r.skipReason}]`);
        continue;
      }

      if (r.context) {
        console.log(`Folder Context: ${r.context}\n---\n`);
      }
      console.log(r.body);
    }
  }
}

/**
 * List files in virtual file tree
 */
export function listFiles(pathArg?: string): void {
  withDb((db) => {
    const collectionManager = new CollectionManager(db);
    const service = new DocumentService(db);

    if (!pathArg) {
      // No argument - list all collections
      const collections = collectionManager.listWithStats();

      if (collections.length === 0) {
        console.log("No collections found. Run 'qmd add .' to index files.");
        return;
      }

      console.log(`${c.bold}Collections:${c.reset}\n`);
      for (const coll of collections) {
        console.log(`${c.cyan}qmd://${coll.name}/${c.reset} (${coll.document_count} files)`);
      }
      return;
    }

    // Parse the path argument
    let collectionName: string;
    let pathPrefix: string | null = null;

    if (pathArg.startsWith("qmd://")) {
      // Virtual path format: qmd://collection/path
      const parsed = parseVirtualPath(pathArg);
      if (!parsed) {
        console.error(`Invalid virtual path: ${pathArg}`);
        process.exit(1);
      }
      collectionName = parsed.collectionName;
      pathPrefix = parsed.path;
    } else {
      // Just collection name or collection/path
      const parts = pathArg.split("/");
      collectionName = parts[0];
      if (parts.length > 1) {
        pathPrefix = parts.slice(1).join("/");
      }
    }

    // Get the collection
    const coll = collectionManager.getByName(collectionName);
    if (!coll) {
      console.error(`Collection not found: ${collectionName}`);
      console.error(`Run 'qmd ls' to see available collections.`);
      process.exit(1);
    }

    // List files in the collection
    const allDocs = service.listByCollection(collectionName);

    // Filter by path prefix if provided
    const docs = pathPrefix
      ? allDocs.filter((doc) => {
          const parsed = parseVirtualPath(doc.displayPath);
          return parsed && parsed.path.startsWith(pathPrefix);
        })
      : allDocs;

    if (docs.length === 0) {
      if (pathPrefix) {
        console.log(`No files found under qmd://${collectionName}/${pathPrefix}`);
      } else {
        console.log(`No files found in collection: ${collectionName}`);
      }
      return;
    } // Output virtual paths
    for (const doc of docs) {
      console.log(doc.displayPath);
    }
  });
}
