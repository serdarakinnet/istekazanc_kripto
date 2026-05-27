import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

let cached: SupabaseClient | null = null;

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

  cached = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      storage: AsyncStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: Platform.OS === 'web',
    },
  });

  return cached;
}
