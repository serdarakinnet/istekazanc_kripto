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
        const credentials = await getApiCredentials();
        set({ apiCredentials: credentials, hasSecureHydrated: true });
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
              autoTradeEnabled: settingsRow.autoTradeEnabled,
              minRiskReward: settingsRow.minRiskReward,
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
        }
        const mergedReports = Array.from(reportById.values()).sort(
          (a, b) => b.closedAtMs - a.closedAtMs,
        );

        set({
          isSignedIn: true,
          user: { id: user.id, email: user.email, displayName: user.displayName },
          settings,
          positions,
          watchlist: positions.length > 0 ? positions : get().watchlist,
          reports: mergedReports,
        });
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
          void replaceUserPositions({
            userId,
            positions: items.map((p) => ({
              id: makeLocalId(`pos_${p.symbol}`),
              openedAtMs: p.openedAtMs,
              payload: p,
            })),
          });
        }
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
          void appendUserReports({
            userId,
            reports: items.map((r) => ({
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
          void upsertUserSettings({
            userId,
            autoTradeEnabled: next.autoTradeEnabled,
            minRiskReward: next.minRiskReward,
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
