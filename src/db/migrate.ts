import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { buildDbPool } from "./pool.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

// arbitrary fixed id -- just needs to be consistent across all instances of this service
const MIGRATION_LOCK_ID = 7264991;

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // advisory lock so multiple tasks booting at once don't race to apply migrations
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`applied migration: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    client.release();
  }
}

// run directly: `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = buildDbPool();
  runMigrations(pool)
    .then(() => pool.end())
    .then(() => console.log("migrations complete"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
