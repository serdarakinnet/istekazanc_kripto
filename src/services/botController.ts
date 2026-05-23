import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import type { ActivePosition, TradeReport } from '../store/useAppStore';
import { useAppStore } from '../store/useAppStore';
import type { ScanResult, ScannedCandidate } from './tradingEngine';
import { scanTop3 } from './tradingEngine';

const BOT_TASK_NAME = 'bist-bot-background';
const RECENT_CLOSE_COOLDOWN_MS = 60 * 60 * 1000;

function makeReportId(symbol: string, closedAtMs: number): string {
  return `${symbol}-${closedAtMs}`;
}

function pct(entry: number, exit: number): number {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(exit)) return 0;
  return ((exit - entry) / entry) * 100;
}

function toActivePositions(candidates: ScannedCandidate[], openedAtMs: number): ActivePosition[] {
  return candidates.map((c) => ({ ...c, openedAtMs }));
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

async function fetchLastPrices(symbols: string[], baseUrl: string, timeoutMs: number): Promise<Record<string, number>> {
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
    const live = params.prices[pos.symbol];
    const price = Number.isFinite(live) ? live : pos.lastPrice;

    const hitTarget = price >= pos.target;
    const hitStop = price <= pos.stop;

    if (!hitTarget && !hitStop) {
      remaining.push(pos);
      continue;
    }

    const outcome: TradeReport['outcome'] = hitTarget ? 'TP' : 'SL';
    const closedAtMs = params.nowMs;
    const entry = pos.entry;
    const exit = price;

    closed.push({
      id: makeReportId(pos.symbol, closedAtMs),
      symbol: pos.symbol,
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
  if (params.current.length >= 3) return { positions: params.current, scan: null };

  const state = useAppStore.getState();
  const recentClosed = Object.entries(state.recentlyClosedSymbols)
    .filter(([, ms]) => Number.isFinite(ms) && params.nowMs - ms < RECENT_CLOSE_COOLDOWN_MS)
    .map(([sym]) => sym);
  const excludeSymbols = [...params.current.map((p) => p.symbol), ...recentClosed];
  const scan = await scanTop3({
    minRiskReward: params.minRiskReward,
    excludeSymbols,
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
  });

  const needed = 3 - params.current.length;
  const add = scan.topCandidates.slice(0, needed);
  const next = [...params.current, ...toActivePositions(add, params.nowMs)];
  return { positions: next, scan };
}

export async function runInitialScanAndSetPositions(): Promise<void> {
  const state = useAppStore.getState();
  const { minRiskReward } = state.settings;
  const nowMs = Date.now();
  const scan = await scanTop3({ minRiskReward });
  state.setPositions(toActivePositions(scan.topCandidates, nowMs), scan.asOfMs);
}

export async function applyLivePricesAndRotate(prices: Record<string, number>): Promise<void> {
  const state = useAppStore.getState();
  if (!state.settings.autoTradeEnabled) return;

  const nowMs = Date.now();
  const evaluated = evaluatePositions({
    positions: state.positions,
    prices,
    nowMs,
  });

  if (evaluated.closed.length === 0) return;

  state.addRecentlyClosedSymbols(
    evaluated.closed.map((r) => r.symbol),
    nowMs,
  );
  state.appendReports(evaluated.closed);

  const { positions } = await refillPositions({
    current: evaluated.remaining,
    minRiskReward: state.settings.minRiskReward,
    baseUrl: 'https://data-api.binance.vision',
    timeoutMs: 12_000,
    nowMs,
  });

  state.setPositions(positions, nowMs);
}

export async function runBotCycle(): Promise<void> {
  const state = useAppStore.getState();
  if (!state.settings.autoTradeEnabled) return;

  const nowMs = Date.now();
  if (state.positions.length === 0) {
    await runInitialScanAndSetPositions();
    return;
  }

  const symbols = state.positions.map((p) => p.symbol);
  const prices = await fetchLastPrices(symbols, 'https://data-api.binance.vision', 12_000);
  const evaluated = evaluatePositions({
    positions: state.positions,
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

  const { positions } = await refillPositions({
    current: evaluated.remaining,
    minRiskReward: state.settings.minRiskReward,
    baseUrl: 'https://data-api.binance.vision',
    timeoutMs: 12_000,
    nowMs,
  });

  state.setPositions(positions, nowMs);
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
