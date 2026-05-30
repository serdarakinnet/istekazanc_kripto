import { getSupabaseClient, hasSupabaseEnv } from './supabaseClient';

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
  customStrategyCode?: string;
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

function normalizeEmailInput(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function mapSupabaseAuthErrorMessage(message: string): string {
  const msg = String(message || '').trim();
  if (!msg) return 'Kimlik doğrulama hatası.';

  if (/invalid login credentials/i.test(msg)) {
    return 'E-mail veya şifre hatalı. Eğer bu hesabı eski sistemde (API üzerinden) oluşturduysan, Supabase Auth’a taşınmadığı için yeniden kayıt olman gerekir.';
  }

  if (/email not confirmed/i.test(msg)) {
    return 'E-posta doğrulanmamış. Gelen kutunu (Spam/Promosyon dahil) kontrol et, doğrulama linkine tıkla ve sonra tekrar dene.';
  }

  if (/user already registered/i.test(msg) || /already registered/i.test(msg)) {
    return 'Bu e-mail ile zaten hesap var. Giriş ekranından e-mail ve şifre ile giriş yap.';
  }

  return msg;
}

function requireSupabase() {
  if (!hasSupabaseEnv()) {
    throw new Error('Supabase env eksik: EXPO_PUBLIC_SUPABASE_URL ve EXPO_PUBLIC_SUPABASE_ANON_KEY gerekli.');
  }
  return getSupabaseClient();
}

async function ensureAppUserRow(params: { id: string; email: string; displayName?: string | null }): Promise<void> {
  const supabase = requireSupabase();
  const now = Date.now();
  const { error } = await supabase.from('users').upsert(
    {
      id: params.id,
      email: params.email,
      display_name: params.displayName ?? null,
      password_hash: 'supabase',
      password_salt: 'supabase',
      created_at_ms: now,
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error(error.message);
}

export const __test = {
  normalizeEmailInput,
  mapSupabaseAuthErrorMessage,
};

async function getDisplayNameFromUsersTable(userId: string): Promise<string | null> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('users')
    .select('display_name')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const v = (data as { display_name?: unknown } | null)?.display_name;
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

export async function getCurrentUser(): Promise<Pick<UserRecord, 'id' | 'email' | 'displayName'> | null> {
  const supabase = requireSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  const user = data.user;
  if (!user?.id || !user.email) return null;
  const displayName = await getDisplayNameFromUsersTable(user.id).catch(() => null);
  return { id: user.id, email: user.email, displayName };
}

export async function signOutUser(): Promise<void> {
  const supabase = requireSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function initUserDb(): Promise<void> {
  return;
}

export async function createUser(params: CreateUserParams): Promise<UserRecord> {
  const supabase = requireSupabase();
  const email = normalizeEmailInput(params.email);
  const password = params.password;
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { displayName: params.displayName ?? null } },
  });
  if (signUpError) throw new Error(mapSupabaseAuthErrorMessage(signUpError.message));

  const authUser = signUpData.user;
  if (!authUser?.id || !authUser.email) throw new Error('Kullanıcı oluşturulamadı.');

  if (!signUpData.session) {
    await ensureAppUserRow({ id: authUser.id, email: authUser.email, displayName: params.displayName ?? null });
    throw new Error(
      'E-posta doğrulanmamış. Gelen kutunu (Spam/Promosyon dahil) kontrol et, doğrulama linkine tıkla ve sonra tekrar dene. E-posta gelmediyse doğrulama mailini yeniden gönder.',
    );
  }

  await ensureAppUserRow({ id: authUser.id, email: authUser.email, displayName: params.displayName ?? null });

  const displayName = await getDisplayNameFromUsersTable(authUser.id).catch(() => params.displayName ?? null);
  return {
    id: authUser.id,
    email: authUser.email,
    displayName,
    passwordHash: '',
    passwordSalt: '',
    createdAtMs: Date.now(),
  };
}

export async function resendSignupConfirmationEmail(emailInput: string): Promise<void> {
  const supabase = requireSupabase();
  const email = normalizeEmailInput(emailInput);
  const { error } = await supabase.auth.resend({ type: 'signup', email });
  if (error) throw new Error(mapSupabaseAuthErrorMessage(error.message));
}

export async function getUserByEmail(emailInput: string): Promise<UserRecord | null> {
  void emailInput;
  return null;
}

export async function verifyLogin(params: VerifyLoginParams): Promise<UserRecord> {
  const supabase = requireSupabase();
  const email = normalizeEmailInput(params.email);
  const password = params.password;
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(mapSupabaseAuthErrorMessage(signInError.message));
  const authUser = signInData.user;
  if (!authUser?.id || !authUser.email) throw new Error('Giriş başarısız.');

  await ensureAppUserRow({ id: authUser.id, email: authUser.email, displayName: null });
  const displayName = await getDisplayNameFromUsersTable(authUser.id).catch(() => null);
  return {
    id: authUser.id,
    email: authUser.email,
    displayName,
    passwordHash: '',
    passwordSalt: '',
    createdAtMs: Date.now(),
  };
}

export async function getUserSettings(userId: string): Promise<UserSettingsRecord | null> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return null;
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('user_settings')
    .select('user_id, auto_trade_enabled, min_risk_reward, custom_strategy_code, updated_at_ms')
    .eq('user_id', trimmedUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    userId: String((data as { user_id: unknown }).user_id),
    autoTradeEnabled: Boolean((data as { auto_trade_enabled: unknown }).auto_trade_enabled),
    minRiskReward: Number((data as { min_risk_reward: unknown }).min_risk_reward),
    customStrategyCode:
      typeof (data as { custom_strategy_code?: unknown }).custom_strategy_code === 'string'
        ? String((data as { custom_strategy_code: unknown }).custom_strategy_code)
        : undefined,
    updatedAtMs: Number((data as { updated_at_ms: unknown }).updated_at_ms),
  };
}

export async function upsertUserSettings(params: {
  userId: string;
  autoTradeEnabled: boolean;
  minRiskReward: number;
  customStrategyCode?: string;
}): Promise<UserSettingsRecord> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  const supabase = requireSupabase();
  const updatedAtMs = Date.now();
  const { data, error } = await supabase
    .from('user_settings')
    .upsert(
      {
        user_id: trimmedUserId,
        auto_trade_enabled: params.autoTradeEnabled,
        min_risk_reward: params.minRiskReward,
        custom_strategy_code: params.customStrategyCode ?? null,
        updated_at_ms: updatedAtMs,
      },
      { onConflict: 'user_id' },
    )
    .select('user_id, auto_trade_enabled, min_risk_reward, custom_strategy_code, updated_at_ms')
    .single();
  if (error) throw new Error(error.message);
  return {
    userId: String((data as { user_id: unknown }).user_id),
    autoTradeEnabled: Boolean((data as { auto_trade_enabled: unknown }).auto_trade_enabled),
    minRiskReward: Number((data as { min_risk_reward: unknown }).min_risk_reward),
    customStrategyCode:
      typeof (data as { custom_strategy_code?: unknown }).custom_strategy_code === 'string'
        ? String((data as { custom_strategy_code: unknown }).custom_strategy_code)
        : undefined,
    updatedAtMs: Number((data as { updated_at_ms: unknown }).updated_at_ms),
  };
}

export async function getUserPositions(userId: string): Promise<StoredPositionRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('positions')
    .select('id, user_id, opened_at_ms, payload_json, updated_at_ms')
    .eq('user_id', trimmedUserId)
    .order('opened_at_ms', { ascending: false });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => ({
    id: String((r as { id: unknown }).id),
    userId: String((r as { user_id: unknown }).user_id),
    openedAtMs: Number((r as { opened_at_ms: unknown }).opened_at_ms),
    payloadJson: JSON.stringify((r as { payload_json: unknown }).payload_json ?? {}),
    updatedAtMs: Number((r as { updated_at_ms: unknown }).updated_at_ms),
  }));
}

export async function replaceUserPositions(params: { userId: string; positions: Array<{ id: string; openedAtMs: number; payload: unknown }> }): Promise<void> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  const supabase = requireSupabase();
  const updatedAtMs = Date.now();
  const { error: delError } = await supabase.from('positions').delete().eq('user_id', trimmedUserId);
  if (delError) throw new Error(delError.message);
  if (params.positions.length === 0) return;
  const rows = params.positions.map((p) => ({
    id: p.id,
    user_id: trimmedUserId,
    opened_at_ms: p.openedAtMs,
    payload_json: p.payload,
    updated_at_ms: updatedAtMs,
  }));
  const { error: insError } = await supabase.from('positions').insert(rows);
  if (insError) throw new Error(insError.message);
}

export async function getUserReports(userId: string, params?: { sinceMs?: number }): Promise<TradeReportRecord[]> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return [];
  const supabase = requireSupabase();
  const sinceMsRaw = params?.sinceMs;
  const sinceMs = Number.isFinite(Number(sinceMsRaw)) ? Math.max(0, Math.trunc(Number(sinceMsRaw))) : null;
  let q = supabase
    .from('trade_reports')
    .select('id, user_id, symbol, opened_at_ms, closed_at_ms, entry, exit, outcome, pnl_pct, risk_reward_at_entry, created_at_ms')
    .eq('user_id', trimmedUserId)
    .order('closed_at_ms', { ascending: false });
  if (sinceMs !== null) q = q.gte('closed_at_ms', sinceMs);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => ({
    id: String((r as { id: unknown }).id),
    userId: String((r as { user_id: unknown }).user_id),
    symbol: String((r as { symbol: unknown }).symbol),
    openedAtMs: Number((r as { opened_at_ms: unknown }).opened_at_ms),
    closedAtMs: Number((r as { closed_at_ms: unknown }).closed_at_ms),
    entry: Number((r as { entry: unknown }).entry),
    exit: Number((r as { exit: unknown }).exit),
    outcome: (r as { outcome: unknown }).outcome === 'TP' ? 'TP' : 'SL',
    pnlPct: Number((r as { pnl_pct: unknown }).pnl_pct),
    riskRewardAtEntry: Number((r as { risk_reward_at_entry: unknown }).risk_reward_at_entry),
    createdAtMs: Number((r as { created_at_ms: unknown }).created_at_ms),
  }));
}

export async function deleteUserReports(userId: string): Promise<void> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  const supabase = requireSupabase();
  const { error } = await supabase.from('trade_reports').delete().eq('user_id', trimmedUserId);
  if (error) throw new Error(error.message);
}

export async function appendUserReports(params: {
  userId: string;
  reports: Array<Omit<TradeReportRecord, 'userId' | 'createdAtMs'>>;
}): Promise<void> {
  const trimmedUserId = params.userId.trim();
  if (!trimmedUserId) throw new Error('Kullanıcı bulunamadı.');
  if (params.reports.length === 0) return;
  const supabase = requireSupabase();
  const createdAtMs = Date.now();
  const rows = params.reports.map((r) => ({
    id: r.id,
    user_id: trimmedUserId,
    symbol: r.symbol,
    opened_at_ms: r.openedAtMs,
    closed_at_ms: r.closedAtMs,
    entry: r.entry,
    exit: r.exit,
    outcome: r.outcome,
    pnl_pct: r.pnlPct,
    risk_reward_at_entry: r.riskRewardAtEntry,
    created_at_ms: createdAtMs,
  }));
  const { error } = await supabase.from('trade_reports').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}
