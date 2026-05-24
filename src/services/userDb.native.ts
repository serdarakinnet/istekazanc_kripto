import { Platform } from 'react-native';

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
const DEFAULT_API_BASE_URL =
  Platform.OS === 'web'
    ? 'http://localhost:3001'
    : Platform.OS === 'android'
      ? 'http://10.0.2.2:3001'
      : 'http://localhost:3001';

const API_BASE_URL = String(process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    const msg = typeof data?.error === 'string' ? data.error : null;
    if (msg) return msg;
  } catch {
  }

  try {
    const text = await res.text();
    if (text) return text;
  } catch {
  }

  return `HTTP ${res.status}`;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new Error('Sunucuya bağlanılamadı.');
  }

  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function initUserDb(): Promise<void> {
  return;
}

export async function createUser(params: CreateUserParams): Promise<UserRecord> {
  const data = await apiRequest<{ id: string; email: string; displayName: string | null; createdAtMs?: number }>(
    '/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({
        email: params.email,
        password: params.password,
        displayName: params.displayName,
      }),
    },
  );

  return {
    id: data.id,
    email: data.email,
    displayName: data.displayName ?? null,
    passwordHash: '',
    passwordSalt: '',
    createdAtMs: Number.isFinite(Number(data.createdAtMs)) ? Number(data.createdAtMs) : Date.now(),
  };
}

export async function getUserByEmail(emailInput: string): Promise<UserRecord | null> {
  void emailInput;
  return null;
}

export async function verifyLogin(params: VerifyLoginParams): Promise<UserRecord> {
  const data = await apiRequest<{ id: string; email: string; displayName: string | null; createdAtMs?: number }>(
    '/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email: params.email, password: params.password }),
    },
  );

  return {
    id: data.id,
    email: data.email,
    displayName: data.displayName ?? null,
    passwordHash: '',
    passwordSalt: '',
    createdAtMs: Number.isFinite(Number(data.createdAtMs)) ? Number(data.createdAtMs) : Date.now(),
  };
}

export async function getUserSettings(userId: string): Promise<UserSettingsRecord | null> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return null;
  return await apiRequest<UserSettingsRecord | null>(`/users/${encodeURIComponent(trimmedUserId)}/settings`, {
    method: 'GET',
  });
}

export async function upsertUserSettings(params: {
  userId: string;
  autoTradeEnabled: boolean;
  minRiskReward: number;
}): Promise<UserSettingsRecord> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  return await apiRequest<UserSettingsRecord>(`/users/${encodeURIComponent(trimmedUserId)}/settings`, {
    method: 'PUT',
    body: JSON.stringify({
      autoTradeEnabled: params.autoTradeEnabled,
      minRiskReward: params.minRiskReward,
    }),
  });
}

export async function getUserPositions(userId: string): Promise<StoredPositionRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];
  return await apiRequest<StoredPositionRecord[]>(`/users/${encodeURIComponent(trimmedUserId)}/positions`, {
    method: 'GET',
  });
}

export async function replaceUserPositions(params: {
  userId: string;
  positions: Array<{ id: string; openedAtMs: number; payload: unknown }>;
}): Promise<void> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  await apiRequest<{ ok: true }>(`/users/${encodeURIComponent(trimmedUserId)}/positions`, {
    method: 'PUT',
    body: JSON.stringify({ positions: params.positions }),
  });
}

export async function getUserReports(userId: string): Promise<TradeReportRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];
  return await apiRequest<TradeReportRecord[]>(`/users/${encodeURIComponent(trimmedUserId)}/reports`, {
    method: 'GET',
  });
}

export async function appendUserReports(params: {
  userId: string;
  reports: Array<Omit<TradeReportRecord, 'userId' | 'createdAtMs'>>;
}): Promise<void> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  if (params.reports.length === 0) return;
  await apiRequest<{ ok: true }>(`/users/${encodeURIComponent(trimmedUserId)}/reports`, {
    method: 'POST',
    body: JSON.stringify({ reports: params.reports }),
  });
}
