/**
 * Virtual path utilities (qmd:// protocol)
 */

import type { Database } from "bun:sqlite";
import { resolve } from "./path";
import { CollectionRepository } from "src/database/collections";

export interface VirtualPath {
  collectionName: string;
  path: string;
}

/**
 * Parse a virtual path like "qmd://collection-name/path/to/file.md"
 * into its components.
 */
export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  const match = virtualPath.match(/^qmd:\/\/([^\/]+)\/(.+)$/);
  if (!match) return null;
  return {
    collectionName: match[1],
    path: match[2],
  };
}

/**
 * Build a virtual path from collection name and relative path.
 */
export function buildVirtualPath(collectionName: string, path: string): string {
  return `qmd://${collectionName}/${path}`;
}

/**
 * Check if a path is a virtual path (starts with qmd://).
 */
export function isVirtualPath(path: string): boolean {
  return path.startsWith("qmd://");
}

/**
 * Resolve a virtual path to absolute filesystem path.
 */
export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const collRepo = new CollectionRepository(db);
  const coll = collRepo.getByNameWithPath(parsed.collectionName);
  if (!coll) return null;

  return resolve(coll.pwd, parsed.path);
}

/**
 * Convert an absolute filesystem path to a virtual path.
 * Returns null if the file is not in any indexed collection.
 */
export function toVirtualPath(db: Database, absolutePath: string): string | null {
  const collRepo = new CollectionRepository(db);
  const doc = collRepo.findDocumentByAbsolutePath(absolutePath);
  if (!doc) return null;

  return buildVirtualPath(doc.name, doc.path);
}
