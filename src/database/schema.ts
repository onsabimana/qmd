/**
 * Database Schema Management
 *
 * Handles table creation, migrations, and schema updates.
 */

import type { Database } from "bun:sqlite";

/**
 * Initialize all database tables and triggers
 */
export function initializeSchema(db: Database): void {
  // Enable WAL mode and foreign keys
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Check if we need to migrate from old schema
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
  const tableNames = tables.map((t) => t.name);
  const needsMigration = tableNames.includes("documents") && !tableNames.includes("content");

  if (needsMigration) {
    migrateToContentAddressable(db);
    return; // Migration will call initializeSchema again
  }

  // Content-addressable storage - the source of truth for document content
  db.run(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Collections table with name field
  db.run(`
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      pwd TEXT NOT NULL,
      glob_pattern TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(pwd, glob_pattern)
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection_id, path)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id, active)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Path-based context (collection-scoped, hierarchical)
  db.run(`
    CREATE TABLE IF NOT EXISTS path_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL,
      path_prefix TEXT NOT NULL,
      context TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
      UNIQUE(collection_id, path_prefix)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_path_contexts_collection ON path_contexts(collection_id, path_prefix)`);

  // Cache table for Ollama API calls
  db.run(`
    CREATE TABLE IF NOT EXISTS ollama_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some((col) => col.name === "seq");
  if (cvInfo.length > 0 && !hasSeqColumn) {
    db.run(`DROP TABLE IF EXISTS content_vectors`);
    db.run(`DROP TABLE IF EXISTS vectors_vec`);
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // FTS - index path and content (joined from content table)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      path, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync
  db.run(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, path, body)
      SELECT new.id, new.path, c.doc
      FROM content c
      WHERE c.hash = new.hash;
    END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      UPDATE documents_fts
      SET path = new.path,
          body = (SELECT doc FROM content WHERE hash = new.hash)
      WHERE rowid = new.id;
    END
  `);
}

/**
 * Migrate database from old schema to content-addressable schema
 */
function migrateToContentAddressable(db: Database): void {
  console.log("Migrating database to content-addressable schema...");

  db.run("BEGIN TRANSACTION");

  try {
    // Rename old tables
    db.run("ALTER TABLE documents RENAME TO documents_old");
    db.run("ALTER TABLE collections RENAME TO collections_old");
    db.run("ALTER TABLE path_contexts RENAME TO path_contexts_old");
    db.run("DROP TABLE IF EXISTS documents_fts");
    db.run("DROP TRIGGER IF EXISTS documents_ai");
    db.run("DROP TRIGGER IF EXISTS documents_ad");
    db.run("DROP TRIGGER IF EXISTS documents_au");

    // Create new schema
    db.run(`
      CREATE TABLE content (
        hash TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        pwd TEXT NOT NULL,
        glob_pattern TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(pwd, glob_pattern)
      )
    `);

    db.run(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
        FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
        UNIQUE(collection_id, path)
      )
    `);

    db.run(`
      CREATE TABLE path_contexts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL,
        path_prefix TEXT NOT NULL,
        context TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
        UNIQUE(collection_id, path_prefix)
      )
    `);

    // Migrate data
    console.log("Migrating content...");
    db.run(`
      INSERT INTO content (hash, doc, created_at)
      SELECT hash, body, MIN(created_at) as created_at
      FROM documents_old
      WHERE active = 1
      GROUP BY hash
    `);

    console.log("Migrating collections...");
    db.run(`
      INSERT INTO collections (id, name, pwd, glob_pattern, created_at, updated_at)
      SELECT id, pwd as name, pwd, glob_pattern, created_at, created_at as updated_at
      FROM collections_old
    `);

    // Update collection names to basenames
    const collections = db.prepare(`SELECT id, pwd FROM collections`).all() as { id: number; pwd: string }[];
    for (const coll of collections) {
      const parts = coll.pwd.split("/").filter(Boolean);
      const name = parts[parts.length - 1] || "root";
      db.prepare(`UPDATE collections SET name = ? WHERE id = ?`).run(name, coll.id);
    }

    // Handle duplicate names
    const duplicates = db
      .prepare(`SELECT name, COUNT(*) as cnt FROM collections GROUP BY name HAVING cnt > 1`)
      .all() as { name: string; cnt: number }[];
    for (const dup of duplicates) {
      const rows = db.prepare(`SELECT id FROM collections WHERE name = ? ORDER BY id`).all(dup.name) as {
        id: number;
      }[];
      for (let i = 1; i < rows.length; i++) {
        db.prepare(`UPDATE collections SET name = ? WHERE id = ?`).run(`${dup.name}-${rows[i].id}`, rows[i].id);
      }
    }

    // Migrate documents
    console.log("Migrating documents...");
    const oldDocs = db
      .prepare(
        `SELECT d.id, d.collection_id, d.filepath, d.title, d.hash, d.created_at, d.modified_at, c.pwd
         FROM documents_old d
         JOIN collections c ON c.id = d.collection_id
         WHERE d.active = 1`,
      )
      .all() as Array<{
      id: number;
      collection_id: number;
      filepath: string;
      title: string;
      hash: string;
      created_at: string;
      modified_at: string;
      pwd: string;
    }>;

    const insertDoc = db.prepare(
      `INSERT INTO documents (collection_id, path, title, hash, created_at, modified_at, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    );

    for (const doc of oldDocs) {
      let path = doc.filepath;
      if (path.startsWith(doc.pwd + "/")) {
        path = path.slice(doc.pwd.length + 1);
      } else if (path.startsWith(doc.pwd)) {
        path = path.slice(doc.pwd.length);
      }
      path = path.replace(/^\/+/, "");

      try {
        insertDoc.run(doc.collection_id, path, doc.title, doc.hash, doc.created_at, doc.modified_at);
      } catch (e) {
        console.warn(`Skipping duplicate path: ${path} in collection ${doc.collection_id}`);
      }
    }

    // Migrate path contexts
    console.log("Migrating path contexts...");
    const oldContexts = db.prepare(`SELECT * FROM path_contexts_old`).all() as Array<{
      path_prefix: string;
      context: string;
      created_at: string;
    }>;

    const insertContext = db.prepare(
      `INSERT INTO path_contexts (collection_id, path_prefix, context, created_at)
       VALUES (?, ?, ?, ?)`,
    );

    const allCollections = db.prepare(`SELECT id, pwd FROM collections`).all() as Array<{ id: number; pwd: string }>;

    for (const ctx of oldContexts) {
      for (const coll of allCollections) {
        if (ctx.path_prefix.startsWith(coll.pwd)) {
          let relPath = ctx.path_prefix;
          if (relPath.startsWith(coll.pwd + "/")) {
            relPath = relPath.slice(coll.pwd.length + 1);
          } else if (relPath.startsWith(coll.pwd)) {
            relPath = relPath.slice(coll.pwd.length);
          }
          relPath = relPath.replace(/^\/+/, "");

          try {
            insertContext.run(coll.id, relPath, ctx.context, ctx.created_at);
          } catch (e) {
            // Ignore duplicates
          }
        }
      }
    }

    // Drop old tables
    db.run("DROP TABLE documents_old");
    db.run("DROP TABLE collections_old");
    db.run("DROP TABLE path_contexts_old");

    // Recreate FTS and triggers
    db.run(`
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        path, body,
        tokenize='porter unicode61'
      )
    `);

    db.run(`
      CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, path, body)
        SELECT new.id, new.path, c.doc
        FROM content c
        WHERE c.hash = new.hash;
      END
    `);

    db.run(`
      CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE rowid = old.id;
      END
    `);

    db.run(`
      CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
        UPDATE documents_fts
        SET path = new.path,
            body = (SELECT doc FROM content WHERE hash = new.hash)
        WHERE rowid = new.id;
      END
    `);

    // Populate FTS from migrated data
    console.log("Rebuilding full-text search index...");
    db.run(`
      INSERT INTO documents_fts(rowid, path, body)
      SELECT d.id, d.path, c.doc
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.active = 1
    `);

    // Create indexes
    db.run(`CREATE INDEX idx_documents_collection ON documents(collection_id, active)`);
    db.run(`CREATE INDEX idx_documents_hash ON documents(hash)`);
    db.run(`CREATE INDEX idx_documents_path ON documents(path, active)`);
    db.run(`CREATE INDEX idx_path_contexts_collection ON path_contexts(collection_id, path_prefix)`);

    db.run("COMMIT");
    console.log("Migration complete!");
  } catch (e) {
    db.run("ROLLBACK");
    console.error("Migration failed:", e);
    throw e;
  }
}
