import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

type ExpoAppConfig = {
  expo?: {
    android?: {
      permissions?: unknown;
    };
  };
};

test('android permissions: ensure INTERNET is present when permissions list is configured', () => {
  const appJsonPath = path.resolve(process.cwd(), 'app.json');
  const raw = fs.readFileSync(appJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as ExpoAppConfig;

  const permissions = parsed?.expo?.android?.permissions;
  assert.ok(Array.isArray(permissions), 'expo.android.permissions must be an array');

  const list = (permissions as unknown[]).filter((x): x is string => typeof x === 'string');
  const set = new Set(list.map((x) => x.trim().toUpperCase()).filter(Boolean));

  assert.ok(set.has('INTERNET'), 'INTERNET permission must be included for network access');
});
