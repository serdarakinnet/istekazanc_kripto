import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

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

const AS_KEY = 'bist_users_v1';
const AS_SETTINGS_KEY = 'bist_user_settings_v1';
const AS_POSITIONS_KEY = 'bist_user_positions_v1';
const AS_REPORTS_KEY = 'bist_user_reports_v1';

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

async function loadJsonMap<T>(key: string): Promise<Record<string, T>> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, T>;
}

async function saveJsonMap<T>(key: string, map: Record<string, T>): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(map));
}

export async function initUserDb(): Promise<void> {
  return;
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

  const users = await loadUsersFromAsyncStorage();
  const exists = users.some((u) => u.email === email);
  if (exists) throw new Error('Bu e-mail zaten kayıtlı.');
  await saveUsersToAsyncStorage([record, ...users]);
  return record;
}

export async function getUserByEmail(emailInput: string): Promise<UserRecord | null> {
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) return null;

  const users = await loadUsersFromAsyncStorage();
  return users.find((u) => u.email === email) ?? null;
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

export async function getUserSettings(userId: string): Promise<UserSettingsRecord | null> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return null;

  const map = await loadJsonMap<UserSettingsRecord>(AS_SETTINGS_KEY);
  return map[trimmedUserId] ?? null;
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

  const map = await loadJsonMap<UserSettingsRecord>(AS_SETTINGS_KEY);
  map[trimmedUserId] = record;
  await saveJsonMap(AS_SETTINGS_KEY, map);
  return record;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getUserPositions(userId: string): Promise<StoredPositionRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];

  const map = await loadJsonMap<StoredPositionRecord[]>(AS_POSITIONS_KEY);
  const list = map[trimmedUserId];
  return Array.isArray(list) ? list : [];
}

export async function replaceUserPositions(params: { userId: string; positions: Array<{ id: string; openedAtMs: number; payload: unknown }> }): Promise<void> {
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

  const map = await loadJsonMap<StoredPositionRecord[]>(AS_POSITIONS_KEY);
  map[trimmedUserId] = normalized;
  await saveJsonMap(AS_POSITIONS_KEY, map);
}

export async function getUserReports(userId: string): Promise<TradeReportRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];

  const map = await loadJsonMap<TradeReportRecord[]>(AS_REPORTS_KEY);
  const list = map[trimmedUserId];
  if (!Array.isArray(list)) return [];
  return list.slice().sort((a, b) => Number(b.closedAtMs) - Number(a.closedAtMs));
}

export async function appendUserReports(params: {
  userId: string;
  reports: Array<Omit<TradeReportRecord, 'userId' | 'createdAtMs'>>;
}): Promise<void> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  if (params.reports.length === 0) return;

  const nowMs = Date.now();
  const existing = await getUserReports(trimmedUserId);
  const byId = new Map(existing.map((r) => [r.id, r] as const));

  for (const r of params.reports) {
    byId.set(r.id, {
      ...r,
      userId: trimmedUserId,
      createdAtMs: nowMs,
    });
  }

  const merged = Array.from(byId.values()).sort((a, b) => b.closedAtMs - a.closedAtMs);
  const map = await loadJsonMap<TradeReportRecord[]>(AS_REPORTS_KEY);
  map[trimmedUserId] = merged;
  await saveJsonMap(AS_REPORTS_KEY, map);
}
