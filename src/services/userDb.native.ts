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

export type UserApiCredentialsRecord = {
  userId: string;
  apiKey: string;
  apiSecret: string;
  updatedAtMs: number;
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
function resolveApiBaseUrl(): string {
  const env = String(process.env.EXPO_PUBLIC_API_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');

  if (Platform.OS === 'web') {
    const g = globalThis as unknown as { location?: { protocol?: string; hostname?: string } };
    const protocol = g.location?.protocol || 'http:';
    const hostname = g.location?.hostname || 'localhost';
    const host = hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return `${protocol}//${hostname}:3001`;
    return `${protocol}//${hostname}/api`;
  }

  if (Platform.OS === 'android') return 'http://10.0.2.2:3001';
  return 'http://localhost:3001';
}

const API_BASE_URL = resolveApiBaseUrl();
let apiUnavailableUntilMs = 0;
let apiFailureCount = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const maxAttempts = 3;
  const now = Date.now();
  if (now < apiUnavailableUntilMs) {
    throw new Error('Sunucuya bağlanılamadı.');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
      if (attempt < maxAttempts) {
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      apiFailureCount = Math.min(8, apiFailureCount + 1);
      apiUnavailableUntilMs =
        Date.now() + Math.min(60_000, 1000 * 2 ** (apiFailureCount - 1));
      throw new Error('Sunucuya bağlanılamadı.');
    }

    if (res.ok) {
      apiFailureCount = 0;
      apiUnavailableUntilMs = 0;
      return (await res.json()) as T;
    }
    const msg = await readErrorMessage(res);
    if (attempt < maxAttempts && res.status >= 500) {
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(msg);
  }

  throw new Error('Sunucuya bağlanılamadı.');
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

export async function getUserReports(userId: string, params?: { sinceMs?: number }): Promise<TradeReportRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];
  const sinceMsRaw = params?.sinceMs;
  const sinceMs = Number.isFinite(Number(sinceMsRaw)) ? Math.max(0, Math.trunc(Number(sinceMsRaw))) : null;
  const qs = sinceMs === null ? '' : `?sinceMs=${encodeURIComponent(String(sinceMs))}`;
  return await apiRequest<TradeReportRecord[]>(`/users/${encodeURIComponent(trimmedUserId)}/reports${qs}`, {
    method: 'GET',
  });
}

export async function deleteUserReports(userId: string): Promise<void> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  await apiRequest<{ ok: true }>(`/users/${encodeURIComponent(trimmedUserId)}/reports`, { method: 'DELETE' });
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

export async function getUserApiCredentials(userId: string): Promise<UserApiCredentialsRecord | null> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return null;
  return await apiRequest<UserApiCredentialsRecord | null>(
    `/users/${encodeURIComponent(trimmedUserId)}/api-credentials`,
    { method: 'GET' },
  );
}

export async function upsertUserApiCredentials(params: {
  userId: string;
  apiKey: string;
  apiSecret: string;
}): Promise<void> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  await apiRequest<{ ok: true }>(`/users/${encodeURIComponent(trimmedUserId)}/api-credentials`, {
    method: 'PUT',
    body: JSON.stringify({ apiKey: params.apiKey, apiSecret: params.apiSecret }),
  });
}
