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
import { createUser, verifyLogin } from '../services/userDb';

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
  clearReports: () => void;
  updateSettings: (partial: Partial<AppSettings>) => void;
};

const DEFAULT_SETTINGS: AppSettings = {
  autoTradeEnabled: false,
  minRiskReward: 1.5,
};

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
        set({
          isSignedIn: true,
          user: { id: user.id, email: user.email, displayName: user.displayName },
        });
      },

      signUpWithEmail: async ({ email, password, displayName }) => {
        const user = await createUser({ email, password, displayName });
        set({
          isSignedIn: true,
          user: { id: user.id, email: user.email, displayName: user.displayName },
        });
      },

      signOut: () => {
        set({ isSignedIn: false, user: null });
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
      },

      appendReports: (items) => {
        if (items.length === 0) return;
        const current = get().reports;
        const next = [...items, ...current].slice(0, 500);
        set({ reports: next });
      },

      clearReports: () => {
        set({ reports: [] });
      },

      updateSettings: (partial) => {
        set({ settings: { ...get().settings, ...partial } });
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
        reports: state.reports,
        settings: state.settings,
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
