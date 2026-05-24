const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function readComposePostgresConfig() {
  try {
    const composePath = path.join(__dirname, '..', 'docker-compose.yml');
    const raw = fs.readFileSync(composePath, 'utf8');

    const dbMatch = raw.match(/^\s*POSTGRES_DB:\s*("?)([^"\r\n]+)\1\s*$/m);
    const userMatch = raw.match(/^\s*POSTGRES_USER:\s*("?)([^"\r\n]+)\1\s*$/m);
    const passMatch = raw.match(/^\s*POSTGRES_PASSWORD:\s*("?)([^"\r\n]+)\1\s*$/m);

    const database = dbMatch ? String(dbMatch[2]).trim() : null;
    const user = userMatch ? String(userMatch[2]).trim() : null;
    const password = passMatch ? String(passMatch[2]).trim() : null;

    const normalizeValue = (value) => {
      if (!value) return null;
      const trimmed = String(value).trim();
      if (!trimmed) return null;
      if (trimmed.includes('${')) return null;
      return trimmed;
    };

    const normalizedDatabase = normalizeValue(database);
    const normalizedUser = normalizeValue(user);
    const normalizedPassword = normalizeValue(password);

    if (!normalizedDatabase || !normalizedUser) return null;
    return { database: normalizedDatabase, user: normalizedUser, password: normalizedPassword };
  } catch {
    return null;
  }
}

function resolveDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const host = process.env.PGHOST?.trim() || '127.0.0.1';
  const port = process.env.PGPORT?.trim() || '5432';
  const compose = readComposePostgresConfig();
  const user = process.env.PGUSER?.trim() || compose?.user || 'postgres';
  const password = process.env.PGPASSWORD?.trim() || compose?.password || 'postgres';
  const database = process.env.PGDATABASE?.trim() || compose?.database || 'tradefeed';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(
    database,
  )}`;
}

const pool = new Pool({
  connectionString: resolveDatabaseUrl(),
  max: 10,
});

module.exports = { pool };
