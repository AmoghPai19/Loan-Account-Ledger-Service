// Applies migrations/*.sql in filename order, each inside its own
// transaction, and records what has been applied in schema_migrations.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool } from '../src/db/pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(connectionString) {
  const pool = createPool(connectionString);
  const dir = path.resolve(here, '../migrations');
  const applied = [];
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set(
      (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await pool.end();
  }
}

// Run directly: `npm run migrate`.
// pathToFileURL turns C:\...\migrate.js into file:///C:/.../migrate.js, so this
// check also works on Windows. A plain `file://${path}` string comparison does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then((files) => console.log(files.length ? `Applied: ${files.join(', ')}` : 'Up to date'))
    .catch((err) => { console.error(err.message); process.exit(1); });
}