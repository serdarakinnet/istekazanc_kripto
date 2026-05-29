import assert from 'node:assert/strict';
import test from 'node:test';

import { __test } from './userDb';

test('auth error mapping: invalid login credentials', () => {
  const mapped = __test.mapSupabaseAuthErrorMessage('Invalid login credentials');
  assert.match(mapped, /E-mail veya şifre hatalı/i);
  assert.match(mapped, /Supabase Auth/i);
});

test('auth error mapping: email not confirmed', () => {
  const mapped = __test.mapSupabaseAuthErrorMessage('Email not confirmed');
  assert.match(mapped, /doğrulanmamış/i);
});

test('email normalize: trims and lowercases', () => {
  assert.equal(__test.normalizeEmailInput('  TeSt@Example.Com  '), 'test@example.com');
});
