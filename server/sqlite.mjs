import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// The same small database interface is used by business/auth code and tests.
// A batch is a real transaction: credentials and their business account either
// both commit or neither does.
export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const sqlite = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1)');
  const execute = (sql, args) => {
    const statement = sqlite.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      return { success: true, results: statement.all(...args), meta: { changes: 0 } };
    }
    const result = statement.run(...args);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  };
  return {
    sqlite,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first(column) { const row = sqlite.prepare(sql).get(...args) || null; return column ? row?.[column] ?? null : row; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...args) }; },
        async run() { return execute(sql, args); },
        execute() { return execute(sql, args); },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    async exec(sql) { sqlite.exec(sql); return { count: 1, duration: 0 }; },
    close() { sqlite.close(); },
  };
}
