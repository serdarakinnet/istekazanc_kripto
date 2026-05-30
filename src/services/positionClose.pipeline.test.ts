import assert from 'node:assert/strict';
import test from 'node:test';

function ensureWindowStorage() {
  const g = globalThis as unknown as { window?: unknown };
  if (g.window) return;
  const mem = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (mem.has(String(key)) ? mem.get(String(key)) ?? null : null),
    setItem: (key: string, value: string) => {
      mem.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      mem.delete(String(key));
    },
    clear: () => {
      mem.clear();
    },
  };
  (g as unknown as { window: unknown }).window = { localStorage: storage, sessionStorage: storage };
}

test('manual close adds report (XLMTRY) and removes position', async () => {
  ensureWindowStorage();
  const { useAppStore } = require('../store/useAppStore') as typeof import('../store/useAppStore');

  useAppStore.setState(
    {
      isSignedIn: false,
      user: null,
      reportsResetAtMs: 0,
      reportsNeedsRemoteReset: false,
      reports: [],
      positions: [],
      watchlist: [],
      lastScanMs: null,
      scanPool: [],
      scanPoolUpdatedAtMs: null,
      recentlyClosedSymbols: {},
      settings: { autoTradeEnabled: true, minRiskReward: 1.5 },
    },
    false,
  );

  const now = Date.now();
  const position = {
    symbol: 'XLMTRY',
    score: 80,
    scoreBreakdown: {
      breakout: true,
      pullbackReclaim: true,
      volMultOk: true,
      ema21SlopeUp: true,
      flatPenalty: false,
      pumpPenalty: false,
    },
    entry: 1,
    target: 2,
    stop: 0.5,
    riskReward: 2,
    lastPrice: 1.2,
    lastChangePercent: 0,
    ema5: 0,
    ema21: 0,
    ema144: 0,
    volMult: 1,
    openedAtMs: now - 60_000,
  };

  useAppStore.getState().setPositions([position], now);
  useAppStore.getState().closePositionManually({ symbol: 'XLMTRY' });

  const state = useAppStore.getState();
  assert.equal(state.positions.length, 0);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0]?.symbol, 'XLMTRY');
  assert.equal(state.reports[0]?.openedAtMs, position.openedAtMs);
  assert.ok(Number.isFinite(state.reports[0]?.closedAtMs ?? Number.NaN));
});

test('manual close adds report (BTCTRY) even when signed-out', async () => {
  ensureWindowStorage();
  const { useAppStore } = require('../store/useAppStore') as typeof import('../store/useAppStore');

  useAppStore.setState(
    {
      isSignedIn: false,
      user: null,
      reportsResetAtMs: 0,
      reportsNeedsRemoteReset: false,
      reports: [],
      positions: [],
      watchlist: [],
      lastScanMs: null,
      scanPool: [],
      scanPoolUpdatedAtMs: null,
      recentlyClosedSymbols: {},
      settings: { autoTradeEnabled: true, minRiskReward: 1.5 },
    },
    false,
  );

  const now = Date.now();
  const position = {
    symbol: 'BTCTRY',
    score: 80,
    scoreBreakdown: {
      breakout: true,
      pullbackReclaim: true,
      volMultOk: true,
      ema21SlopeUp: true,
      flatPenalty: false,
      pumpPenalty: false,
    },
    entry: 1,
    target: 2,
    stop: 0.5,
    riskReward: 2,
    lastPrice: 0.8,
    lastChangePercent: 0,
    ema5: 0,
    ema21: 0,
    ema144: 0,
    volMult: 1,
    openedAtMs: now - 60_000,
  };

  useAppStore.getState().setPositions([position], now);
  useAppStore.getState().closePositionManually({ symbol: 'BTCTRY' });

  const state = useAppStore.getState();
  assert.equal(state.positions.length, 0);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0]?.symbol, 'BTCTRY');
});
