import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

export type UserRecord = {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string;
  passwordSalt: string;
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
const AS_KEY = 'bist_users_v1';

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

async function loadUsersFromAsyncStorage(): Promise<UserRecord[]> {
  const raw = await AsyncStorage.getItem(AS_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(Boolean) as UserRecord[];
}

async function saveUsersToAsyncStorage(users: UserRecord[]): Promise<void> {
  await AsyncStorage.setItem(AS_KEY, JSON.stringify(users));
}

type SQLiteDatabase = import('expo-sqlite').SQLiteDatabase;

let dbPromise: Promise<SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLiteDatabase> {
  if (Platform.OS === 'web') {
    throw new Error('Web için SQLite kullanılmıyor.');
  }

  if (dbPromise) return dbPromise;
  const SQLite = await import('expo-sqlite');
  dbPromise = SQLite.openDatabaseAsync(DB_NAME);
  return dbPromise;
}

export async function initUserDb(): Promise<void> {
  if (Platform.OS === 'web') return;
  const db = await getDb();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      displayName TEXT,
      passwordHash TEXT NOT NULL,
      passwordSalt TEXT NOT NULL,
      createdAtMs INTEGER NOT NULL
    );
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

  if (Platform.OS === 'web') {
    const users = await loadUsersFromAsyncStorage();
    const exists = users.some((u) => u.email === email);
    if (exists) throw new Error('Bu e-mail zaten kayıtlı.');
    await saveUsersToAsyncStorage([record, ...users]);
    return record;
  }

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

  if (Platform.OS === 'web') {
    const users = await loadUsersFromAsyncStorage();
    return users.find((u) => u.email === email) ?? null;
  }

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
  if (expected !== user.passwordHash) throw new Error('E-mail veya şifre hatalı.');

  return user;
}
