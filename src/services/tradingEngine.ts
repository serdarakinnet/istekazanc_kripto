import { Platform } from 'react-native';

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
    const timeout = setTimeout(() => controller.abort(), Math.min(1500, timeoutMs));
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
  topNByQuoteVolume: 100,
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
  minRiskReward: 1.8,
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
  const { closes, highs, lows, volumes } = params;
  const lastIndex = closes.length - 1;
  if (lastIndex < 0) {
    return {
      ok: false,
      rejectReason: 'no-klines',
      score: 0,
      breakdown: {
        freshCross: false,
        trendOk: false,
        priceAboveEma21: false,
        breakout: false,
        pullbackReclaim: false,
        volMultOk: false,
        ema21SlopeUp: false,
        flatPenalty: false,
        pumpPenalty: false,
      },
      entry: 0,
      target: 0,
      stop: 0,
      rr: 0,
      ema5: 0,
      ema21: 0,
      ema144: 0,
      volMult: 0,
    };
  }

  if (closes.length < 80 || highs.length !== closes.length || lows.length !== closes.length) {
    return {
      ok: false,
      rejectReason: 'not-enough-data',
      score: 0,
      breakdown: {
        freshCross: false,
        trendOk: false,
        priceAboveEma21: false,
        breakout: false,
        pullbackReclaim: false,
        volMultOk: false,
        ema21SlopeUp: false,
        flatPenalty: false,
        pumpPenalty: false,
      },
      entry: 0,
      target: 0,
      stop: 0,
      rr: 0,
      ema5: 0,
      ema21: 0,
      ema144: 0,
      volMult: 0,
    };
  }

  const ema5Series = emaSeries(closes, 5);
  const ema21Series = emaSeries(closes, 21);
  if (ema5Series.length === 0 || ema21Series.length === 0) {
    return {
      ok: false,
      rejectReason: 'not-enough-data',
      score: 0,
      breakdown: {
        freshCross: false,
        trendOk: false,
        priceAboveEma21: false,
        breakout: false,
        pullbackReclaim: false,
        volMultOk: false,
        ema21SlopeUp: false,
        flatPenalty: false,
        pumpPenalty: false,
      },
      entry: 0,
      target: 0,
      stop: 0,
      rr: 0,
      ema5: 0,
      ema21: 0,
      ema144: 0,
      volMult: 0,
    };
  }

  const ema5 = ema5Series[lastIndex];
  const ema21 = ema21Series[lastIndex];
  const ema144 = 0;

  if (!Number.isFinite(ema5) || !Number.isFinite(ema21)) {
    return {
      ok: false,
      rejectReason: 'not-enough-data',
      score: 0,
      breakdown: {
        freshCross: false,
        trendOk: false,
        priceAboveEma21: false,
        breakout: false,
        pullbackReclaim: false,
        volMultOk: false,
        ema21SlopeUp: false,
        flatPenalty: false,
        pumpPenalty: false,
      },
      entry: 0,
      target: 0,
      stop: 0,
      rr: 0,
      ema5,
      ema21,
      ema144,
      volMult: 0,
    };
  }

  const prevIndex = lastIndex - 1;
  if (prevIndex < 0) {
    return {
      ok: false,
      rejectReason: 'not-enough-data',
      score: 0,
      breakdown: {
        freshCross: false,
        trendOk: false,
        priceAboveEma21: false,
        breakout: false,
        pullbackReclaim: false,
        volMultOk: false,
        ema21SlopeUp: false,
        flatPenalty: false,
        pumpPenalty: false,
      },
      entry: 0,
      target: 0,
      stop: 0,
      rr: 0,
      ema5,
      ema21,
      ema144,
      volMult: 0,
    };
  }

  const prevEma5 = ema5Series[prevIndex];
  const prevEma21 = ema21Series[prevIndex];
  if (!Number.isFinite(prevEma5) || !Number.isFinite(prevEma21)) {
    return {
      ok: false,
      rejectReason: 'not-enough-data',
      score: 0,
      breakdown: {
        freshCross: false,
        trendOk: false,
        priceAboveEma21: false,
        breakout: false,
        pullbackReclaim: false,
        volMultOk: false,
        ema21SlopeUp: false,
        flatPenalty: false,
        pumpPenalty: false,
      },
      entry: 0,
      target: 0,
      stop: 0,
      rr: 0,
      ema5,
      ema21,
      ema144,
      volMult: 0,
    };
  }

  let lastCrossUpBarsAgo = 999;
  const maxLookback = Math.min(20, lastIndex);
  for (let idx = lastIndex; idx >= 1 && lastIndex - idx <= maxLookback; idx -= 1) {
    const e5Prev = ema5Series[idx - 1];
    const e21Prev = ema21Series[idx - 1];
    const e5Now = ema5Series[idx];
    const e21Now = ema21Series[idx];
    if (!Number.isFinite(e5Prev) || !Number.isFinite(e21Prev) || !Number.isFinite(e5Now) || !Number.isFinite(e21Now)) {
      continue;
    }
    if (e5Prev <= e21Prev && e5Now > e21Now) {
      lastCrossUpBarsAgo = lastIndex - idx;
      break;
    }
  }
  const freshCross = lastCrossUpBarsAgo <= 6;

  const lastClose = closes[lastIndex];
  const prevClose = closes[prevIndex];
  const trendOk = ema5 > ema21;
  if (!trendOk) {
    return {
      ok: false,
      rejectReason: 'trend-failed',
      score: 0,
      breakdown: {
        freshCross,
        trendOk: false,
        priceAboveEma21: false,
        breakout: false,
        pullbackReclaim: false,
        volMultOk: false,
        ema21SlopeUp: false,
        flatPenalty: false,
        pumpPenalty: false,
      },
      entry: lastClose,
      target: 0,
      stop: 0,
      rr: 0,
      ema5,
      ema21,
      ema144,
      volMult: 0,
    };
  }

  const priceAboveEma21 = lastClose > ema21;

  const eps = 0.0015;
  const inBarTouch = (low: number, high: number, ma: number): boolean => {
    return low <= ma * (1 + eps) && high >= ma * (1 - eps);
  };

  const touchNow = inBarTouch(lows[lastIndex], highs[lastIndex], ema21);
  const touchPrev = prevIndex >= 0 ? inBarTouch(lows[prevIndex], highs[prevIndex], ema21) : false;
  const prev2Index = lastIndex - 2;
  const touchPrev2 =
    prev2Index >= 0 ? inBarTouch(lows[prev2Index], highs[prev2Index], ema21) : false;
  const touchRecent = touchNow || touchPrev || touchPrev2;

  const breakout = lastClose >= ema21 * 1.003;
  const pullbackReclaim = touchRecent && lastClose > ema21;
  const triggerOk = breakout || pullbackReclaim;
  const entrySignal = trendOk && priceAboveEma21 && freshCross && triggerOk;

  const volAvg40 =
    volumes.length >= 41
      ? volumes.slice(-41, -1).reduce((a, b) => a + b, 0) / 40
      : volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
  const volMult = volAvg40 > 0 ? Number((volumes[lastIndex] / volAvg40).toFixed(2)) : 0;
  const volMultOk = volMult >= 1.0;

  const hh12 = Math.max(...highs.slice(-12));
  const ll12 = Math.min(...lows.slice(-12));
  const range12Pct = Number((((hh12 - ll12) / lastClose) * 100).toFixed(2));
  const flatPenalty = range12Pct < 1.2;

  const ema21_5ago = lastIndex - 5 >= 0 ? ema21Series[lastIndex - 5] : Number.NaN;
  const ema21SlopePct = Number.isFinite(ema21_5ago) ? pctChange(ema21, ema21_5ago) : 0;
  const ema21SlopeUp = ema21SlopePct > 0;

  const chg3 =
    lastIndex - 3 >= 0 && closes[lastIndex - 3] !== 0
      ? Number((((lastClose - closes[lastIndex - 3]) / closes[lastIndex - 3]) * 100).toFixed(2))
      : 0;
  const pumpPenalty = chg3 >= 10 && volMult >= 3.5;

  let score = 0;
  if (freshCross) score += 30;
  if (trendOk) score += 18;
  if (priceAboveEma21) score += 12;
  if (breakout) score += 14;
  if (pullbackReclaim) score += 16;
  if (volMultOk) score += 8;
  if (ema21SlopeUp) score += 10;
  if (flatPenalty) score -= 20;
  if (pumpPenalty) score -= 12;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const stop = Number((ema21 * 0.97).toFixed(8));
  const entry = Number(lastClose.toFixed(8));
  const rrTarget = 1.8;
  const riskRaw = (entry - stop) / entry;

  if (entrySignal && (!Number.isFinite(riskRaw) || riskRaw <= 0)) {
    return {
      ok: false,
      rejectReason: 'invalid-risk',
      score: 0,
      breakdown: {
        freshCross,
        trendOk,
        priceAboveEma21,
        breakout,
        pullbackReclaim,
        volMultOk,
        ema21SlopeUp,
        flatPenalty,
        pumpPenalty,
      },
      entry,
      target: 0,
      stop,
      rr: 0,
      ema5,
      ema21,
      ema144,
      volMult,
    };
  }

  const target = Number((entry * (1 + Math.max(0, riskRaw) * rrTarget)).toFixed(8));
  const rr = rrTarget;

  if (!entrySignal) {
    return {
      ok: false,
      rejectReason: 'entry-failed',
      score,
      breakdown: {
        freshCross,
        trendOk,
        priceAboveEma21,
        breakout,
        pullbackReclaim,
        volMultOk,
        ema21SlopeUp,
        flatPenalty,
        pumpPenalty,
      },
      entry,
      target,
      stop,
      rr,
      ema5,
      ema21,
      ema144,
      volMult,
    };
  }

  if (score < 55) {
    return {
      ok: false,
      rejectReason: 'score-low',
      score,
      breakdown: {
        freshCross,
        trendOk,
        priceAboveEma21,
        breakout,
        pullbackReclaim,
        volMultOk,
        ema21SlopeUp,
        flatPenalty,
        pumpPenalty,
      },
      entry,
      target,
      stop,
      rr,
      ema5,
      ema21,
      ema144,
      volMult,
    };
  }

  const breakdown: ScoreBreakdown = {
    freshCross,
    trendOk,
    priceAboveEma21,
    breakout,
    pullbackReclaim,
    volMultOk,
    ema21SlopeUp,
    flatPenalty,
    pumpPenalty,
  };

  return {
    ok: true,
    rejectReason: null,
    score,
    breakdown,
    entry,
    target,
    stop,
    rr,
    ema5,
    ema21,
    ema144,
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

  let filteredTickers = tickers;
  try {
    const allowed = await fetchBinanceTrAllowedSymbols({
      quoteAsset: merged.quoteAsset,
      timeoutMs: merged.timeoutMs,
    });
    filteredTickers = tickers.filter((t) => allowed.has(String(t.symbol).trim().toUpperCase()));
  } catch {
    filteredTickers = tickers;
  }

  const universe = filterTopPairsByQuoteVolume(filteredTickers, merged);
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
  const topCandidates = sortDescNumeric(picked, (c) => c.score).slice(
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
    if (deep.topCandidates.length >= Math.min(3, desired) && deep.topCandidates.length > 0) {
      return deep;
    }
  } catch {
  }
  return buildLiteCandidatesFromTickers(tickers, options);
}
