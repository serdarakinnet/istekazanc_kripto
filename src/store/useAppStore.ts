import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ApiCredentials } from '../services/secureStore';
import type { ScannedCandidate } from '../services/tradingEngine';
import type { UserRecord } from '../services/userDb';
import {
  clearApiCredentials,
  getApiCredentials,
  setApiCredentials,
} from '../services/secureStore';
import {
  appendUserReports,
  createUser,
  getUserPositions,
  getUserReports,
  getUserSettings,
  replaceUserPositions,
  upsertUserSettings,
  verifyLogin,
} from '../services/userDb';

export type AppSettings = {
  autoTradeEnabled: boolean;
  minRiskReward: number;
};

export type TradeOutcome = 'TP' | 'SL';

export type TradeReport = {
  id: string;
  symbol: string;
  openedAtMs: number;
  closedAtMs: number;
  entry: number;
  exit: number;
  outcome: TradeOutcome;
  pnlPct: number;
  riskRewardAtEntry: number;
};

export type ActivePosition = ScannedCandidate & {
  openedAtMs: number;
};

type AppState = {
  hasLocalHydrated: boolean;
  hasSecureHydrated: boolean;
  isSignedIn: boolean;
  user: Pick<UserRecord, 'id' | 'email' | 'displayName'> | null;
  apiCredentials: ApiCredentials | null;
  watchlist: ScannedCandidate[];
  lastScanMs: number | null;
  positions: ActivePosition[];
  reports: TradeReport[];
  recentlyClosedSymbols: Record<string, number>;
  settings: AppSettings;
  setLocalHydrated: (hydrated: boolean) => void;
  hydrateSecure: () => Promise<void>;
  signInWithEmail: (params: { email: string; password: string }) => Promise<void>;
  signUpWithEmail: (params: { email: string; password: string; displayName?: string }) => Promise<void>;
  signOut: () => void;
  saveApiCredentials: (credentials: ApiCredentials) => Promise<void>;
  forgetApiCredentials: () => Promise<void>;
  setWatchlist: (items: ScannedCandidate[], asOfMs: number) => void;
  setPositions: (items: ActivePosition[], asOfMs: number) => void;
  closePositionManually: (params: { symbol: string }) => void;
  appendReports: (items: TradeReport[]) => void;
  addRecentlyClosedSymbols: (symbols: string[], atMs: number) => void;
  updateSettings: (partial: Partial<AppSettings>) => void;
};

const DEFAULT_SETTINGS: AppSettings = {
  autoTradeEnabled: false,
  minRiskReward: 1.5,
};

function makeLocalId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

type PendingSync = {
  settings?: AppSettings;
  positions?: ActivePosition[];
  reports?: TradeReport[];
};

const PENDING_SYNC_KEY = 'bist_pending_sync_v1';

async function loadPendingSyncMap(): Promise<Record<string, PendingSync>> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_SYNC_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, PendingSync>;
  } catch {
    return {};
  }
}

async function savePendingSyncMap(map: Record<string, PendingSync>): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(map));
  } catch {
  }
}

function mergeReportsById(existing: TradeReport[], incoming: TradeReport[]): TradeReport[] {
  const byId = new Map<string, TradeReport>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return Array.from(byId.values()).sort((a, b) => b.closedAtMs - a.closedAtMs);
}

async function queuePendingSync(userId: string, patch: PendingSync): Promise<void> {
  const id = userId.trim();
  if (!id) return;
  const map = await loadPendingSyncMap();
  const current = map[id] ?? {};
  const next: PendingSync = { ...current, ...patch };
  if (patch.reports && patch.reports.length > 0) {
    next.reports = mergeReportsById(current.reports ?? [], patch.reports);
  }
  map[id] = next;
  await savePendingSyncMap(map);
}

async function clearPendingFields(userId: string, fields: Array<keyof PendingSync>): Promise<void> {
  const id = userId.trim();
  if (!id) return;
  const map = await loadPendingSyncMap();
  const current = map[id];
  if (!current) return;
  const next: PendingSync = { ...current };
  for (const f of fields) {
    delete (next as Record<string, unknown>)[String(f)];
  }
  if (!next.settings && !next.positions && (!next.reports || next.reports.length === 0)) {
    delete map[id];
  } else {
    map[id] = next;
  }
  await savePendingSyncMap(map);
}

async function readPendingForUser(userId: string): Promise<PendingSync | null> {
  const id = userId.trim();
  if (!id) return null;
  const map = await loadPendingSyncMap();
  return map[id] ?? null;
}

async function flushPendingToDb(params: {
  userId: string;
  pending: PendingSync;
  makePositionId: (symbol: string) => string;
}): Promise<void> {
  const userId = params.userId.trim();
  if (!userId) return;

  if (params.pending.settings) {
    try {
      await upsertUserSettings({
        userId,
        autoTradeEnabled: params.pending.settings.autoTradeEnabled,
        minRiskReward: params.pending.settings.minRiskReward,
      });
      await clearPendingFields(userId, ['settings']);
    } catch {
    }
  }

  if (params.pending.positions) {
    try {
      await replaceUserPositions({
        userId,
        positions: params.pending.positions.map((p) => ({
          id: params.makePositionId(p.symbol),
          openedAtMs: p.openedAtMs,
          payload: p,
        })),
      });
      await clearPendingFields(userId, ['positions']);
    } catch {
    }
  }

  if (params.pending.reports && params.pending.reports.length > 0) {
    try {
      await appendUserReports({
        userId,
        reports: params.pending.reports.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          openedAtMs: r.openedAtMs,
          closedAtMs: r.closedAtMs,
          entry: r.entry,
          exit: r.exit,
          outcome: r.outcome,
          pnlPct: r.pnlPct,
          riskRewardAtEntry: r.riskRewardAtEntry,
        })),
      });
      await clearPendingFields(userId, ['reports']);
    } catch {
    }
  }
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      hasLocalHydrated: false,
      hasSecureHydrated: false,
      isSignedIn: false,
      user: null,
      apiCredentials: null,
      watchlist: [],
      lastScanMs: null,
      positions: [],
      reports: [],
      recentlyClosedSymbols: {},
      settings: DEFAULT_SETTINGS,

      setLocalHydrated: (hydrated) => {
        set({ hasLocalHydrated: hydrated });
      },

      hydrateSecure: async () => {
        try {
          const credentials = await getApiCredentials();
          set({ apiCredentials: credentials, hasSecureHydrated: true });
        } catch {
          set({ apiCredentials: null, hasSecureHydrated: true });
        }
      },

      signInWithEmail: async ({ email, password }) => {
        const user = await verifyLogin({ email, password });
        const [settingsRow, positionsRows, reportsRows] = await Promise.all([
          getUserSettings(user.id),
          getUserPositions(user.id),
          getUserReports(user.id),
        ]);

        const settings: AppSettings = settingsRow
          ? {
              autoTradeEnabled: Boolean(settingsRow.autoTradeEnabled),
              minRiskReward:
                Number.isFinite(Number(settingsRow.minRiskReward)) && Number(settingsRow.minRiskReward) > 0
                  ? Number(settingsRow.minRiskReward)
                  : DEFAULT_SETTINGS.minRiskReward,
            }
          : DEFAULT_SETTINGS;

        const positions: ActivePosition[] = positionsRows
          .map((row) => {
            try {
              const parsed = JSON.parse(row.payloadJson) as unknown;
              if (!parsed || typeof parsed !== 'object') return null;
              const obj = parsed as Record<string, unknown>;
              const symbol = obj['symbol'];
              if (typeof symbol !== 'string' || symbol.length === 0) return null;
              return { ...(obj as unknown as ActivePosition), openedAtMs: row.openedAtMs };
            } catch {
              return null;
            }
          })
          .filter((p): p is ActivePosition => Boolean(p));

        const existingReports = get().reports;
        const reportById = new Map<string, TradeReport>();
        for (const r of reportsRows) {
          reportById.set(r.id, {
            id: r.id,
            symbol: r.symbol,
            openedAtMs: r.openedAtMs,
            closedAtMs: r.closedAtMs,
            entry: r.entry,
            exit: r.exit,
            outcome: r.outcome,
            pnlPct: r.pnlPct,
            riskRewardAtEntry: r.riskRewardAtEntry,
          });
        }
        const toPersist: TradeReport[] = [];
        for (const r of existingReports) {
          if (!reportById.has(r.id)) {
            reportById.set(r.id, r);
            toPersist.push(r);
          }
        }
        if (toPersist.length > 0) {
          try {
            await appendUserReports({
              userId: user.id,
              reports: toPersist.map((r) => ({
                id: r.id,
                symbol: r.symbol,
                openedAtMs: r.openedAtMs,
                closedAtMs: r.closedAtMs,
                entry: r.entry,
                exit: r.exit,
                outcome: r.outcome,
                pnlPct: r.pnlPct,
                riskRewardAtEntry: r.riskRewardAtEntry,
              })),
            });
          } catch {
            await queuePendingSync(user.id, { reports: toPersist });
          }
        }
        const mergedReports = Array.from(reportById.values()).sort(
          (a, b) => b.closedAtMs - a.closedAtMs,
        );

        const pending = await readPendingForUser(user.id);
        const effectiveSettings = pending?.settings ? pending.settings : settings;
        const effectivePositions = pending?.positions ? pending.positions : positions;
        const effectiveReports =
          pending?.reports && pending.reports.length > 0
            ? mergeReportsById(mergedReports, pending.reports)
            : mergedReports;

        set({
          isSignedIn: true,
          user: { id: user.id, email: user.email, displayName: user.displayName },
          settings: effectiveSettings,
          positions: effectivePositions,
          watchlist: effectivePositions.length > 0 ? effectivePositions : get().watchlist,
          reports: effectiveReports,
        });

        if (pending) {
          void flushPendingToDb({
            userId: user.id,
            pending,
            makePositionId: (symbol) => makeLocalId(`pos_${symbol}`),
          });
        }
      },

      signUpWithEmail: async ({ email, password, displayName }) => {
        const user = await createUser({ email, password, displayName });
        await upsertUserSettings({
          userId: user.id,
          autoTradeEnabled: DEFAULT_SETTINGS.autoTradeEnabled,
          minRiskReward: DEFAULT_SETTINGS.minRiskReward,
        });
        set({
          isSignedIn: true,
          user: { id: user.id, email: user.email, displayName: user.displayName },
          settings: DEFAULT_SETTINGS,
          positions: [],
          watchlist: [],
          lastScanMs: null,
          reports: [],
        });
      },

      signOut: () => {
        const snapshot = get();
        const userId = snapshot.user?.id;
        if (userId) {
          void queuePendingSync(userId, {
            settings: snapshot.settings,
            positions: snapshot.positions,
            reports: snapshot.reports,
          }).then(async () => {
            const pending = await readPendingForUser(userId);
            if (!pending) return;
            await flushPendingToDb({
              userId,
              pending,
              makePositionId: (symbol) => makeLocalId(`pos_${symbol}`),
            });
          });
        }

        set({
          isSignedIn: false,
          user: null,
          watchlist: [],
          lastScanMs: null,
          positions: [],
          reports: [],
          settings: DEFAULT_SETTINGS,
          recentlyClosedSymbols: {},
        });
      },

      saveApiCredentials: async (credentials) => {
        const apiKey = credentials.apiKey.trim();
        const apiSecret = credentials.apiSecret.trim();

        if (!apiKey || !apiSecret) {
          throw new Error('API Key ve Secret Key zorunludur.');
        }

        await setApiCredentials({ apiKey, apiSecret });
        set({ apiCredentials: { apiKey, apiSecret } });
      },

      forgetApiCredentials: async () => {
        await clearApiCredentials();
        set({ apiCredentials: null });

        const signedIn = get().isSignedIn;
        if (signedIn) {
          set({ isSignedIn: false, user: null });
        }
      },

      setWatchlist: (items, asOfMs) => {
        set({ watchlist: items, lastScanMs: asOfMs });
      },

      setPositions: (items, asOfMs) => {
        set({
          positions: items,
          watchlist: items,
          lastScanMs: asOfMs,
        });

        const userId = get().user?.id;
        if (userId) {
          void queuePendingSync(userId, { positions: items }).then(async () => {
            const pending = await readPendingForUser(userId);
            if (!pending?.positions) return;
            try {
              await replaceUserPositions({
                userId,
                positions: pending.positions.map((p) => ({
                  id: makeLocalId(`pos_${p.symbol}`),
                  openedAtMs: p.openedAtMs,
                  payload: p,
                })),
              });
              await clearPendingFields(userId, ['positions']);
            } catch {
            }
          });
        }
      },

      closePositionManually: ({ symbol }) => {
        const state = get();
        const sym = symbol.trim().toUpperCase();
        if (!sym) return;
        if (!state.isSignedIn) return;

        const pos = state.positions.find((p) => p.symbol.trim().toUpperCase() === sym);
        if (!pos) return;

        const nowMs = Date.now();
        state.addRecentlyClosedSymbols([sym], nowMs);

        const remaining = state.positions.filter((p) => p.symbol.trim().toUpperCase() !== sym);
        const keepScanMs = state.lastScanMs ?? nowMs;
        state.setPositions(remaining, keepScanMs);
      },

      appendReports: (items) => {
        if (items.length === 0) return;
        const current = get().reports;
        const byId = new Map<string, TradeReport>();
        for (const r of items) byId.set(r.id, r);
        for (const r of current) {
          if (!byId.has(r.id)) byId.set(r.id, r);
        }
        const next = Array.from(byId.values()).sort((a, b) => b.closedAtMs - a.closedAtMs);
        set({ reports: next });

        const userId = get().user?.id;
        if (userId) {
          void queuePendingSync(userId, { reports: items }).then(async () => {
            const pending = await readPendingForUser(userId);
            if (!pending?.reports || pending.reports.length === 0) return;
            try {
              await appendUserReports({
                userId,
                reports: pending.reports.map((r) => ({
                  id: r.id,
                  symbol: r.symbol,
                  openedAtMs: r.openedAtMs,
                  closedAtMs: r.closedAtMs,
                  entry: r.entry,
                  exit: r.exit,
                  outcome: r.outcome,
                  pnlPct: r.pnlPct,
                  riskRewardAtEntry: r.riskRewardAtEntry,
                })),
              });
              await clearPendingFields(userId, ['reports']);
            } catch {
            }
          });
        }
      },

      addRecentlyClosedSymbols: (symbols, atMs) => {
        if (symbols.length === 0) return;
        const current = get().recentlyClosedSymbols;
        const next: Record<string, number> = { ...current };
        for (const s of symbols) {
          const sym = s.trim().toUpperCase();
          if (!sym) continue;
          next[sym] = atMs;
        }
        const cutoff = atMs - 24 * 60 * 60 * 1000;
        for (const [sym, ms] of Object.entries(next)) {
          if (!Number.isFinite(ms) || ms < cutoff) delete next[sym];
        }
        set({ recentlyClosedSymbols: next });
      },

      updateSettings: (partial) => {
        const next = { ...get().settings, ...partial };
        set({ settings: next });

        const userId = get().user?.id;
        if (userId) {
          void queuePendingSync(userId, { settings: next }).then(async () => {
            const pending = await readPendingForUser(userId);
            if (!pending?.settings) return;
            try {
              await upsertUserSettings({
                userId,
                autoTradeEnabled: pending.settings.autoTradeEnabled,
                minRiskReward: pending.settings.minRiskReward,
              });
              await clearPendingFields(userId, ['settings']);
            } catch {
            }
          });
        }
      },
    }),
    {
      name: 'bist-app',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        isSignedIn: state.isSignedIn,
        user: state.user,
        watchlist: state.watchlist,
        lastScanMs: state.lastScanMs,
        positions: state.positions,
        settings: state.settings,
        recentlyClosedSymbols: state.recentlyClosedSymbols,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setLocalHydrated(true);
      },
    },
  ),
);

export function selectAppReady(state: Pick<AppState, 'hasLocalHydrated' | 'hasSecureHydrated'>): boolean {
  return state.hasLocalHydrated && state.hasSecureHydrated;
}

export function selectAuthPhase(state: Pick<AppState, 'isSignedIn' | 'apiCredentials'>): 'signedOut' | 'needsApiCredentials' | 'ready' {
  if (!state.isSignedIn) return 'signedOut';
  if (!state.apiCredentials) return 'needsApiCredentials';
  return 'ready';
}
