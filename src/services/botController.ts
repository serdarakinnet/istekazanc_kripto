import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import type { ActivePosition, TradeReport } from '../store/useAppStore';
import { useAppStore } from '../store/useAppStore';
import type { ScanResult, ScannedCandidate } from './tradingEngine';
import { scanTop } from './tradingEngine';
import { getUserPositions } from './userDb';

const BOT_TASK_NAME = 'bist-bot-background';
const RECENT_CLOSE_COOLDOWN_MS = 60 * 60 * 1000;

function resolveApiBaseUrl(): string {
  const env = String(process.env.EXPO_PUBLIC_API_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');

  if (Platform.OS === 'web') {
    const g = globalThis as unknown as { location?: { protocol?: string; hostname?: string } };
    const protocol = g.location?.protocol || 'http:';
    const hostname = g.location?.hostname || 'localhost';
    return `${protocol}//${hostname}:3001`;
  }

  if (Platform.OS === 'android') return 'http://10.0.2.2:3001';
  return 'http://localhost:3001';
}

const API_BASE_URL = resolveApiBaseUrl();

let poolRefreshPromise: Promise<void> | null = null;
let lastPoolRefreshAttemptMs = 0;

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function uniqueScannedCandidates(items: ScannedCandidate[]): ScannedCandidate[] {
  const seen = new Set<string>();
  const out: ScannedCandidate[] = [];
  for (const c of items) {
    const sym = normalizeSymbol(String(c.symbol || ''));
    if (!sym) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push({ ...c, symbol: sym });
  }
  return out;
}

function uniqueActivePositions(items: ActivePosition[]): ActivePosition[] {
  const seen = new Set<string>();
  const out: ActivePosition[] = [];
  for (const p of items) {
    const sym = normalizeSymbol(String(p.symbol || ''));
    if (!sym) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push({ ...p, symbol: sym });
  }
  return out;
}

function refreshPoolIfNeeded(nowMs: number): void {
  const state = useAppStore.getState();
  if (!state.settings.autoTradeEnabled) return;
  if (!state.isSignedIn) return;

  const updatedAt = state.scanPoolUpdatedAtMs ?? 0;
  const stale = nowMs - updatedAt > 45_000;
  const low = state.scanPool.length < 6;
  if (!stale && !low) return;
  if (poolRefreshPromise) return;
  if (nowMs - lastPoolRefreshAttemptMs < 10_000) return;
  lastPoolRefreshAttemptMs = nowMs;

  const recentClosed = Object.entries(state.recentlyClosedSymbols)
    .filter(([, ms]) => Number.isFinite(ms) && nowMs - ms < RECENT_CLOSE_COOLDOWN_MS)
    .map(([sym]) => sym);
  const excludeSymbols = [
    ...state.positions.map((p) => p.symbol.trim().toUpperCase()),
    ...recentClosed.map((s) => s.trim().toUpperCase()),
  ];

  poolRefreshPromise = (async () => {
    try {
      const scan = await scanTop({
        minRiskReward: state.settings.minRiskReward,
        excludeSymbols,
        pickTopK: 12,
        baseUrl: 'https://data-api.binance.vision',
        timeoutMs: 12_000,
      });
      state.setScanPool(scan.topCandidates, scan.asOfMs);
    } catch {
    } finally {
      poolRefreshPromise = null;
    }
  })();
}

function makeReportId(params: {
  symbol: string;
  openedAtMs: number;
  outcome: TradeReport['outcome'];
}): string {
  return `${params.symbol}-${params.openedAtMs}-${params.outcome}`;
}

function pct(entry: number, exit: number): number {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(exit)) return 0;
  return ((exit - entry) / entry) * 100;
}

function toActivePositions(candidates: ScannedCandidate[], openedAtMs: number): ActivePosition[] {
  return candidates.map((c) => ({ ...c, openedAtMs }));
}

function parseStoredPositions(rows: Array<{ openedAtMs: number; payloadJson: string }>): ActivePosition[] {
  return rows
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
}

async function fetchLastPrice(symbol: string, baseUrl: string, timeoutMs: number): Promise<number> {
  const url = new URL('/api/v3/ticker/price', baseUrl);
  url.searchParams.set('symbol', symbol);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { price?: unknown };
    const price = typeof data.price === 'number' ? data.price : Number(data.price);
    if (!Number.isFinite(price)) throw new Error('Invalid price');
    return price;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLastPricesViaApi(symbols: string[], timeoutMs: number): Promise<Record<string, number>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE_URL}/market/last-prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols, timeoutMs }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { prices?: unknown };
    const prices = body?.prices;
    if (!prices || typeof prices !== 'object') return {};

    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(prices as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[String(k).toUpperCase()] = n;
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLastPrices(symbols: string[], baseUrl: string, timeoutMs: number): Promise<Record<string, number>> {
  if (Platform.OS === 'web' && API_BASE_URL) {
    try {
      return await fetchLastPricesViaApi(symbols, timeoutMs);
    } catch {
      return {};
    }
  }
  const results: Record<string, number> = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const price = await fetchLastPrice(symbol, baseUrl, timeoutMs);
        results[symbol] = price;
      } catch {
        return;
      }
    }),
  );
  return results;
}

function evaluatePositions(params: {
  positions: ActivePosition[];
  prices: Record<string, number>;
  nowMs: number;
}): { remaining: ActivePosition[]; closed: TradeReport[] } {
  const remaining: ActivePosition[] = [];
  const closed: TradeReport[] = [];

  for (const pos of params.positions) {
    const symbol = pos.symbol.trim().toUpperCase();
    const live = params.prices[symbol] ?? params.prices[pos.symbol];
    const price = Number.isFinite(live) ? live : pos.lastPrice;

    const hitTarget = price >= pos.target;
    const hitStop = price <= pos.stop;

    if (!hitTarget && !hitStop) {
      remaining.push(Number.isFinite(live) ? { ...pos, symbol, lastPrice: price } : { ...pos, symbol });
      continue;
    }

    const outcome: TradeReport['outcome'] = hitTarget ? 'TP' : 'SL';
    const closedAtMs = params.nowMs;
    const entry = pos.entry;
    const exit = price;

    closed.push({
      id: makeReportId({ symbol, openedAtMs: pos.openedAtMs, outcome }),
      symbol,
      openedAtMs: pos.openedAtMs,
      closedAtMs,
      entry,
      exit,
      outcome,
      pnlPct: pct(entry, exit),
      riskRewardAtEntry: pos.riskReward,
    });
  }

  return { remaining, closed };
}

async function refillPositions(params: {
  current: ActivePosition[];
  minRiskReward: number;
  baseUrl: string;
  timeoutMs: number;
  nowMs: number;
}): Promise<{ positions: ActivePosition[]; scan: ScanResult | null }> {
  const currentUnique = uniqueActivePositions(params.current);
  if (currentUnique.length >= 3) return { positions: currentUnique.slice(0, 3), scan: null };

  const state = useAppStore.getState();
  const recentClosed = Object.entries(state.recentlyClosedSymbols)
    .filter(([, ms]) => Number.isFinite(ms) && params.nowMs - ms < RECENT_CLOSE_COOLDOWN_MS)
    .map(([sym]) => sym);
  const excludeSymbols = [
    ...currentUnique.map((p) => normalizeSymbol(p.symbol)),
    ...recentClosed.map((s) => normalizeSymbol(s)),
  ];
  const needed = 3 - currentUnique.length;

  const fromPool = state.takeFromScanPool({ needed, excludeSymbols });
  const pooled = uniqueActivePositions([
    ...currentUnique,
    ...toActivePositions(uniqueScannedCandidates(fromPool), params.nowMs),
  ]);
  if (pooled.length >= 3) return { positions: pooled.slice(0, 3), scan: null };

  const stillNeeded = 3 - pooled.length;
  try {
    const scan = await scanTop({
      minRiskReward: params.minRiskReward,
      excludeSymbols: [
        ...excludeSymbols,
        ...fromPool.map((c) => normalizeSymbol(c.symbol)),
      ],
      pickTopK: Math.max(12, stillNeeded * 6),
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
    });

    const scannedUnique = uniqueScannedCandidates(scan.topCandidates).filter(
      (c) => !excludeSymbols.includes(normalizeSymbol(c.symbol)),
    );

    const add = scannedUnique.slice(0, stillNeeded);
    const poolRemainder = scannedUnique.slice(add.length);
    state.setScanPool(poolRemainder, scan.asOfMs);

    const next = uniqueActivePositions([...pooled, ...toActivePositions(add, params.nowMs)]).slice(0, 3);
    if (next.length >= 3) return { positions: next, scan };

    const localFallback = uniqueScannedCandidates([
      ...state.watchlist,
      ...state.scanPool,
    ]).filter((c) => !excludeSymbols.includes(normalizeSymbol(c.symbol)));
    const needMore = 3 - next.length;
    const extra = localFallback.slice(0, needMore);
    return { positions: uniqueActivePositions([...next, ...toActivePositions(extra, params.nowMs)]).slice(0, 3), scan };
  } catch {
    const localFallback = uniqueScannedCandidates([
      ...state.watchlist,
      ...state.scanPool,
    ]).filter((c) => !excludeSymbols.includes(normalizeSymbol(c.symbol)));
    const extra = localFallback.slice(0, 3 - pooled.length);
    const next = uniqueActivePositions([...pooled, ...toActivePositions(extra, params.nowMs)]).slice(0, 3);
    return { positions: next, scan: null };
  }
}

export async function runInitialScanAndSetPositions(): Promise<void> {
  const state = useAppStore.getState();
  const { minRiskReward } = state.settings;
  const nowMs = Date.now();
  try {
    const scan = await scanTop({ minRiskReward, pickTopK: 12 });
    const unique = uniqueScannedCandidates(scan.topCandidates);
    const top = unique.slice(0, 3);
    const pool = unique.slice(3);
    const filled = uniqueActivePositions(toActivePositions(top, nowMs));
    state.setPositions(filled, scan.asOfMs);
    state.setScanPool(pool, scan.asOfMs);
  } catch {
    const fallback = uniqueScannedCandidates(state.watchlist.length > 0 ? state.watchlist : state.scanPool);
    const top = fallback.slice(0, 3);
    state.setPositions(uniqueActivePositions(toActivePositions(top, nowMs)), state.lastScanMs ?? nowMs);
  }
}

export async function applyLivePricesAndRotate(prices: Record<string, number>): Promise<void> {
  const state = useAppStore.getState();
  if (!state.settings.autoTradeEnabled) return;
  if (!state.isSignedIn) return;

  const nowMs = Date.now();
  refreshPoolIfNeeded(nowMs);
  const evaluated = evaluatePositions({
    positions: uniqueActivePositions(state.positions),
    prices,
    nowMs,
  });

  if (evaluated.closed.length > 0) {
    state.addRecentlyClosedSymbols(
      evaluated.closed.map((r) => r.symbol),
      nowMs,
    );
    state.appendReports(evaluated.closed);
  }

  const keepScanMs = state.lastScanMs ?? nowMs;
  let nextPositions = uniqueActivePositions(evaluated.remaining);
  let nextScanMs = keepScanMs;

  if (nextPositions.length < 3) {
    try {
      const { positions, scan } = await refillPositions({
        current: nextPositions,
        minRiskReward: state.settings.minRiskReward,
        baseUrl: 'https://data-api.binance.vision',
        timeoutMs: 12_000,
        nowMs,
      });
      nextPositions = uniqueActivePositions(positions);
      nextScanMs = scan?.asOfMs ?? nowMs;
    } catch {
    }
  }

  state.setPositions(nextPositions, nextScanMs);
  refreshPoolIfNeeded(nowMs);
}

export async function runBotCycle(): Promise<void> {
  const state = useAppStore.getState();
  if (!state.settings.autoTradeEnabled) return;
  if (!state.isSignedIn) return;

  const nowMs = Date.now();
  refreshPoolIfNeeded(nowMs);
  if (state.positions.length === 0) {
    const userId = state.user?.id;
    if (userId) {
      try {
        const rows = await getUserPositions(userId);
        const restored = uniqueActivePositions(parseStoredPositions(rows));
        if (restored.length > 0) {
          state.setPositions(restored, nowMs);
          return;
        }
      } catch {
      }
    }
    await runInitialScanAndSetPositions();
    return;
  }

  const currentPositions = uniqueActivePositions(state.positions);
  const symbols = currentPositions.map((p) => p.symbol);
  const prices = await fetchLastPrices(symbols, 'https://data-api.binance.vision', 12_000);
  const evaluated = evaluatePositions({
    positions: currentPositions,
    prices,
    nowMs,
  });

  if (evaluated.closed.length > 0) {
    state.addRecentlyClosedSymbols(
      evaluated.closed.map((r) => r.symbol),
      nowMs,
    );
    state.appendReports(evaluated.closed);
  }

  const keepScanMs = state.lastScanMs ?? nowMs;
  let nextPositions = uniqueActivePositions(evaluated.remaining);
  let nextScanMs = keepScanMs;

  if (nextPositions.length < 3) {
    try {
      const { positions, scan } = await refillPositions({
        current: nextPositions,
        minRiskReward: state.settings.minRiskReward,
        baseUrl: 'https://data-api.binance.vision',
        timeoutMs: 12_000,
        nowMs,
      });
      nextPositions = uniqueActivePositions(positions);
      nextScanMs = scan?.asOfMs ?? nowMs;
    } catch {
    }
  }

  state.setPositions(nextPositions, nextScanMs);
  refreshPoolIfNeeded(nowMs);
}

if (Platform.OS !== 'web') {
  TaskManager.defineTask(BOT_TASK_NAME, async () => {
    try {
      await runBotCycle();
      return BackgroundFetch.BackgroundFetchResult.NewData;
    } catch {
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
}

export async function registerBotBackgroundTask(): Promise<void> {
  if (Platform.OS === 'web') return;
  const status = await BackgroundFetch.getStatusAsync();
  if (
    status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
    status === BackgroundFetch.BackgroundFetchStatus.Denied
  ) {
    return;
  }

  const isRegistered = await TaskManager.isTaskRegisteredAsync(BOT_TASK_NAME);
  if (isRegistered) return;

  await BackgroundFetch.registerTaskAsync(BOT_TASK_NAME, {
    minimumInterval: 60,
    stopOnTerminate: false,
    startOnBoot: true,
  });
}

export async function unregisterBotBackgroundTask(): Promise<void> {
  if (Platform.OS === 'web') return;
  const isRegistered = await TaskManager.isTaskRegisteredAsync(BOT_TASK_NAME);
  if (!isRegistered) return;
  await BackgroundFetch.unregisterTaskAsync(BOT_TASK_NAME);
}
