const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function loadDotEnvIfPresent() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key) continue;
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
  }
}

function resolveEnvTemplate(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^\$\{([A-Z0-9_]+)(?::-(.*))?\}$/);
  if (!match) return trimmed;

  const envKey = match[1];
  const fallback = typeof match[2] === 'string' ? match[2] : '';
  const fromEnv = process.env[envKey];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  if (fallback && String(fallback).trim()) return String(fallback).trim();
  return null;
}

function readComposePostgresConfig() {
  try {
    const composePath = path.join(__dirname, '..', 'docker-compose.yml');
    const raw = fs.readFileSync(composePath, 'utf8');

    const dbMatch = raw.match(/^\s*POSTGRES_DB:\s*("?)([^"\r\n]+)\1\s*$/m);
    const userMatch = raw.match(/^\s*POSTGRES_USER:\s*("?)([^"\r\n]+)\1\s*$/m);
    const passMatch = raw.match(/^\s*POSTGRES_PASSWORD:\s*("?)([^"\r\n]+)\1\s*$/m);

    const database = resolveEnvTemplate(dbMatch ? String(dbMatch[2]).trim() : null);
    const user = resolveEnvTemplate(userMatch ? String(userMatch[2]).trim() : null);
    const password = resolveEnvTemplate(passMatch ? String(passMatch[2]).trim() : null);

    if (!database || !user) return null;
    return { database, user, password };
  } catch {
    return null;
  }
}

function resolveDatabaseUrl() {
  loadDotEnvIfPresent();

  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const host = process.env.PGHOST?.trim() || process.env.POSTGRES_HOST?.trim() || '127.0.0.1';
  const port = process.env.PGPORT?.trim() || process.env.POSTGRES_PORT?.trim() || '5432';
  const compose = readComposePostgresConfig();
  const user = process.env.PGUSER?.trim() || process.env.POSTGRES_USER?.trim() || compose?.user || 'postgres';
  const password =
    process.env.PGPASSWORD?.trim() || process.env.POSTGRES_PASSWORD?.trim() || compose?.password || 'postgres';
  const database =
    process.env.PGDATABASE?.trim() || process.env.POSTGRES_DB?.trim() || compose?.database || 'tradefeed';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(
    database,
  )}`;
}

const pool = new Pool({
  connectionString: resolveDatabaseUrl(),
  max: 10,
});

module.exports = { pool };
