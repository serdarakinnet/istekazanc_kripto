const fs = require('fs');
const path = require('path');

const { pool } = require('./db');

function listMigrationFiles() {
  const dir = path.join(__dirname, 'migrations');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrationIds(client) {
  const res = await client.query('SELECT id FROM schema_migrations ORDER BY id ASC');
  return new Set(res.rows.map((r) => String(r.id)));
}

async function applyMigration(client, filename) {
  const fullPath = path.join(__dirname, 'migrations', filename);
  const sql = fs.readFileSync(fullPath, 'utf8');
  await client.query(sql);
  await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [filename]);
}

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrationIds(client);
    const files = listMigrationFiles();
    for (const file of files) {
      if (applied.has(file)) continue;
      await applyMigration(client, file);
    }
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { migrate };
