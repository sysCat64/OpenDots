import { DatabaseSync } from 'node:sqlite';

// Every row of every table, so two snapshots are equal only if nothing was
// written, updated or deleted in between.
export function snapshotDatabase(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    return JSON.stringify(
      Object.fromEntries(
        tables.map((table) => [
          table,
          db.prepare(`SELECT * FROM "${table}"`).all(),
        ]),
      ),
    );
  } finally {
    db.close();
  }
}
