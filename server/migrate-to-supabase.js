const fs = require('fs');
const path = require('path');

const dns = require('dns');
const { Pool } = require('pg');

try {
  dns.setServers(['1.1.1.1', '8.8.8.8']);
} catch {
}

function redactConnString(input) {
  try {
    const u = new URL(String(input));
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return String(input || '');
  }
}

function describeConnString(input) {
  const raw = String(input || '').trim();
  if (!raw) return '(missing)';
  const normalized = normalizeConnString(raw);
  try {
    const u = new URL(normalized);
    const host = u.hostname || '(host)';
    const port = u.port ? `:${u.port}` : '';
    const user = u.username ? decodeURIComponent(u.username) : '(user)';
    const pwLen = u.password ? decodeURIComponent(u.password).length : 0;
    const db = u.pathname || '';
    return `${u.protocol}//${user}:***@${host}${port}${db} (pwLen=${pwLen})`;
  } catch {
    return '(invalid)';
  }
}

function normalizeConnString(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  const tryParse = (value) => {
    const u = new URL(value);
    if (u.username.startsWith('<') && u.username.endsWith('>')) u.username = u.username.slice(1, -1);
    if (u.password.startsWith('<') && u.password.endsWith('>')) u.password = u.password.slice(1, -1);
    return u.toString();
  };

  try {
    return tryParse(raw);
  } catch {
  }

  const m = raw.match(/^(postgres(?:ql)?):\/\/([^@\/]+)@([\s\S]+)$/i);
  if (!m) return raw;

  const scheme = m[1];
  const userInfo = m[2];
  const rest = m[3];
  const colon = userInfo.indexOf(':');
  if (colon <= 0) return raw;

  const usernameRaw = userInfo.slice(0, colon);
  const passwordRaw = userInfo.slice(colon + 1);
  const cleanedUser =
    usernameRaw.startsWith('<') && usernameRaw.endsWith('>') ? usernameRaw.slice(1, -1) : usernameRaw;
  const cleanedPass =
    passwordRaw.startsWith('<') && passwordRaw.endsWith('>') ? passwordRaw.slice(1, -1) : passwordRaw;

  let decodedUser = cleanedUser;
  let decodedPass = cleanedPass;
  try {
    decodedUser = decodeURIComponent(cleanedUser);
  } catch {
  }
  try {
    decodedPass = decodeURIComponent(cleanedPass);
  } catch {
  }

  const rebuilt = `${scheme}://${encodeURIComponent(decodedUser)}:${encodeURIComponent(decodedPass)}@${rest}`;
  try {
    return tryParse(rebuilt);
  } catch {
    return rebuilt;
  }
}

function loadDotEnvIfPresent() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const overrideKeys = new Set(['SOURCE_DATABASE_URL', 'TARGET_DATABASE_URL', 'SUPABASE_DATABASE_URL', 'DATABASE_URL', 'PGSSLMODE']);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key) continue;
      if (Object.prototype.hasOwnProperty.call(process.env, key) && !overrideKeys.has(key)) continue;
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
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

function resolveSourceDatabaseUrl() {
  loadDotEnvIfPresent();

  const explicit = process.env.SOURCE_DATABASE_URL;
  if (explicit && explicit.trim()) return normalizeConnString(explicit.trim());

  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim()) return normalizeConnString(fromEnv.trim());

  const host = process.env.PGHOST?.trim() || process.env.POSTGRES_HOST?.trim() || '127.0.0.1';
  const port = process.env.PGPORT?.trim() || process.env.POSTGRES_PORT?.trim() || '5432';
  const compose = readComposePostgresConfig();
  const user = process.env.PGUSER?.trim() || process.env.POSTGRES_USER?.trim() || compose?.user || 'postgres';
  const password =
    process.env.PGPASSWORD?.trim() || process.env.POSTGRES_PASSWORD?.trim() || compose?.password || 'postgres';
  const database = process.env.PGDATABASE?.trim() || process.env.POSTGRES_DB?.trim() || compose?.database || 'tradefeed';

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(
    database,
  )}`;
}

function resolveTargetDatabaseUrl() {
  loadDotEnvIfPresent();
  const v = process.env.TARGET_DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
  if (!v || !String(v).trim()) {
    throw new Error(
      'TARGET_DATABASE_URL eksik. Supabase Dashboard > Project Settings > Database > Connection string (Direct) değerini TARGET_DATABASE_URL olarak ver.',
    );
  }
  const trimmed = normalizeConnString(String(v).trim());
  if (trimmed.includes('<SUPABASE_DB_PASSWORD>') || trimmed.includes('[YOUR-PASSWORD]')) {
    throw new Error('TARGET_DATABASE_URL içinde password placeholder var. Supabase DB password’ü koy.');
  }
  return trimmed;
}

function resolveSsl(connectionString, hostnameHint) {
  const raw = String(connectionString || '');
  const lowered = raw.toLowerCase();
  const hint = String(hostnameHint || '').toLowerCase();
  let mode = '';
  try {
    const u = new URL(raw);
    mode = String(u.searchParams.get('sslmode') || '').trim().toLowerCase();
  } catch {
  }

  if (mode === 'verify-full') return { rejectUnauthorized: true };
  if (mode === 'require' || mode === 'verify-ca' || mode === 'prefer') return { rejectUnauthorized: false };
  if (lowered.includes('sslmode=require')) return { rejectUnauthorized: false };
  if (lowered.includes('supabase.co') || lowered.includes('supabase.com')) return { rejectUnauthorized: false };
  if (hint.includes('supabase.co') || hint.includes('supabase.com')) return { rejectUnauthorized: false };
  return undefined;
}

function isIpv4(host) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(host || '').trim());
}

async function resolveHostIpv4(hostname) {
  const host = String(hostname || '').trim();
  if (!host) throw new Error('Host missing');
  if (isIpv4(host)) return host;

  const timeoutMs = 2500;
  const res = await Promise.race([
    dns.promises.resolve4(host),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), timeoutMs)),
  ]);
  const list = Array.isArray(res) ? res : [];
  const ip = list.find((x) => typeof x === 'string' && isIpv4(x));
  if (!ip) throw new Error('No A record');
  return ip;
}

async function createPool(connectionString) {
  const normalized = normalizeConnString(connectionString);
  const u = new URL(normalized);
  const originalHost = u.hostname;
  const port = u.port ? Number(u.port) : 5432;
  const database = String(u.pathname || '').replace(/^\//, '') || 'postgres';
  const user = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';

  let host = originalHost;
  try {
    host = await resolveHostIpv4(originalHost);
  } catch {
    host = originalHost;
  }

  const baseSsl = resolveSsl(normalized, originalHost);
  let ssl = baseSsl;
  if (ssl && typeof ssl === 'object' && isIpv4(host) && originalHost && originalHost !== host) {
    ssl = { ...ssl, servername: originalHost };
  }

  return new Pool({
    host,
    port,
    database,
    user,
    password,
    ssl,
    max: 3,
  });
}

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

async function migrateTargetSchema(targetPool) {
  const client = await targetPool.connect();
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

function stripPublicPrefix(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const withoutSchema = s.startsWith('public.') ? s.slice('public.'.length) : s;
  return withoutSchema.replace(/^"+|"+$/g, '').replace(/""/g, '"');
}

function qIdent(name) {
  const s = String(name || '');
  return `"${s.replace(/"/g, '""')}"`;
}

async function getPublicTables(sourcePool) {
  const res = await sourcePool.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname='public'
     ORDER BY tablename ASC`,
  );
  return res.rows
    .map((r) => String(r.tablename))
    .filter((t) => t && t !== 'schema_migrations');
}

async function getForeignKeyEdges(sourcePool) {
  const res = await sourcePool.query(
    `
    SELECT
      c.conrelid::regclass::text AS table_name,
      c.confrelid::regclass::text AS ref_table_name
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
    `,
  );
  return res.rows
    .map((r) => ({
      from: stripPublicPrefix(r.table_name),
      to: stripPublicPrefix(r.ref_table_name),
    }))
    .filter((e) => e.from && e.to);
}

function topoSortTables(tables, edges) {
  const set = new Set(tables);
  const outEdges = new Map();
  const indeg = new Map();
  for (const t of tables) {
    outEdges.set(t, new Set());
    indeg.set(t, 0);
  }
  for (const e of edges) {
    if (!set.has(e.from) || !set.has(e.to)) continue;
    const next = outEdges.get(e.to);
    if (!next) continue;
    if (next.has(e.from)) continue;
    next.add(e.from);
    indeg.set(e.from, (indeg.get(e.from) || 0) + 1);
  }

  const queue = [];
  for (const [t, d] of indeg.entries()) {
    if (d === 0) queue.push(t);
  }
  queue.sort((a, b) => a.localeCompare(b));

  const ordered = [];
  while (queue.length > 0) {
    const t = queue.shift();
    ordered.push(t);
    const outs = outEdges.get(t);
    if (!outs) continue;
    for (const child of outs.values()) {
      const nextD = (indeg.get(child) || 0) - 1;
      indeg.set(child, nextD);
      if (nextD === 0) {
        queue.push(child);
        queue.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (ordered.length !== tables.length) return tables;
  return ordered;
}

async function truncateTargetTables(targetClient, tables) {
  if (tables.length === 0) return;
  const list = tables.map((t) => `public.${qIdent(t)}`).join(', ');
  await targetClient.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

async function getTableColumns(sourcePool, tableName) {
  const res = await sourcePool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
    ORDER BY ordinal_position ASC
    `,
    [tableName],
  );
  return res.rows.map((r) => String(r.column_name)).filter(Boolean);
}

function buildInsertSql(tableName, columns, rowCount) {
  const colList = columns.map(qIdent).join(', ');
  const values = [];
  let p = 1;
  for (let r = 0; r < rowCount; r += 1) {
    const parts = [];
    for (let c = 0; c < columns.length; c += 1) {
      parts.push(`$${p}`);
      p += 1;
    }
    values.push(`(${parts.join(', ')})`);
  }
  return `INSERT INTO public.${qIdent(tableName)} (${colList}) VALUES ${values.join(', ')};`;
}

async function copyTableData(sourcePool, targetClient, tableName) {
  const columns = await getTableColumns(sourcePool, tableName);
  if (columns.length === 0) return;

  const res = await sourcePool.query(`SELECT * FROM public.${qIdent(tableName)};`);
  const rows = Array.isArray(res.rows) ? res.rows : [];
  if (rows.length === 0) return;

  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const sql = buildInsertSql(tableName, columns, batch.length);
    const params = [];
    for (const row of batch) {
      for (const col of columns) params.push(row[col]);
    }
    await targetClient.query(sql, params);
  }
}

async function countRows(pool, tableName) {
  const res = await pool.query(`SELECT COUNT(*)::bigint AS c FROM public.${qIdent(tableName)};`);
  const v = res.rows?.[0]?.c;
  const n = typeof v === 'bigint' ? v : BigInt(String(v || '0'));
  return n;
}

async function main() {
  const sourceUrl = resolveSourceDatabaseUrl();
  const targetUrl = resolveTargetDatabaseUrl();

  const sourcePool = await createPool(sourceUrl);
  const targetPool = await createPool(targetUrl);

  try {
    await migrateTargetSchema(targetPool);

    const tables = await getPublicTables(sourcePool);
    const edges = await getForeignKeyEdges(sourcePool);
    const ordered = topoSortTables(tables, edges);

    const targetClient = await targetPool.connect();
    try {
      await targetClient.query('BEGIN');
      await truncateTargetTables(targetClient, ordered);
      for (const t of ordered) {
        await copyTableData(sourcePool, targetClient, t);
      }
      await targetClient.query('COMMIT');
    } catch (e) {
      try {
        await targetClient.query('ROLLBACK');
      } catch {
      }
      throw e;
    } finally {
      targetClient.release();
    }

    for (const t of ordered) {
      const [a, b] = await Promise.all([countRows(sourcePool, t), countRows(targetPool, t)]);
      if (a !== b) throw new Error(`Satır sayısı uyuşmuyor: ${t}`);
    }
  } finally {
    await Promise.allSettled([sourcePool.end(), targetPool.end()]);
  }
}

main()
  .then(() => {
    process.stdout.write('OK\n');
  })
  .catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`FAIL: ${msg}\n`);
    process.stderr.write(
      `SOURCE_DATABASE_URL: ${describeConnString(process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || '')}\n`,
    );
    process.stderr.write(
      `TARGET_DATABASE_URL: ${describeConnString(process.env.TARGET_DATABASE_URL || process.env.SUPABASE_DATABASE_URL || '')}\n`,
    );
    process.exitCode = 1;
  });
