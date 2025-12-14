/**
 * Database Connection Management
 *
 * Handles database connection lifecycle and initialization.
 */

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { getDefaultDbPath } from "./config.js";
import { initializeSchema } from "./schema.js";

// On macOS, use Homebrew's SQLite which supports extensions
if (process.platform === "darwin") {
  const homebrewSqlitePath = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
  try {
    if (Bun.file(homebrewSqlitePath).size > 0) {
      Database.setCustomSQLite(homebrewSqlitePath);
    }
  } catch {
    // Ignore errors - use default SQLite
  }
}

/**
 * Create and initialize a database connection
 */
export function createConnection(dbPath?: string): Database {
  const resolvedPath = dbPath || getDefaultDbPath();
  const db = new Database(resolvedPath);

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Initialize schema
  initializeSchema(db);

  return db;
}

/**
 * Close a database connection
 */
export function closeConnection(db: Database): void {
  db.close();
}

/**
 * Execute a command with automatic database cleanup.
 * Guarantees that the database connection is properly closed even if the
 * command throws an error or exits early.
 *
 * @param fn - Command function that receives a Database instance
 * @returns The return value of the command function
 *
 * @example
 * ```typescript
 * export function myCommand(): void {
 *   withDb((db) => {
 *     const service = new SomeService(db);
 *     service.doSomething();
 *   });
 * }
 * ```
 */
export function withDb<T>(fn: (db: Database) => T): T {
  const db = getDb();
  try {
    return fn(db);
  } finally {
    closeDb();
  }
}

/**
 * Execute an async command with automatic database cleanup.
 * Guarantees that the database connection is properly closed even if the
 * command throws an error or exits early.
 *
 * @param fn - Async command function that receives a Database instance
 * @returns Promise resolving to the return value of the command function
 *
 * @example
 * ```typescript
 * export async function myCommand(): Promise<void> {
 *   await withDbAsync(async (db) => {
 *     const service = new SomeService(db);
 *     await service.doSomething();
 *   });
 * }
 * ```
 */
export async function withDbAsync<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = getDb();
  try {
    return await fn(db);
  } finally {
    closeDb();
  }
}

/**
 * Execute a function within a transaction
 */
export function withTransaction<T>(db: Database, fn: () => T): T {
  db.run("BEGIN TRANSACTION");
  try {
    const result = fn();
    db.run("COMMIT");
    return result;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

/**
 * Execute an async function within a transaction
 */
export async function withTransactionAsync<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  db.run("BEGIN TRANSACTION");
  try {
    const result = await fn();
    db.run("COMMIT");
    return result;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

// =============================================================================
// CLI Singleton Pattern
// =============================================================================
// Used by CLI commands for simple, shared database access.
// This pattern is appropriate for short-lived CLI operations that benefit
// from a shared connection without explicit lifecycle management.

let _cliDb: Database | null = null;
let _cliDbPath: string | null = null;

/**
 * Set a custom index name for the CLI singleton database connection.
 * Used by the CLI's --index option to specify an alternate database file.
 * This must be called before any command that uses getDb().
 */
export function setCustomIndexName(name: string | null): void {
  _cliDbPath = name ? getDefaultDbPath(name) : null;
  _cliDb = null; // Reset so next getDb() creates new connection
}

/**
 * Get the current database path for the CLI singleton connection.
 * Returns either the custom path set via --index option or the default.
 */
export function getDbPath(): string {
  return _cliDbPath || getDefaultDbPath();
}

/**
 * Get the CLI singleton database connection.
 * Lazily creates the connection on first access.
 *
 * Used by CLI commands for simple, shared database access.
 * The connection is automatically reused across multiple getDb() calls
 * until closeDb() is called.
 *
 * Pattern: `const db = getDb(); ... closeDb();`
 *
 * For long-lived services (e.g., MCP server), use createConnection() instead.
 */
export function getDb(): Database {
  if (!_cliDb) {
    _cliDb = createConnection(getDbPath());
  }
  return _cliDb;
}

/**
 * Close the CLI singleton database connection.
 * Must be called at the end of CLI commands to properly release resources.
 *
 * After calling this, the next getDb() call will create a new connection.
 */
export function closeDb(): void {
  if (_cliDb) {
    closeConnection(_cliDb);
    _cliDb = null;
  }
}
