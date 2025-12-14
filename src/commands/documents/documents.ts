/**
 * Document retrieval commands
 */

import type { OutputFormat } from "src/commands/search/types";
import { DEFAULT_MULTI_GET_MAX_BYTES } from "src/config";
import { CollectionManager } from "src/core/collections";
import { DocumentService } from "src/core/documents";
import { withDb } from "src/database/connection";
import { escapeXml } from "src/utils/formatter";
import { logger } from "src/utils/logger";
import { colors as c } from "src/utils/terminal";
import { parseVirtualPath } from "src/utils/virtual-path";

/**
 * Get a single document with optional line filtering
 */
export function getDocument(filename: string, fromLine?: number, maxLines?: number): void {
  withDb((db) => {
    const service = new DocumentService(db);

    // Parse :linenum suffix from filename (e.g., "file.md:100")
    const colonMatch = filename.match(/:(\d+)$/);
    const inputPath = colonMatch ? filename.slice(0, colonMatch.index) : filename;
    const lineFromSuffix = colonMatch?.[1] ? parseInt(colonMatch[1], 10) : undefined;
    if (lineFromSuffix && !fromLine) {
      fromLine = lineFromSuffix;
    }

    const result = service.findDocument(inputPath, { includeBody: true });

    if ("error" in result) {
      let errorMsg = `Document not found: ${filename}`;
      if (result.similarFiles.length > 0) {
        errorMsg += "\n\nDid you mean one of these?";
        result.similarFiles.forEach((f) => (errorMsg += `\n  ${f}`));
      }
      logger.error(errorMsg);
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
      logger.data(`Folder Context: ${result.context}\n---\n`);
    }
    logger.data(output);
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
      logger.error(error);
    }

    if (docs.length === 0) {
      logger.error(`No files matched pattern: ${pattern}`);
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
    logger.data(JSON.stringify(output, null, 2));
  } else if (format === "csv") {
    const escapeField = (val: string | null): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    logger.data("file,title,context,skipped,body");
    for (const r of results) {
      const row: Array<string | undefined> = [
        r.displayPath,
        r.title,
        r.context || "",
        r.skipped ? "true" : "false",
        r.skipped ? r.skipReason : r.body,
      ];
      logger.data(row.map((v) => (v ? escapeField(v) : "")).join(","));
    }
  } else if (format === "files") {
    for (const r of results) {
      const ctx = r.context ? `,"${r.context.replace(/"/g, '""')}"` : "";
      const status = r.skipped ? "[SKIPPED]" : "";
      logger.data(`${r.displayPath}${ctx}${status ? `,${status}` : ""}`);
    }
  } else if (format === "md") {
    for (const r of results) {
      let doc = `## ${r.displayPath}\n\n`;
      if (r.title && r.title !== r.displayPath) doc += `**Title:** ${r.title}\n\n`;
      if (r.context) doc += `**Context:** ${r.context}\n\n`;
      if (r.skipped) {
        doc += `> ${r.skipReason}\n`;
      } else {
        doc += `\`\`\`\n${r.body}\n\`\`\`\n`;
      }
      logger.data(doc);
    }
  } else if (format === "xml") {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<documents>\n';
    for (const r of results) {
      xml += "  <document>\n";
      xml += `    <file>${escapeXml(r.displayPath)}</file>\n`;
      xml += `    <title>${escapeXml(r.title)}</title>\n`;
      if (r.context) xml += `    <context>${escapeXml(r.context)}</context>\n`;
      if (r.skipped) {
        xml += `    <skipped>true</skipped>\n`;
        xml += `    <reason>${escapeXml(r.skipReason || "")}</reason>\n`;
      } else {
        xml += `    <body>${escapeXml(r.body)}</body>\n`;
      }
      xml += "  </document>\n";
    }
    xml += "</documents>";
    logger.data(xml);
  } else {
    // CLI format (default)
    for (const r of results) {
      let doc = `\n${"=".repeat(60)}\nFile: ${r.displayPath}\n${"=".repeat(60)}\n\n`;

      if (r.skipped) {
        doc += `[SKIPPED: ${r.skipReason}]`;
        logger.data(doc);
        continue;
      }

      if (r.context) {
        doc += `Folder Context: ${r.context}\n---\n\n`;
      }
      doc += r.body;
      logger.data(doc);
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
        logger.info("No collections found. Run 'qmd add .' to index files.");
        return;
      }

      let output = `${c.bold}Collections:${c.reset}\n`;
      for (const coll of collections) {
        output += `${c.cyan}qmd://${coll.name}/${c.reset} (${coll.document_count} files)\n`;
      }
      logger.data(output);
      return;
    }

    // Parse the path argument
    let collectionName: string;
    let pathPrefix: string | null = null;

    if (pathArg.startsWith("qmd://")) {
      // Virtual path format: qmd://collection/path
      const parsed = parseVirtualPath(pathArg);
      if (!parsed) {
        logger.error(`Invalid virtual path: ${pathArg}`);
        process.exit(1);
      }
      collectionName = parsed.collectionName;
      pathPrefix = parsed.path;
    } else {
      // Just collection name or collection/path
      const parts = pathArg.split("/");
      collectionName = parts[0] || "";
      if (parts.length > 1) {
        pathPrefix = parts.slice(1).join("/");
      }
    }

    // Get the collection
    const coll = collectionManager.getByName(collectionName);
    if (!coll) {
      logger.error(`Collection not found: ${collectionName}\nRun 'qmd ls' to see available collections.`);
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
        logger.info(`No files found under qmd://${collectionName}/${pathPrefix}`);
      } else {
        logger.info(`No files found in collection: ${collectionName}`);
      }
      return;
    } // Output virtual paths
    for (const doc of docs) {
      logger.data(doc.displayPath);
    }
  });
}
