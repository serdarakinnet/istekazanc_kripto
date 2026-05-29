import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

type StorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

function isNodeRuntime(): boolean {
  return Boolean(
    typeof process !== 'undefined' &&
      typeof process.versions === 'object' &&
      process.versions != null &&
      typeof (process.versions as { node?: unknown }).node === 'string',
  );
}

function getWebStorage(): StorageLike | null {
  const w = globalThis as unknown as { localStorage?: Storage };
  const ls = w.localStorage;
  if (!ls) return null;
  return {
    getItem: async (key) => {
      try {
        const v = ls.getItem(key);
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    },
    setItem: async (key, value) => {
      ls.setItem(key, value);
    },
    removeItem: async (key) => {
      ls.removeItem(key);
    },
  };
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => (map.has(key) ? map.get(key)! : null),
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
}

function getAuthStorage(): StorageLike {
  const web = getWebStorage();
  if (web) return web;
  if (isNodeRuntime()) return createMemoryStorage();
  const mod = require('@react-native-async-storage/async-storage') as { default?: StorageLike };
  const storage = mod?.default;
  if (!storage) return createMemoryStorage();
  return storage;
}

export function hasSupabaseEnv(): boolean {
  const supabaseUrl = String(process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
  const supabaseAnonKey = String(
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
  ).trim();
  return Boolean(supabaseUrl && supabaseAnonKey);
}

export function getSupabaseClient(): SupabaseClient {
  if (cached) return cached;

  const supabaseUrl = String(process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
  const supabaseAnonKey = String(
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
  ).trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase env eksik: EXPO_PUBLIC_SUPABASE_URL ve EXPO_PUBLIC_SUPABASE_ANON_KEY gerekli.');
  }

  const detectSessionInUrl = Boolean(
    typeof window !== 'undefined' &&
      typeof document !== 'undefined' &&
      typeof (globalThis as unknown as { location?: unknown }).location !== 'undefined',
  );

  cached = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      storage: getAuthStorage(),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl,
    },
  });

  return cached;
}
