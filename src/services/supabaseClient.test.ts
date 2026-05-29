import assert from 'node:assert/strict';
import test from 'node:test';

import { getSupabaseClient, hasSupabaseEnv } from './supabaseClient';

test('supabase env: hasSupabaseEnv and getSupabaseClient behavior', () => {
  const prevUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const prevKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const prevAlt = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  try {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    assert.equal(hasSupabaseEnv(), false);
    assert.throws(() => getSupabaseClient(), { message: /Supabase env eksik/i });

    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.test';

    assert.equal(hasSupabaseEnv(), true);
    const a = getSupabaseClient();
    const b = getSupabaseClient();
    assert.equal(a, b);
  } finally {
    if (prevUrl === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    else process.env.EXPO_PUBLIC_SUPABASE_URL = prevUrl;

    if (prevKey === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = prevKey;

    if (prevAlt === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    else process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = prevAlt;
  }
});
