import { Platform } from 'react-native';
import { aiFilterCandidates } from './aiFilter';

export type BinanceTicker24h = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
};

export type BinanceKline = {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTimeMs: number;
};

export type ScanOptions = {
  baseUrl?: string;
  quoteAsset?: string;
  topNByQuoteVolume?: number;
  excludeBases?: string[];
  excludeSymbols?: string[];
  pickTopK?: number;
  klineInterval?: '1h';
  klineLimit?: number;
  minRiskReward?: number;
  concurrency?: number;
  timeoutMs?: number;
  customStrategyCode?: string;
};

export type ScoreBreakdown = {
  freshCross: boolean;
  trendOk: boolean;
  priceAboveEma21: boolean;
  breakout: boolean;
  pullbackReclaim: boolean;
  volMultOk: boolean;
  ema21SlopeUp: boolean;
  flatPenalty: boolean;
  pumpPenalty: boolean;
};

export type ScannedCandidate = {
  symbol: string;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  entry: number;
  target: number;
  stop: number;
  riskReward: number;
  lastPrice: number;
  lastChangePercent: number;
  ema5: number;
  ema21: number;
  ema144: number;
  volMult: number;
};

export type ScanResult = {
  asOfMs: number;
  quoteAsset: string;
  topCandidates: ScannedCandidate[];
  rejected: Array<{
    symbol: string;
    reason:
      | 'no-klines'
      | 'not-enough-data'
      | 'trend-failed'
      | 'rr-too-low'
      | 'invalid-risk'
      | 'entry-failed'
      | 'score-low'
      | 'network';
  }>;
};

function resolveApiBaseUrl(): string {
  const env = String(process.env.EXPO_PUBLIC_API_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');

  if (Platform.OS === 'web') {
    const g = globalThis as unknown as { location?: { protocol?: string; hostname?: string } };
    const protocol = g.location?.protocol || 'http:';
    const hostname = g.location?.hostname || 'localhost';
    const host = hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return `${protocol}//${hostname}:3001`;
    return `${protocol}//${hostname}/api`;
  }

  if (Platform.OS === 'android') return 'http://10.0.2.2:3001';
  return 'http://localhost:3001';
}

const API_BASE_URL = resolveApiBaseUrl();
let apiHealthOkUntilMs = 0;
let apiHealthDownUntilMs = 0;
let apiHealthFailCount = 0;
let apiHealthInFlight: Promise<boolean> | null = null;

function markApiUnhealthy(nowMs: number) {
  apiHealthFailCount = Math.min(8, apiHealthFailCount + 1);
  apiHealthOkUntilMs = 0;
  apiHealthDownUntilMs = nowMs + Math.min(60_000, 1000 * 2 ** (apiHealthFailCount - 1));
}

async function isApiHealthy(timeoutMs: number): Promise<boolean> {
  if (Platform.OS !== 'web') return true;

  const nowMs = Date.now();
  if (nowMs < apiHealthOkUntilMs) return true;
  if (nowMs < apiHealthDownUntilMs) return false;
  if (apiHealthInFlight) return apiHealthInFlight;

  apiHealthInFlight = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(5000, timeoutMs));
    try {
      const url = new URL('/health', API_BASE_URL);
      const res = await fetch(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        markApiUnhealthy(Date.now());
        return false;
      }
      const json = (await res.json()) as { ok?: unknown };
      if (json?.ok !== true) {
        markApiUnhealthy(Date.now());
        return false;
      }
      apiHealthFailCount = 0;
      apiHealthDownUntilMs = 0;
      apiHealthOkUntilMs = Date.now() + 20_000;
      return true;
    } catch {
      markApiUnhealthy(Date.now());
      return false;
    } finally {
      clearTimeout(timeout);
      apiHealthInFlight = null;
    }
  })();

  return apiHealthInFlight;
}

const DEFAULTS: Required<
  Pick<
    ScanOptions,
    | 'baseUrl'
    | 'quoteAsset'
    | 'topNByQuoteVolume'
    | 'excludeBases'
    | 'excludeSymbols'
    | 'pickTopK'
    | 'klineInterval'
    | 'klineLimit'
    | 'minRiskReward'
    | 'concurrency'
    | 'timeoutMs'
  >
> = {
  baseUrl: 'https://data-api.binance.vision',
  quoteAsset: 'TRY',
  topNByQuoteVolume: 200,
  excludeBases: [
    'USDT',
    'USDC',
    'FDUSD',
    'TUSD',
    'BUSD',
    'DAI',
    'USDP',
    'PAXG',
    'XAUT',
  ],
  excludeSymbols: [],
  pickTopK: 3,
  klineInterval: '1h',
  klineLimit: 200,
  minRiskReward: 1.5,
  concurrency: 5,
  timeoutMs: 12_000,
};

async function fetchBinanceTrAllowedSymbols(params: {
  quoteAsset: string;
  timeoutMs: number;
}): Promise<Set<string>> {
  if (Platform.OS === 'web') {
    const ok = await isApiHealthy(params.timeoutMs);
    if (!ok) throw new Error('API down');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const url = new URL('/binance-tr/symbols', API_BASE_URL);
    url.searchParams.set('quoteAsset', params.quoteAsset.toUpperCase());
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { ok?: unknown; symbols?: unknown };
    if (json?.ok !== true || !Array.isArray(json?.symbols)) {
      throw new Error('Invalid response');
    }
    const set = new Set<string>();
    for (const item of json.symbols) {
      if (typeof item !== 'string') continue;
      const sym = item.trim().toUpperCase();
      if (!sym) continue;
      set.add(sym);
    }
    if (set.size === 0) throw new Error('Empty symbol list');
    return set;
  } catch {
    throw new Error('Binance TR sembol listesi alınamadı.');
  } finally {
    clearTimeout(timeout);
  }
}

function ensureFiniteNumber(value: unknown, fieldName: string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) throw new Error(`Invalid ${fieldName}`);
  return num;
}

async function fetchJson<T>(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<T> {
  if (Platform.OS === 'web') {
    try {
      const url = new URL(input);
      if (url.hostname === 'data-api.binance.vision') {
        throw new Error('Web üzerinde piyasa verisi proxy üzerinden alınmalıdır.');
      }
    } catch {
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text}`.trim());
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(baseUrl: string, path: string, params?: Record<string, string>) {
  const url = new URL(path, baseUrl);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  return url.toString();
}

function isTrySymbol(symbol: string, quoteAsset: string): boolean {
  return symbol.toUpperCase().endsWith(quoteAsset.toUpperCase());
}

function extractBaseAsset(symbol: string, quoteAsset: string): string {
  return symbol.slice(0, Math.max(0, symbol.length - quoteAsset.length));
}

function sortDescNumeric<T>(items: T[], getValue: (item: T) => number): T[] {
  return [...items].sort((a, b) => getValue(b) - getValue(a));
}

function sma(values: number[], length: number): number | null {
  if (values.length < length) return null;
  let sum = 0;
  for (let i = values.length - length; i < values.length; i += 1) sum += values[i];
  return sum / length;
}

export function emaSeries(values: number[], length: number): number[] {
  if (length <= 1) return values.slice();
  if (values.length < length) return [];

  const k = 2 / (length + 1);
  const output: number[] = new Array(values.length).fill(Number.NaN);

  let ema = 0;
  for (let i = 0; i < length; i += 1) ema += values[i];
  ema /= length;
  output[length - 1] = ema;

  for (let i = length; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
    output[i] = ema;
  }

  return output;
}

function maxInWindow(values: number[], lookback: number, excludeLast: boolean): number | null {
  const end = excludeLast ? values.length - 1 : values.length;
  const start = Math.max(0, end - lookback);
  if (end <= start) return null;
  let max = -Infinity;
  for (let i = start; i < end; i += 1) max = Math.max(max, values[i]);
  return Number.isFinite(max) ? max : null;
}

function minInWindow(values: number[], lookback: number, excludeLast: boolean): number | null {
  const end = excludeLast ? values.length - 1 : values.length;
  const start = Math.max(0, end - lookback);
  if (end <= start) return null;
  let min = Infinity;
  for (let i = start; i < end; i += 1) min = Math.min(min, values[i]);
  return Number.isFinite(min) ? min : null;
}

function pctChange(now: number, prev: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return 0;
  return ((now - prev) / prev) * 100;
}

function clampMin(value: number, min: number): number {
  return value < min ? min : value;
}

async function fetchTicker24hViaWebSocket(timeoutMs: number): Promise<BinanceTicker24h[]> {
  const url = 'wss://data-stream.binance.vision/ws/!ticker@arr';
  return await new Promise<BinanceTicker24h[]>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    const finish = (value: { ok: true; data: BinanceTicker24h[] } | { ok: false; error: Error }) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      } catch {
      }
      ws = null;

      if (value.ok) resolve(value.data);
      else reject(value.error);
    };

    try {
      ws = new WebSocket(url);
    } catch {
      finish({ ok: false, error: new Error('Ticker stream açılamadı.') });
      return;
    }

    timer = setTimeout(() => {
      finish({ ok: false, error: new Error('Ticker stream timeout.') });
    }, Math.max(1000, timeoutMs));

    ws.onmessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : null;
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;

      const out: BinanceTicker24h[] = [];
      for (const it of parsed) {
        const obj = it as { s?: unknown; c?: unknown; P?: unknown; q?: unknown };
        const symbol = typeof obj.s === 'string' ? obj.s : null;
        const lastPrice = typeof obj.c === 'string' ? obj.c : obj.c !== undefined ? String(obj.c) : null;
        const priceChangePercent =
          typeof obj.P === 'string' ? obj.P : obj.P !== undefined ? String(obj.P) : null;
        const quoteVolume = typeof obj.q === 'string' ? obj.q : obj.q !== undefined ? String(obj.q) : null;
        if (!symbol || !lastPrice || !priceChangePercent || !quoteVolume) continue;
        out.push({ symbol, lastPrice, priceChangePercent, quoteVolume });
      }
      if (out.length === 0) return;
      finish({ ok: true, data: out });
    };

    ws.onerror = () => {
      finish({ ok: false, error: new Error('Ticker stream hatası.') });
    };
  });
}

export async function fetchTicker24h(
  options?: Pick<ScanOptions, 'baseUrl' | 'timeoutMs'>,
): Promise<BinanceTicker24h[]> {
  const baseUrl = options?.baseUrl ?? DEFAULTS.baseUrl;
  const timeoutMs = options?.timeoutMs ?? DEFAULTS.timeoutMs;
  let raw: unknown;
  if (Platform.OS === 'web') {
    try {
      raw = await fetchTicker24hViaWebSocket(timeoutMs);
    } catch {
      try {
        const url = buildUrl(API_BASE_URL, '/market/ticker/24hr', {
          timeoutMs: String(timeoutMs),
        });
        const body = await fetchJson<{ ok?: unknown; data?: unknown }>(url, undefined, timeoutMs);
        raw = body?.ok === true ? body.data : [];
      } catch {
        raw = [];
      }
    }
  } else {
    const url = buildUrl(baseUrl, '/api/v3/ticker/24hr');
    try {
      raw = await fetchJson<unknown[]>(url, undefined, timeoutMs);
    } catch {
      raw = await fetchTicker24hViaWebSocket(timeoutMs);
    }
  }

  const list = Array.isArray(raw) ? raw : [];

  const tickers: BinanceTicker24h[] = list
    .map((item) => {
      const obj = item as Partial<Record<keyof BinanceTicker24h, unknown>>;
      if (typeof obj.symbol !== 'string') return null;
      if (typeof obj.lastPrice !== 'string') return null;
      if (typeof obj.priceChangePercent !== 'string') return null;
      if (typeof obj.quoteVolume !== 'string') return null;
      return {
        symbol: obj.symbol,
        lastPrice: obj.lastPrice,
        priceChangePercent: obj.priceChangePercent,
        quoteVolume: obj.quoteVolume,
      } satisfies BinanceTicker24h;
    })
    .filter((x): x is BinanceTicker24h => Boolean(x));

  return tickers;
}

export function filterTopPairsByQuoteVolume(
  tickers: BinanceTicker24h[],
  options?: Pick<
    ScanOptions,
    'quoteAsset' | 'topNByQuoteVolume' | 'excludeBases' | 'excludeSymbols'
  >,
): BinanceTicker24h[] {
  const quoteAsset = options?.quoteAsset ?? DEFAULTS.quoteAsset;
  const topN = options?.topNByQuoteVolume ?? DEFAULTS.topNByQuoteVolume;
  const excludeBases = new Set(
    (options?.excludeBases ?? DEFAULTS.excludeBases).map((x) => x.toUpperCase()),
  );
  const excludeSymbols = new Set(
    (options?.excludeSymbols ?? DEFAULTS.excludeSymbols).map((x) => x.toUpperCase()),
  );

  const tryTickers = tickers.filter((t) => isTrySymbol(t.symbol, quoteAsset));
  const filtered = tryTickers.filter((t) => {
    if (excludeSymbols.has(t.symbol.toUpperCase())) return false;
    const base = extractBaseAsset(t.symbol.toUpperCase(), quoteAsset.toUpperCase());
    if (!base) return false;
    if (excludeBases.has(base)) return false;
    return true;
  });

  const sorted = sortDescNumeric(filtered, (t) => ensureFiniteNumber(t.quoteVolume, 'quoteVolume'));
  return sorted.slice(0, topN);
}

export async function fetchKlines(
  symbol: string,
  options?: Pick<ScanOptions, 'baseUrl' | 'klineInterval' | 'klineLimit' | 'timeoutMs'>,
): Promise<BinanceKline[]> {
  const baseUrl = options?.baseUrl ?? DEFAULTS.baseUrl;
  const interval = options?.klineInterval ?? DEFAULTS.klineInterval;
  const limit = options?.klineLimit ?? DEFAULTS.klineLimit;
  const timeoutMs = options?.timeoutMs ?? DEFAULTS.timeoutMs;

  let raw: unknown;
  if (Platform.OS === 'web') {
    const ok = await isApiHealthy(timeoutMs);
    if (!ok) return [];
    try {
      const url = buildUrl(API_BASE_URL, '/market/klines', {
        symbol,
        interval,
        limit: String(limit),
        timeoutMs: String(timeoutMs),
      });
      const body = await fetchJson<{ ok?: unknown; data?: unknown }>(url, undefined, timeoutMs);
      if (body?.ok !== true || !Array.isArray(body?.data) || body.data.length === 0) return [];
      raw = body.data;
    } catch {
      markApiUnhealthy(Date.now());
      return [];
    }
  } else {
    const url = buildUrl(baseUrl, '/api/v3/klines', {
      symbol,
      interval,
      limit: String(limit),
    });
    raw = await fetchJson<unknown[]>(url, undefined, timeoutMs);
  }

  const list = Array.isArray(raw) ? raw : [];
  const parsed: BinanceKline[] = [];

  for (const item of list) {
    if (!Array.isArray(item) || item.length < 7) continue;
    const openTimeMs = ensureFiniteNumber(item[0], 'openTimeMs');
    const open = ensureFiniteNumber(item[1], 'open');
    const high = ensureFiniteNumber(item[2], 'high');
    const low = ensureFiniteNumber(item[3], 'low');
    const close = ensureFiniteNumber(item[4], 'close');
    const volume = ensureFiniteNumber(item[5], 'volume');
    const closeTimeMs = ensureFiniteNumber(item[6], 'closeTimeMs');

    parsed.push({
      openTimeMs,
      open,
      high,
      low,
      close,
      volume,
      closeTimeMs,
    });
  }

  return parsed;
}

function scoreCandidate(params: {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  minRiskReward: number;
  customStrategyCode?: string;
}): {
  ok: boolean;
  rejectReason: ScanResult['rejected'][number]['reason'] | null;
  score: number;
  breakdown: ScoreBreakdown;
  entry: number;
  target: number;
  stop: number;
  rr: number;
  ema5: number;
  ema21: number;
  ema144: number;
  volMult: number;
} {
  if (params.customStrategyCode && params.customStrategyCode.trim().length > 0) {
    try {
      const strategyFn = new Function('ctx', params.customStrategyCode);
      const result = strategyFn({
        closes: params.closes,
        highs: params.highs,
        lows: params.lows,
        volumes: params.volumes,
        minRiskReward: params.minRiskReward,
        emaSeries,
        sma,
        pctChange,
      });

      if (result && typeof result === 'object') {
        const ok = Boolean(result.ok);
        return {
          ok,
          rejectReason: result.rejectReason || (ok ? null : 'strategy-rejected'),
          score: Number(result.score) || 0,
          breakdown: result.breakdown || {
            freshCross: false, trendOk: false, priceAboveEma21: false,
            breakout: false, pullbackReclaim: false, volMultOk: false,
            ema21SlopeUp: false, flatPenalty: false, pumpPenalty: false,
          },
          entry: Number(result.entry) || 0,
          target: Number(result.target) || 0,
          stop: Number(result.stop) || 0,
          rr: Number(result.rr) || params.minRiskReward,
          ema5: Number(result.ema5) || 0,
          ema21: Number(result.ema21) || 0,
          ema144: Number(result.ema144) || 0,
          volMult: Number(result.volMult) || 0,
        };
      }
    } catch (err) {
      console.warn('Custom strategy execution error:', err);
    }
  }

  const { closes, highs, lows, volumes } = params;
  const lastIndex = closes.length - 1;
  if (lastIndex < 0) {
    return {
      ok: false,
      rejectReason: 'no-klines',
      score: 0,
      breakdown: {
        freshCross: false, trendOk: false, priceAboveEma21: false,
        breakout: false, pullbackReclaim: false, volMultOk: false,
        ema21SlopeUp: false, flatPenalty: false, pumpPenalty: false,
      },
      entry: 0, target: 0, stop: 0, rr: 0,
      ema5: 0, ema21: 0, ema144: 0, volMult: 0,
    };
  }

  if (closes.length < 60 || highs.length !== closes.length || lows.length !== closes.length) {
    return {
      ok: false,
      rejectReason: 'not-enough-data',
      score: 0,
      breakdown: {
        freshCross: false, trendOk: false, priceAboveEma21: false,
        breakout: false, pullbackReclaim: false, volMultOk: false,
        ema21SlopeUp: false, flatPenalty: false, pumpPenalty: false,
      },
      entry: 0, target: 0, stop: 0, rr: 0,
      ema5: 0, ema21: 0, ema144: 0, volMult: 0,
    };
  }

  // Deep Fibonacci Engine V6.5 calculations
  const calcEMA = (data: number[], p: number): number | null => {
    if (data.length < p) return null;
    const k = 2 / (p + 1);
    let e = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < data.length; i++) e = data[i] * k + e * (1 - k);
    return e;
  };

  const calcRSI = (data: number[], p = 14): number | null => {
    if (data.length < p + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) {
      const d = data[i] - data[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    let ag = g / p, al = l / p;
    for (let i = p + 1; i < data.length; i++) {
      const d = data[i] - data[i - 1];
      ag = (ag * (p - 1) + Math.max(d, 0)) / p;
      al = (al * (p - 1) + Math.max(-d, 0)) / p;
    }
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
  };

  const calcATR = (h: number[], l: number[], c: number[], p = 14): number | null => {
    if (h.length < p + 1) return null;
    const trs = [];
    for (let i = 1; i < h.length; i++) {
      trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    }
    if (trs.length < p) return null;
    return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
  };

  const calcMACD = (data: number[]): { macd: number; signal: number | null; hist: number | null } | null => {
    if (data.length < 35) return null;
    const series = [];
    for (let i = 26; i <= data.length; i++) {
      const e12 = calcEMA(data.slice(0, i), 12);
      const e26 = calcEMA(data.slice(0, i), 26);
      if (e12 != null && e26 != null) series.push(e12 - e26);
    }
    if (!series.length) return null;
    const macd = series[series.length - 1];
    const signal = calcEMA(series, 9);
    const hist = signal == null ? null : macd - signal;
    return { macd, signal, hist };
  };

  const price = closes[closes.length - 1];

  const e5 = calcEMA(closes, 5);
  const e21 = calcEMA(closes, 21);
  const e55 = calcEMA(closes, 55);
  const rsi = calcRSI(closes, 14);
  const atr = calcATR(highs, lows, closes, 14);
  const macd = calcMACD(closes);

  if (e5 == null || e21 == null || e55 == null || rsi == null || atr == null || !macd) {
    return {
      ok: false,
      rejectReason: 'not-enough-data',
      score: 0,
      breakdown: {
        freshCross: false, trendOk: false, priceAboveEma21: false,
        breakout: false, pullbackReclaim: false, volMultOk: false,
        ema21SlopeUp: false, flatPenalty: false, pumpPenalty: false,
      },
      entry: price, target: 0, stop: 0, rr: 0,
      ema5: 0, ema21: 0, ema144: 0, volMult: 0,
    };
  }

  const vol20 = volumes.slice(-20);
  const vol20avg = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
  const curVol = volumes[volumes.length - 1];
  const volMult = vol20avg > 0 ? Number((curVol / vol20avg).toFixed(2)) : 0;

  const trendLong = e5 > e21 && e21 > e55;
  const macdLong = macd.hist != null && macd.hist > 0;
  const volLong = volMult >= 1.1;

  const gates = [trendLong, macdLong, volLong].filter(Boolean).length;
  let longScore = gates * 20 + (rsi > 50 ? 10 : 0) + (volMult > 1.5 ? 10 : 0);
  longScore = Math.max(0, Math.min(100, Math.round(longScore)));

  let stop = Math.min(price - atr * 1.6, Math.min(...lows.slice(-20)) * 0.99);
  stop = Math.max(stop, price * 0.90); 
  stop = Math.min(stop, price * 0.95); 
  const longStop = Number(stop.toFixed(8));

  const risk = price - longStop;
  const longTarget = Number((price + risk * 2.5).toFixed(8));
  const longRR = risk > 0 ? Number(((longTarget - price) / risk).toFixed(2)) : 0;

  const scoreOk = longScore >= 40;

  const breakdown: ScoreBreakdown = {
    freshCross: trendLong,
    trendOk: trendLong,
    priceAboveEma21: price > e21,
    breakout: macdLong,
    pullbackReclaim: volLong,
    volMultOk: volMult >= 1.0,
    ema21SlopeUp: e21 > e55,
    flatPenalty: rsi < 40 || rsi > 75,
    pumpPenalty: volMult >= 3.5 && rsi > 80,
  };

  return {
    ok: scoreOk,
    rejectReason: scoreOk ? null : 'score-low',
    score: longScore,
    breakdown,
    entry: Number(price.toFixed(8)),
    target: longTarget,
    stop: longStop,
    rr: longRR,
    ema5: Number(e5.toFixed(8)),
    ema21: Number(e21.toFixed(8)),
    ema144: Number(e55.toFixed(8)),
    volMult,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(Math.max(1, concurrency)).fill(null).map(async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function runDeepFibonacciEngine(
  tickers: BinanceTicker24h[],
  options?: ScanOptions,
): Promise<ScanResult> {
  const merged: Required<ScanOptions> = {
    baseUrl: options?.baseUrl ?? DEFAULTS.baseUrl,
    quoteAsset: options?.quoteAsset ?? DEFAULTS.quoteAsset,
    topNByQuoteVolume: options?.topNByQuoteVolume ?? DEFAULTS.topNByQuoteVolume,
    excludeBases: options?.excludeBases ?? DEFAULTS.excludeBases,
    excludeSymbols: options?.excludeSymbols ?? DEFAULTS.excludeSymbols,
    pickTopK: options?.pickTopK ?? DEFAULTS.pickTopK,
    klineInterval: options?.klineInterval ?? DEFAULTS.klineInterval,
    klineLimit: options?.klineLimit ?? DEFAULTS.klineLimit,
    minRiskReward: options?.minRiskReward ?? DEFAULTS.minRiskReward,
    concurrency: options?.concurrency ?? DEFAULTS.concurrency,
    timeoutMs: options?.timeoutMs ?? DEFAULTS.timeoutMs,
  };

  if (Platform.OS === 'web') {
    const ok = await isApiHealthy(merged.timeoutMs);
    if (!ok) throw new Error('API down');
  }

  // Binance TR CORS hataları ve geo-block nedeniyle global TRY çiftlerini doğrudan alıyoruz.
  const universe = filterTopPairsByQuoteVolume(tickers, merged);
  const rejected: ScanResult['rejected'] = [];

  const candidates = await mapWithConcurrency(
    universe,
    merged.concurrency,
    async (ticker) => {
      try {
        const klines = await fetchKlines(ticker.symbol, merged);
        if (klines.length === 0) {
          rejected.push({ symbol: ticker.symbol, reason: 'no-klines' });
          return null;
        }

        const closes = klines.map((k) => k.close);
        const highs = klines.map((k) => k.high);
        const lows = klines.map((k) => k.low);
        const volumes = klines.map((k) => k.volume);

        const scored = scoreCandidate({
          closes,
          highs,
          lows,
          volumes,
          minRiskReward: merged.minRiskReward,
          customStrategyCode: merged.customStrategyCode,
        });

        if (!scored.ok) {
          rejected.push({
            symbol: ticker.symbol,
            reason: scored.rejectReason ?? 'network',
          });
          return null;
        }

        const lastPrice = ensureFiniteNumber(ticker.lastPrice, 'lastPrice');
        const lastChangePercent = ensureFiniteNumber(
          ticker.priceChangePercent,
          'priceChangePercent',
        );

        const candidate: ScannedCandidate = {
          symbol: ticker.symbol,
          score: scored.score,
          scoreBreakdown: scored.breakdown,
          entry: scored.entry,
          target: scored.target,
          stop: scored.stop,
          riskReward: scored.rr,
          lastPrice,
          lastChangePercent,
          ema5: scored.ema5,
          ema21: scored.ema21,
          ema144: scored.ema144,
          volMult: scored.volMult,
        };

        return candidate;
      } catch {
        rejected.push({ symbol: ticker.symbol, reason: 'network' });
        return null;
      }
    },
  );

  const picked = candidates.filter((x): x is ScannedCandidate => Boolean(x));
  
  // AI Filtresi ve Önceliklendirme
  const aiFiltered = aiFilterCandidates(picked);
  
  const topCandidates = aiFiltered.slice(
    0,
    Math.max(1, Math.trunc(merged.pickTopK)),
  );

  return {
    asOfMs: Date.now(),
    quoteAsset: merged.quoteAsset,
    topCandidates,
    rejected,
  };
}

function buildLiteCandidatesFromTickers(
  tickers: BinanceTicker24h[],
  options?: ScanOptions,
): ScanResult {
  const merged: Required<ScanOptions> = {
    baseUrl: options?.baseUrl ?? DEFAULTS.baseUrl,
    quoteAsset: options?.quoteAsset ?? DEFAULTS.quoteAsset,
    topNByQuoteVolume: options?.topNByQuoteVolume ?? DEFAULTS.topNByQuoteVolume,
    excludeBases: options?.excludeBases ?? DEFAULTS.excludeBases,
    excludeSymbols: options?.excludeSymbols ?? DEFAULTS.excludeSymbols,
    pickTopK: options?.pickTopK ?? DEFAULTS.pickTopK,
    klineInterval: options?.klineInterval ?? DEFAULTS.klineInterval,
    klineLimit: options?.klineLimit ?? DEFAULTS.klineLimit,
    minRiskReward: options?.minRiskReward ?? DEFAULTS.minRiskReward,
    concurrency: options?.concurrency ?? DEFAULTS.concurrency,
    timeoutMs: options?.timeoutMs ?? DEFAULTS.timeoutMs,
  };

  const universe = filterTopPairsByQuoteVolume(tickers, merged);

  const n = universe.length;
  const k = Math.max(1, Math.trunc(merged.pickTopK));

  const candidates: ScannedCandidate[] = [];
  for (let i = 0; i < universe.length; i += 1) {
    const t = universe[i];
    const symbol = String(t.symbol || '').trim().toUpperCase();
    const lastPrice = ensureFiniteNumber(t.lastPrice, 'lastPrice');
    const lastChangePercent = ensureFiniteNumber(t.priceChangePercent, 'priceChangePercent');
    if (lastChangePercent < 0) continue;
    if (lastChangePercent > 10) continue;

    const volRankScore = n <= 1 ? 60 : 60 * (1 - i / (n - 1));
    const trendScore = 40 * (Math.max(0, Math.min(10, lastChangePercent)) / 10);
    const score = Math.max(0, Math.min(100, Math.round(volRankScore + trendScore)));

    const entry = Number(lastPrice.toFixed(8));
    const stop = Number((entry * 0.97).toFixed(8));
    const riskRaw = (entry - stop) / entry;
    const rr = merged.minRiskReward;
    const target = Number((entry * (1 + Math.max(0, riskRaw) * rr)).toFixed(8));

    candidates.push({
      symbol,
      score,
      scoreBreakdown: {
        freshCross: false,
        trendOk: lastChangePercent >= 0,
        priceAboveEma21: false,
        breakout: false,
        pullbackReclaim: false,
        volMultOk: true,
        ema21SlopeUp: false,
        flatPenalty: false,
        pumpPenalty: false,
      },
      entry,
      target,
      stop,
      riskReward: rr,
      lastPrice,
      lastChangePercent,
      ema5: 0,
      ema21: 0,
      ema144: 0,
      volMult: 0,
    });

    if (candidates.length >= k) break;
  }

  return {
    asOfMs: Date.now(),
    quoteAsset: merged.quoteAsset,
    topCandidates: candidates,
    rejected: [],
  };
}

export async function scanTop3(options?: ScanOptions): Promise<ScanResult> {
  return scanTop({ ...options, pickTopK: 3 });
}

export async function scanTop(options?: ScanOptions): Promise<ScanResult> {
  const tickers = await fetchTicker24h(options);
  const desired = Math.max(1, Math.trunc(options?.pickTopK ?? DEFAULTS.pickTopK));
  try {
    const deep = await runDeepFibonacciEngine(tickers, options);
    if (deep.topCandidates.length > 0) {
      return deep; // 1 tane bile bulsa deep'i döndür, lite sahte sinyallere düşme
    }
  } catch {
  }
  // Yalnızca hiçbir şey bulamazsa veya hata alırsa
  return { asOfMs: Date.now(), quoteAsset: options?.quoteAsset ?? DEFAULTS.quoteAsset, topCandidates: [], rejected: [] };
}
