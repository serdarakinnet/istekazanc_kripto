import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';

export type UserRecord = {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string;
  passwordSalt: string;
  createdAtMs: number;
};

export type UserSettingsRecord = {
  userId: string;
  autoTradeEnabled: boolean;
  minRiskReward: number;
  updatedAtMs: number;
};

export type StoredPositionRecord = {
  id: string;
  userId: string;
  openedAtMs: number;
  payloadJson: string;
  updatedAtMs: number;
};

export type TradeReportRecord = {
  id: string;
  userId: string;
  symbol: string;
  openedAtMs: number;
  closedAtMs: number;
  entry: number;
  exit: number;
  outcome: 'TP' | 'SL';
  pnlPct: number;
  riskRewardAtEntry: number;
  createdAtMs: number;
};

type CreateUserParams = {
  email: string;
  password: string;
  displayName?: string;
};

type VerifyLoginParams = {
  email: string;
  password: string;
};

const DB_NAME = 'bist.db';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sha256(input: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
}

async function generateSalt(): Promise<string> {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashPassword(password: string, salt: string): Promise<string> {
  return sha256(`${salt}:${password}`);
}

function makeId(): string {
  return Crypto.randomUUID();
}

type SQLiteDatabase = SQLite.SQLiteDatabase;

let dbPromise: Promise<SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLiteDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = SQLite.openDatabaseAsync(DB_NAME);
  return dbPromise;
}

export async function initUserDb(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      displayName TEXT,
      passwordHash TEXT NOT NULL,
      passwordSalt TEXT NOT NULL,
      createdAtMs INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      userId TEXT PRIMARY KEY NOT NULL,
      autoTradeEnabled INTEGER NOT NULL,
      minRiskReward REAL NOT NULL,
      updatedAtMs INTEGER NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY NOT NULL,
      userId TEXT NOT NULL,
      openedAtMs INTEGER NOT NULL,
      payloadJson TEXT NOT NULL,
      updatedAtMs INTEGER NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_positions_userId_openedAt ON positions (userId, openedAtMs DESC);
    CREATE TABLE IF NOT EXISTS trade_reports (
      id TEXT PRIMARY KEY NOT NULL,
      userId TEXT NOT NULL,
      symbol TEXT NOT NULL,
      openedAtMs INTEGER NOT NULL,
      closedAtMs INTEGER NOT NULL,
      entry REAL NOT NULL,
      exit REAL NOT NULL,
      outcome TEXT NOT NULL,
      pnlPct REAL NOT NULL,
      riskRewardAtEntry REAL NOT NULL,
      createdAtMs INTEGER NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_trade_reports_userId_closedAt ON trade_reports (userId, closedAtMs DESC);
  `);
}

export async function createUser(params: CreateUserParams): Promise<UserRecord> {
  const email = normalizeEmail(params.email);
  const password = params.password.trim();
  const displayName = params.displayName?.trim() || null;

  if (!isValidEmail(email)) {
    throw new Error('Geçerli bir e-mail gir.');
  }
  if (password.length < 6) {
    throw new Error('Şifre en az 6 karakter olmalı.');
  }

  const id = makeId();
  const createdAtMs = Date.now();
  const passwordSalt = await generateSalt();
  const passwordHash = await hashPassword(password, passwordSalt);

  const record: UserRecord = {
    id,
    email,
    displayName,
    passwordHash,
    passwordSalt,
    createdAtMs,
  };

  await initUserDb();
  const db = await getDb();
  try {
    await db.runAsync(
      'INSERT INTO users (id, email, displayName, passwordHash, passwordSalt, createdAtMs) VALUES (?, ?, ?, ?, ?, ?)',
      [record.id, record.email, record.displayName, record.passwordHash, record.passwordSalt, record.createdAtMs],
    );
  } catch {
    throw new Error('Bu e-mail zaten kayıtlı.');
  }

  return record;
}

export async function getUserByEmail(emailInput: string): Promise<UserRecord | null> {
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) return null;

  await initUserDb();
  const db = await getDb();
  const row = await db.getFirstAsync<UserRecord>(
    'SELECT id, email, displayName, passwordHash, passwordSalt, createdAtMs FROM users WHERE email = ? LIMIT 1',
    [email],
  );
  return row ?? null;
}

export async function verifyLogin(params: VerifyLoginParams): Promise<UserRecord> {
  const email = normalizeEmail(params.email);
  const password = params.password.trim();

  if (!isValidEmail(email) || password.length === 0) {
    throw new Error('E-mail ve şifre zorunludur.');
  }

  const user = await getUserByEmail(email);
  if (!user) throw new Error('E-mail veya şifre hatalı.');

  const expected = await hashPassword(password, user.passwordSalt);
  if (expected !== user.passwordHash) {
    const salt = user.passwordSalt ?? '';
    const legacyCandidates = [
      `${password}`,
      `${password}:${salt}`,
      `${password}|${salt}`,
      `${salt}|${password}`,
      `${salt}${password}`,
      `${password}${salt}`,
    ];

    let legacyMatch = false;
    for (const candidate of legacyCandidates) {
      const legacyHash = await sha256(candidate);
      if (legacyHash === user.passwordHash) {
        legacyMatch = true;
        break;
      }
    }

    if (!legacyMatch) throw new Error('E-mail veya şifre hatalı.');

    await initUserDb();
    const db = await getDb();
    await db.runAsync('UPDATE users SET passwordHash = ? WHERE id = ?', [expected, user.id]);
  }

  return user;
}

export async function getUserSettings(userId: string): Promise<UserSettingsRecord | null> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return null;

  await initUserDb();
  const db = await getDb();
  const row = await db.getFirstAsync<{
    userId: string;
    autoTradeEnabled: number;
    minRiskReward: number;
    updatedAtMs: number;
  }>('SELECT userId, autoTradeEnabled, minRiskReward, updatedAtMs FROM user_settings WHERE userId = ? LIMIT 1', [
    trimmedUserId,
  ]);

  if (!row) return null;
  return {
    userId: row.userId,
    autoTradeEnabled: row.autoTradeEnabled === 1,
    minRiskReward: Number(row.minRiskReward),
    updatedAtMs: Number(row.updatedAtMs),
  };
}

export async function upsertUserSettings(params: {
  userId: string;
  autoTradeEnabled: boolean;
  minRiskReward: number;
}): Promise<UserSettingsRecord> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');

  const updatedAtMs = Date.now();
  const record: UserSettingsRecord = {
    userId: trimmedUserId,
    autoTradeEnabled: params.autoTradeEnabled,
    minRiskReward: params.minRiskReward,
    updatedAtMs,
  };

  await initUserDb();
  const db = await getDb();
  await db.runAsync(
    `
      INSERT INTO user_settings (userId, autoTradeEnabled, minRiskReward, updatedAtMs)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(userId) DO UPDATE SET
        autoTradeEnabled = excluded.autoTradeEnabled,
        minRiskReward = excluded.minRiskReward,
        updatedAtMs = excluded.updatedAtMs
    `,
    [record.userId, record.autoTradeEnabled ? 1 : 0, record.minRiskReward, record.updatedAtMs],
  );
  return record;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getUserPositions(userId: string): Promise<StoredPositionRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];

  await initUserDb();
  const db = await getDb();
  const rows = await db.getAllAsync<StoredPositionRecord>(
    'SELECT id, userId, openedAtMs, payloadJson, updatedAtMs FROM positions WHERE userId = ? ORDER BY openedAtMs DESC',
    [trimmedUserId],
  );
  return rows ?? [];
}

export async function replaceUserPositions(params: {
  userId: string;
  positions: Array<{ id: string; openedAtMs: number; payload: unknown }>;
}): Promise<void> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');

  const nowMs = Date.now();
  const normalized: StoredPositionRecord[] = params.positions.map((p) => {
    const payloadJson = JSON.stringify(isObjectRecord(p.payload) ? p.payload : { value: p.payload });
    return {
      id: p.id,
      userId: trimmedUserId,
      openedAtMs: p.openedAtMs,
      payloadJson,
      updatedAtMs: nowMs,
    };
  });

  await initUserDb();
  const db = await getDb();
  await db.execAsync('BEGIN TRANSACTION;');
  try {
    await db.runAsync('DELETE FROM positions WHERE userId = ?', [trimmedUserId]);
    for (const row of normalized) {
      await db.runAsync(
        'INSERT INTO positions (id, userId, openedAtMs, payloadJson, updatedAtMs) VALUES (?, ?, ?, ?, ?)',
        [row.id, row.userId, row.openedAtMs, row.payloadJson, row.updatedAtMs],
      );
    }
    await db.execAsync('COMMIT;');
  } catch (e) {
    await db.execAsync('ROLLBACK;');
    throw e;
  }
}

export async function getUserReports(userId: string): Promise<TradeReportRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];

  await initUserDb();
  const db = await getDb();
  const rows = await db.getAllAsync<TradeReportRecord>(
    `
      SELECT
        id, userId, symbol, openedAtMs, closedAtMs,
        entry, exit, outcome, pnlPct, riskRewardAtEntry, createdAtMs
      FROM trade_reports
      WHERE userId = ?
      ORDER BY closedAtMs DESC
    `,
    [trimmedUserId],
  );
  return rows ?? [];
}

export async function appendUserReports(params: {
  userId: string;
  reports: Array<Omit<TradeReportRecord, 'userId' | 'createdAtMs'>>;
}): Promise<void> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  if (params.reports.length === 0) return;

  const nowMs = Date.now();
  await initUserDb();
  const db = await getDb();

  await db.execAsync('BEGIN TRANSACTION;');
  try {
    for (const r of params.reports) {
      await db.runAsync(
        `
          INSERT INTO trade_reports (
            id, userId, symbol, openedAtMs, closedAtMs,
            entry, exit, outcome, pnlPct, riskRewardAtEntry, createdAtMs
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            userId = excluded.userId,
            symbol = excluded.symbol,
            openedAtMs = excluded.openedAtMs,
            closedAtMs = excluded.closedAtMs,
            entry = excluded.entry,
            exit = excluded.exit,
            outcome = excluded.outcome,
            pnlPct = excluded.pnlPct,
            riskRewardAtEntry = excluded.riskRewardAtEntry
        `,
        [
          r.id,
          trimmedUserId,
          r.symbol,
          r.openedAtMs,
          r.closedAtMs,
          r.entry,
          r.exit,
          r.outcome,
          r.pnlPct,
          r.riskRewardAtEntry,
          nowMs,
        ],
      );
    }
    await db.execAsync('COMMIT;');
  } catch (e) {
    await db.execAsync('ROLLBACK;');
    throw e;
  }
}
