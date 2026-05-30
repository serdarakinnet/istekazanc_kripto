const crypto = require('crypto');

const cors = require('cors');
const express = require('express');

const { pool, getSafeConnectionInfo } = require('./db');
const { migrate } = require('./migrate');

function nowMs() {
  return Date.now();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateSaltHex() {
  return crypto.randomBytes(16).toString('hex');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

function deriveApiCredKey() {
  const material = String(process.env.API_CREDENTIALS_MASTER_KEY || process.env.POSTGRES_PASSWORD || 'bist-dev');
  return crypto.createHash('sha256').update(material).digest();
}

function encryptText(plain) {
  const key = deriveApiCredKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function decryptText(enc) {
  const iv = Buffer.from(String(enc?.iv || ''), 'base64');
  const tag = Buffer.from(String(enc?.tag || ''), 'base64');
  const ct = Buffer.from(String(enc?.ct || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) throw new Error('Invalid encrypted payload');
  const key = deriveApiCredKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return plain;
}

function errorResponse(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireInternalToken(req, res) {
  const expected = String(process.env.INTERNAL_API_TOKEN || '').trim();
  if (!expected) return errorResponse(res, 503, 'INTERNAL_API_TOKEN eksik.');
  const provided = String(req.headers['x-internal-token'] || '').trim();
  if (!provided || provided !== expected) return errorResponse(res, 401, 'Yetkisiz.');
  return null;
}

function dbUnavailable(res) {
  return errorResponse(res, 503, 'Veritabanına bağlanılamadı.');
}

function normalizeQuoteAsset(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function readAllowedSymbolsTryFromEnv() {
  const raw = String(process.env.ALLOWED_SYMBOLS_TRY || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => normalizeSymbol(s))
    .filter(Boolean)
    .filter((s) => s.endsWith('TRY'));
}

function httpError(status, message, details) {
  const e = new Error(message);
  e.status = status;
  e.details = details;
  return e;
}

function assertQuoteAssetTry(quoteAsset) {
  const qa = normalizeQuoteAsset(quoteAsset);
  if (qa !== 'TRY') {
    throw httpError(400, 'Sadece quoteAsset=TRY desteklenir.', { quoteAsset: qa });
  }
}

function assertSymbolTryPair(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym.endsWith('TRY')) {
    throw httpError(400, 'Sadece TRY pariteleri desteklenir.', { symbol: sym });
  }
}

function validateBinanceKlinesArray(klines) {
  if (!Array.isArray(klines)) {
    return { ok: false, error: 'klines array olmalı.' };
  }
  if (klines.length === 0) {
    return { ok: false, error: 'klines boş olamaz.' };
  }

  for (let i = 0; i < klines.length; i += 1) {
    const k = klines[i];
    if (!Array.isArray(k)) {
      return { ok: false, error: 'kline array formatında olmalı.', index: i };
    }
    if (k.length < 11) {
      return { ok: false, error: 'kline formatı eksik (en az 11 alan).', index: i, length: k.length };
    }

    const openTime = Number(k[0]);
    const open = Number(k[1]);
    const high = Number(k[2]);
    const low = Number(k[3]);
    const close = Number(k[4]);
    const volume = Number(k[5]);
    const closeTime = Number(k[6]);

    if (!Number.isFinite(openTime) || openTime <= 0) return { ok: false, error: 'openTime geçersiz.', index: i };
    if (!Number.isFinite(closeTime) || closeTime <= 0) return { ok: false, error: 'closeTime geçersiz.', index: i };

    if (!Number.isFinite(open) || open <= 0) return { ok: false, error: 'open geçersiz.', index: i };
    if (!Number.isFinite(high) || high <= 0) return { ok: false, error: 'high geçersiz.', index: i };
    if (!Number.isFinite(low) || low <= 0) return { ok: false, error: 'low geçersiz.', index: i };
    if (!Number.isFinite(close) || close <= 0) return { ok: false, error: 'close geçersiz.', index: i };
    if (!Number.isFinite(volume) || volume < 0) return { ok: false, error: 'volume geçersiz.', index: i };

    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      return { ok: false, error: 'OHLC tutarsız.', index: i };
    }
  }

  return { ok: true };
}

function createApp() {
  const dbState = { ready: false, lastError: null };
  let initPromise = null;
  const binanceTrSymbolsState = { expiresAtMs: 0, quoteAsset: null, symbols: [] };

  const initDb = async () => {
    if (dbState.ready) return;
    try {
      await migrate();
      dbState.ready = true;
      dbState.lastError = null;
    } catch (e) {
      dbState.ready = false;
      dbState.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  };

  const ensureDbReady = async () => {
    if (dbState.ready) return;
    if (!initPromise) {
      initPromise = initDb().catch(() => {
        initPromise = null; // Reset on failure so it can be retried
      });
    }
    return initPromise;
  };

  // Start initialization
  void ensureDbReady();

  const app = express();
  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: '1mb' }));

  const wrapAsync = (handler) => {
    return (req, res, next) => {
      Promise.resolve(handler(req, res, next)).catch(next);
    };
  };

  app.get('/diag/api-check', wrapAsync(async (req, res) => {
    const results = {};
    const targets = [
      { name: 'Binance TR Symbols', url: 'https://www.binance.tr/open/v1/common/symbols' },
      { name: 'Binance Vision API', url: 'https://data-api.binance.vision/api/v3/ping' },
      { name: 'Binance Main API', url: 'https://api.binance.com/api/v3/ping' },
      { name: 'Binance Data API', url: 'https://data.binance.com/api/v3/ping' },
    ];

    for (const target of targets) {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(target.url, {
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          }
        });
        clearTimeout(timeout);
        results[target.name] = {
          status: r.status,
          ok: r.ok,
          duration: Date.now() - start,
          headers: {
            'x-mbx-used-weight-1m': r.headers.get('x-mbx-used-weight-1m'),
            'cf-ray': r.headers.get('cf-ray'), // Cloudflare info
            'server': r.headers.get('server'),
          }
        };
      } catch (e) {
        results[target.name] = {
          error: e instanceof Error ? e.message : String(e),
          duration: Date.now() - start
        };
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      platform: process.platform,
      nodeVersion: process.version,
      env: {
        VERCEL: process.env.VERCEL || 'false',
        REGION: process.env.VERCEL_REGION || 'unknown'
      },
      results
    });
  }));

  app.get('/health', wrapAsync(async (_req, res) => {
    const connInfo = getSafeConnectionInfo();
    if (!dbState.ready) {
      await ensureDbReady();
    }

    if (!dbState.ready) {
      return res.status(503).json({
        ok: false,
        dbReady: false,
        error: 'Veritabanına bağlanılamadı.',
        details: dbState.lastError,
        connection: connInfo,
      });
    }

    try {
      await pool.query('SELECT 1');
      return res.json({ ok: true, dbReady: true, connection: connInfo });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        dbReady: false,
        error: 'Veritabanına bağlanılamadı.',
        details: e instanceof Error ? e.message : String(e),
        connection: connInfo,
      });
    }
  }));

  app.get('/market/health', wrapAsync(async (req, res) => {
    const timeoutMsRaw = typeof req.query?.timeoutMs === 'string' ? Number(req.query.timeoutMs) : NaN;
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(500, Math.min(5000, timeoutMsRaw)) : 2500;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch('https://data-api.binance.vision/api/v3/ping', {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      });
      if (!r.ok) {
        return res.status(503).json({ ok: false, status: r.status });
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(503).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timeout);
    }
  }));

  app.use(wrapAsync(async (req, res, next) => {
    if (
      req.path === '/health' ||
      req.path === '/market/health' ||
      req.path === '/binance-tr/symbols' ||
      req.path === '/market/last-price' ||
      req.path === '/market/last-prices' ||
      req.path === '/market/ticker/24hr' ||
      req.path === '/market/klines' ||
      req.path === '/scan/top' ||
      req.path === '/scan'
    ) {
      return next();
    }

    // In serverless environments, we must wait for DB to be ready
    if (!dbState.ready) {
      await ensureDbReady();
    }

    if (!dbState.ready) {
      return errorResponse(res, 503, 'Veritabanına bağlanılamadı.');
    }
    return next();
  }));

  app.get('/binance-tr/symbols', async (req, res) => {
    const quoteAssetRaw = typeof req.query?.quoteAsset === 'string' ? req.query.quoteAsset : '';
    const quoteAsset = (quoteAssetRaw || 'TRY').trim().toUpperCase();
    const now = nowMs();

    try {
      assertQuoteAssetTry(quoteAsset);
    } catch (e) {
      return errorResponse(res, e?.status || 400, e instanceof Error ? e.message : 'Geçersiz quoteAsset.');
    }

    if (binanceTrSymbolsState.expiresAtMs > now && binanceTrSymbolsState.quoteAsset === quoteAsset) {
      return res.json({ ok: true, quoteAsset, symbols: binanceTrSymbolsState.symbols });
    }

    let symbols = [];
    let fetchError = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const r = await fetch('https://www.binance.tr/open/v1/common/symbols', {
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        }
      });
      clearTimeout(timeout);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      const list = body?.data?.list;
      if (Array.isArray(list)) {
        symbols = list
          .map((x) => (typeof x?.symbol === 'string' ? x.symbol : ''))
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
          .filter((s) => s.endsWith(`_${quoteAsset}`))
          .map((s) => s.replace('_', ''));
      }
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e);
    }

    if (symbols.length > 0) {
      binanceTrSymbolsState.expiresAtMs = now + 10 * 60_000;
      binanceTrSymbolsState.quoteAsset = quoteAsset;
      binanceTrSymbolsState.symbols = symbols;
      return res.json({ ok: true, quoteAsset, symbols });
    }

    const envSymbols = readAllowedSymbolsTryFromEnv();
    if (envSymbols.length > 0) {
      binanceTrSymbolsState.expiresAtMs = now + 10 * 60_000;
      binanceTrSymbolsState.quoteAsset = quoteAsset;
      binanceTrSymbolsState.symbols = envSymbols;
      return res.status(200).json({ ok: true, quoteAsset, symbols: envSymbols, source: 'env' });
    }

    if (binanceTrSymbolsState.quoteAsset === quoteAsset && Array.isArray(binanceTrSymbolsState.symbols) && binanceTrSymbolsState.symbols.length > 0) {
      return res.status(200).json({ ok: true, quoteAsset, symbols: binanceTrSymbolsState.symbols, stale: true });
    }

    return res.status(503).json({ ok: false, quoteAsset, symbols: [], error: fetchError || 'Binance TR symbols alınamadı.' });
  });

  const BINANCE_HTTP_BASES = [
    'https://data-api.binance.vision',
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://api4.binance.com',
    'https://data.binance.com',
  ];

  function buildBinanceUrl(baseUrl, path, params) {
    const url = new URL(path, baseUrl);
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async function fetchJsonFromBinance(path, params, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let lastError = null;
      for (const baseUrl of BINANCE_HTTP_BASES) {
        const url = buildBinanceUrl(baseUrl, path, params);
        try {
          const r = await fetch(url, {
            signal: controller.signal,
            headers: {
              accept: 'application/json',
              'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
          });
          if (!r.ok) {
            lastError = new Error(`HTTP ${r.status}`);
            continue;
          }
          return await r.json();
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          continue;
        }
      }
      throw lastError ?? new Error('HTTP request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchBinanceVisionLastPrice(symbol, timeoutMs) {
    const body = await fetchJsonFromBinance('/api/v3/ticker/price', { symbol }, timeoutMs);
    const priceRaw = body?.price;
    const price = typeof priceRaw === 'number' ? priceRaw : Number(priceRaw);
    if (!Number.isFinite(price)) throw new Error('Invalid price');
    return price;
  }

  const ticker24hCache = { expiresAtMs: 0, data: null };
  const klinesCache = new Map();

  async function fetchBinanceVisionTicker24h(timeoutMs) {
    const now = nowMs();
    if (ticker24hCache.expiresAtMs > now && Array.isArray(ticker24hCache.data)) {
      return ticker24hCache.data;
    }

    try {
      const body = await fetchJsonFromBinance('/api/v3/ticker/24hr', null, timeoutMs);
      if (!Array.isArray(body)) throw new Error('Invalid response');
      ticker24hCache.expiresAtMs = now + 10_000;
      ticker24hCache.data = body;
      return body;
    } catch (e) {
      if (Array.isArray(ticker24hCache.data)) return ticker24hCache.data;
      throw e;
    }
  }

  async function fetchBinanceVisionKlines(params) {
    const now = nowMs();
    const key = `${params.symbol}|${params.interval}|${params.limit}`;
    const cached = klinesCache.get(key);
    if (cached && cached.expiresAtMs > now && Array.isArray(cached.data)) {
      return cached.data;
    }

    try {
      const body = await fetchJsonFromBinance(
        '/api/v3/klines',
        { symbol: params.symbol, interval: params.interval, limit: params.limit },
        params.timeoutMs,
      );
      if (!Array.isArray(body)) throw new Error('Invalid response');
      klinesCache.set(key, { expiresAtMs: now + 10_000, data: body });
      return body;
    } catch (e) {
      if (cached && Array.isArray(cached.data)) return cached.data;
      throw e;
    }
  }

  app.get('/market/last-price', async (req, res) => {
    const symbolRaw = typeof req.query?.symbol === 'string' ? req.query.symbol : '';
    const symbol = String(symbolRaw || '').trim().toUpperCase();
    if (!symbol) return errorResponse(res, 400, 'Sembol zorunlu.');

    const timeoutMsRaw = typeof req.query?.timeoutMs === 'string' ? Number(req.query.timeoutMs) : NaN;
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.min(5000, timeoutMsRaw)) : 4000;

    try {
      const price = await fetchBinanceVisionLastPrice(symbol, timeoutMs);
      return res.json({ ok: true, symbol, price });
    } catch (e) {
      return res.json({ ok: false, symbol, price: null, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/market/last-prices', async (req, res) => {
    const input = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    const rawSymbols = input.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean);
    const symbols = Array.from(new Set(rawSymbols)).slice(0, 60);
    if (symbols.length === 0) return res.json({ ok: true, prices: {} });

    const timeoutMsRaw = Number(req.body?.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.min(5000, timeoutMsRaw)) : 4000;

    const prices = {};
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const price = await fetchBinanceVisionLastPrice(symbol, timeoutMs);
          prices[symbol] = price;
        } catch {
        }
      }),
    );

    return res.json({ ok: true, prices });
  });

  app.get('/market/ticker/24hr', async (req, res) => {
    const timeoutMsRaw = typeof req.query?.timeoutMs === 'string' ? Number(req.query.timeoutMs) : NaN;
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.min(5000, timeoutMsRaw)) : 4000;
    try {
      const data = await fetchBinanceVisionTicker24h(timeoutMs);
      return res.json({ ok: true, data });
    } catch (e) {
      return res.json({ ok: false, data: [], error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/market/klines', async (req, res) => {
    const symbolRaw = typeof req.query?.symbol === 'string' ? req.query.symbol : '';
    const symbol = String(symbolRaw || '').trim().toUpperCase();
    if (!symbol) return errorResponse(res, 400, 'Sembol zorunlu.');

    const intervalRaw = typeof req.query?.interval === 'string' ? req.query.interval : '';
    const interval = String(intervalRaw || '1h').trim();
    if (!interval) return errorResponse(res, 400, 'Interval zorunlu.');

    const limitRaw = typeof req.query?.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 200;

    const timeoutMsRaw = typeof req.query?.timeoutMs === 'string' ? Number(req.query.timeoutMs) : NaN;
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.min(5000, timeoutMsRaw)) : 4000;

    try {
      const data = await fetchBinanceVisionKlines({ symbol, interval, limit, timeoutMs });
      return res.json({ ok: true, data });
    } catch (e) {
      return res.json({ ok: false, data: [], error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/scan/top', async (req, res) => {
    function clamp(n, min, max) {
      const x = Number(n);
      if (!Number.isFinite(x)) return min;
      return Math.max(min, Math.min(max, x));
    }

    function toNum(v, d = Number.NaN) {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    }

    function pct(a, b) {
      if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
      return ((a - b) / b) * 100;
    }

    function calcEMA(data, p) {
      if (!Array.isArray(data) || data.length < p) return null;
      const k = 2 / (p + 1);
      let e = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
      for (let i = p; i < data.length; i++) e = data[i] * k + e * (1 - k);
      return +e.toFixed(6);
    }

    function calcEmaSeries(data, p) {
      if (!Array.isArray(data) || data.length < p) return null;
      const k = 2 / (p + 1);
      const out = new Array(data.length).fill(null);
      let e = 0;
      for (let i = 0; i < p; i += 1) e += data[i];
      e /= p;
      out[p - 1] = e;
      for (let i = p; i < data.length; i += 1) {
        e = data[i] * k + e * (1 - k);
        out[i] = e;
      }
      return out;
    }

    function calcRSI(data, p = 14) {
      if (!Array.isArray(data) || data.length < p + 1) return null;
      let g = 0, l = 0;
      for (let i = 1; i <= p; i++) {
        const d = data[i] - data[i - 1];
        if (d > 0) g += d;
        else l -= d;
      }
      let ag = g / p, al = l / p;
      for (let i = p + 1; i < data.length; i++) {
        const d = data[i] - data[i - 1];
        ag = (ag * (p - 1) + Math.max(d, 0)) / p;
        al = (al * (p - 1) + Math.max(-d, 0)) / p;
      }
      if (al === 0) return 100;
      return +(100 - 100 / (1 + ag / al)).toFixed(2);
    }

    function calcATR(h, l, c, p = 14) {
      if (!Array.isArray(h) || h.length < p + 1) return null;
      const trs = [];
      for (let i = 1; i < h.length; i++) {
        trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
      }
      if (trs.length < p) return null;
      return +(trs.slice(-p).reduce((a, b) => a + b, 0) / p).toFixed(6);
    }

    function calcMACD(data) {
      if (!Array.isArray(data) || data.length < 35) return null;
      const series = [];
      for (let i = 26; i <= data.length; i++) {
        const e12 = calcEMA(data.slice(0, i), 12);
        const e26 = calcEMA(data.slice(0, i), 26);
        if (e12 != null && e26 != null) series.push(e12 - e26);
      }
      if (!series.length) return null;
      const macd = series[series.length - 1];
      const signal = calcEMA(series, 9);
      const hist = signal == null ? null : +(macd - signal).toFixed(6);
      return { macd: +macd.toFixed(6), signal, hist };
    }

    function avg(values) {
      if (!Array.isArray(values) || values.length === 0) return 0;
      let sum = 0;
      for (const v of values) sum += Number(v) || 0;
      return sum / values.length;
    }

    const quoteAsset = String(req.query?.quoteAsset || 'TRY').trim().toUpperCase() || 'TRY';
    try {
      assertQuoteAssetTry(quoteAsset);
    } catch (e) {
      return errorResponse(res, e?.status || 400, e instanceof Error ? e.message : 'Geçersiz quoteAsset.');
    }
    const desired = clamp(req.query?.pickTopK ?? req.query?.desired ?? 3, 1, 3);
    const timeoutMs = clamp(req.query?.timeoutMs ?? 4000, 1000, 5000);
    const maxTickers = clamp(req.query?.maxTickers ?? 60, 20, 200);
    const concurrency = clamp(req.query?.concurrency ?? 3, 1, 3);
    const excludeBases = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'PAXG', 'XAUT']);

    let allowedSymbolsSet = null;
    try {
      const now = nowMs();
      if (binanceTrSymbolsState.expiresAtMs > now && binanceTrSymbolsState.quoteAsset === quoteAsset && binanceTrSymbolsState.symbols.length > 0) {
        allowedSymbolsSet = new Set(binanceTrSymbolsState.symbols);
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const r = await fetch(`https://www.binance.tr/open/v1/common/symbols`, {
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        });
        clearTimeout(timeout);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        const list = body?.data?.list;
        const symbols = Array.isArray(list)
          ? list
            .map((x) => (typeof x?.symbol === 'string' ? x.symbol : ''))
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
            .filter((s) => s.endsWith(`_${quoteAsset}`))
            .map((s) => s.replace('_', ''))
          : [];
        if (symbols.length === 0) throw new Error('No symbols');
        binanceTrSymbolsState.expiresAtMs = now + 10 * 60_000;
        binanceTrSymbolsState.quoteAsset = quoteAsset;
        binanceTrSymbolsState.symbols = symbols;
        allowedSymbolsSet = new Set(symbols);
      }
    } catch (e) {
      const envSymbols = readAllowedSymbolsTryFromEnv();
      if (envSymbols.length > 0) {
        allowedSymbolsSet = new Set(envSymbols);
      } else {
      return res.status(503).json({
        ok: false,
        error: 'Binance TR sembol listesi alınamadı.',
        details: e instanceof Error ? e.message : String(e),
      });
      }
    }

    const CONFIG = {
      crossLookbackBars: 3,
      maxEntryBarsAfterCross: 3,
      rejectIfCrossOlderThanBars: 3,
      maxMoveSinceCrossPct: 7.0,
      maxMoveAfterCrossToEma21Pct: 8.0,
      maxMoveAfterCrossToEma5Pct: 4.5,
      maxPostCrossVolumeMult: 3.2,
      maxPostCrossCandlePct: 6.0,
      maxPostCrossRangePct: 9.0,
      maxCurrentCandleBodyPctForEntry: 5.0,
      maxCurrentCandleRangePctForEntry: 8.0,
      minRR: 1.5,
      minCandidateScore: 55,
      rrMinClamp: 1.2,
      rrMaxClamp: 3.2,
    };

    let tickers;
    try {
      tickers = await fetchBinanceVisionTicker24h(timeoutMs);
    } catch (e) {
      return res.status(503).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }

    const tryTickers = (Array.isArray(tickers) ? tickers : [])
      .filter((t) => typeof t?.symbol === 'string' && String(t.symbol).toUpperCase().endsWith(quoteAsset))
      .filter((t) => allowedSymbolsSet.has(String(t.symbol).toUpperCase()))
      .filter((t) => {
        const sym = String(t.symbol).toUpperCase();
        const base = sym.slice(0, Math.max(0, sym.length - quoteAsset.length));
        if (!base) return false;
        if (excludeBases.has(base)) return false;
        return true;
      })
      .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
      .slice(0, maxTickers);

    const built = [];

    function evaluateSymbol(params) {
      const symbol = String(params.symbol || '').trim().toUpperCase();
      const t = params.ticker;
      const opens = params.opens;
      const highs = params.highs;
      const lows = params.lows;
      const closes = params.closes;
      const volumes = params.volumes;

      const price = closes[closes.length - 1];
      const lastPrice = toNum(t?.lastPrice, price);
      const lastChangePercent = toNum(t?.priceChangePercent, 0);

      const e5 = calcEMA(closes, 5);
      const e21 = calcEMA(closes, 21);
      const e55 = calcEMA(closes, 55);
      const e144 = calcEMA(closes, 144);
      const rsi = calcRSI(closes, 14);
      const atr = calcATR(highs, lows, closes, 14);
      const macd = calcMACD(closes);
      if ([e5, e21, e55, e144, rsi, atr].some((v) => v == null) || !macd) return null;

      const vol20avg = avg(volumes.slice(-20));
      const volMult = vol20avg > 0 ? +(volumes[volumes.length - 1] / vol20avg).toFixed(2) : 0;

      const e5Series = calcEmaSeries(closes, 5);
      const e21Series = calcEmaSeries(closes, 21);
      let crossIndex = null;
      if (e5Series && e21Series) {
        for (let i = closes.length - 1; i >= 1 && i >= closes.length - 40; i -= 1) {
          const p5 = e5Series[i - 1];
          const p21 = e21Series[i - 1];
          const c5 = e5Series[i];
          const c21 = e21Series[i];
          if (Number.isFinite(p5) && Number.isFinite(p21) && Number.isFinite(c5) && Number.isFinite(c21)) {
            if (p5 <= p21 && c5 > c21) {
              crossIndex = i;
              break;
            }
          }
        }
      }

      const lastIndex = closes.length - 1;
      const crossBarsAgo = crossIndex == null ? null : lastIndex - crossIndex;
      const prevE5 = e5Series && lastIndex - 1 >= 0 ? e5Series[lastIndex - 1] : null;
      const prevE21 = e21Series && lastIndex - 1 >= 0 ? e21Series[lastIndex - 1] : null;
      const freshCrossNow =
        crossBarsAgo === 0 &&
        prevE5 != null &&
        prevE21 != null &&
        Number.isFinite(prevE5) &&
        Number.isFinite(prevE21) &&
        prevE5 <= prevE21 &&
        e5 > e21;

      const recentCross = crossBarsAgo != null && crossBarsAgo <= CONFIG.maxEntryBarsAfterCross;
      const validCrossWindow = crossBarsAgo != null && crossBarsAgo >= 0 && crossBarsAgo <= CONFIG.rejectIfCrossOlderThanBars;
      const crossTooOld = crossBarsAgo == null || crossBarsAgo > CONFIG.rejectIfCrossOlderThanBars;

      let postCrossBarsAnalyzed = 0;
      let moveSinceCrossPct = 0;
      let maxPostCrossVolMult = 0;
      let maxPostCrossCandlePct = 0;
      let maxPostCrossRangePct = 0;
      let postCrossPumpDetected = false;

      if (crossIndex != null) {
        const crossClose = closes[crossIndex];
        moveSinceCrossPct = pct(price, crossClose);
        for (let i = crossIndex; i <= lastIndex; i += 1) {
          postCrossBarsAnalyzed += 1;
          const o = opens[i];
          const h = highs[i];
          const l = lows[i];
          const c = closes[i];
          const v = volumes[i];

          const bodyPct = o > 0 ? (Math.abs(c - o) / o) * 100 : 0;
          const rangePct = l > 0 ? ((h - l) / l) * 100 : 0;
          const volAvg = avg(volumes.slice(Math.max(0, i - 20), i));
          const candleVolMult = volAvg > 0 ? v / volAvg : 0;

          maxPostCrossVolMult = Math.max(maxPostCrossVolMult, candleVolMult);
          maxPostCrossCandlePct = Math.max(maxPostCrossCandlePct, bodyPct);
          maxPostCrossRangePct = Math.max(maxPostCrossRangePct, rangePct);

          if (
            bodyPct > CONFIG.maxPostCrossCandlePct ||
            rangePct > CONFIG.maxPostCrossRangePct ||
            candleVolMult > CONFIG.maxPostCrossVolumeMult
          ) {
            postCrossPumpDetected = true;
          }
        }
      }

      moveSinceCrossPct = +moveSinceCrossPct.toFixed(2);
      maxPostCrossVolMult = +maxPostCrossVolMult.toFixed(2);
      maxPostCrossCandlePct = +maxPostCrossCandlePct.toFixed(2);
      maxPostCrossRangePct = +maxPostCrossRangePct.toFixed(2);

      const lastOpen = opens[lastIndex];
      const lastHigh = highs[lastIndex];
      const lastLow = lows[lastIndex];
      const lastClose = closes[lastIndex];
      const currentBodyPct = lastOpen > 0 ? (Math.abs(lastClose - lastOpen) / lastOpen) * 100 : 0;
      const currentRangePct = lastLow > 0 ? ((lastHigh - lastLow) / lastLow) * 100 : 0;
      const currentCandleTooAggressive =
        currentBodyPct > CONFIG.maxCurrentCandleBodyPctForEntry ||
        currentRangePct > CONFIG.maxCurrentCandleRangePctForEntry;

      const distPriceEma21Pct = e21 > 0 ? (Math.abs(price - e21) / e21) * 100 : 999;
      const distPriceEma5Pct = e5 > 0 ? (Math.abs(price - e5) / e5) * 100 : 999;
      const moveSinceCrossTooHigh = moveSinceCrossPct > CONFIG.maxMoveSinceCrossPct;
      const priceTooFarAfterCross =
        distPriceEma21Pct > CONFIG.maxMoveAfterCrossToEma21Pct ||
        distPriceEma5Pct > CONFIG.maxMoveAfterCrossToEma5Pct;

      const lateEntryTrap =
        crossTooOld ||
        !validCrossWindow ||
        moveSinceCrossTooHigh ||
        distPriceEma21Pct > CONFIG.maxMoveAfterCrossToEma21Pct ||
        distPriceEma5Pct > CONFIG.maxMoveAfterCrossToEma5Pct ||
        postCrossPumpDetected ||
        currentCandleTooAggressive;

      const ema5Above21 = e5 > e21;
      const emaRuleStrict =
        ema5Above21 &&
        price > e5 &&
        validCrossWindow &&
        !lateEntryTrap &&
        (freshCrossNow || recentCross);

      const cleanMomentum = rsi >= 50 && macd.hist != null && macd.hist > 0 && ema5Above21 && price > e5;
      const volumeOk = volMult >= 1.1;
      const isPump =
        postCrossPumpDetected ||
        currentCandleTooAggressive ||
        moveSinceCrossTooHigh ||
        priceTooFarAfterCross;

      let dynamicRR = 2.25;
      if (ema5Above21) dynamicRR += 0.1;
      if (e5 > e55 && e55 > e144) dynamicRR += 0.25;
      if (price > e5) dynamicRR += 0.1;
      if (rsi >= 52 && rsi <= 68) dynamicRR += 0.15;
      if (macd.hist != null && macd.hist > 0) dynamicRR += 0.15;
      if (volMult >= 1.25) dynamicRR += 0.1;

      if (crossTooOld) dynamicRR -= 0.6;
      if (lateEntryTrap) dynamicRR -= 0.8;
      if (postCrossPumpDetected) dynamicRR -= 0.7;
      if (moveSinceCrossTooHigh) dynamicRR -= 0.5;
      dynamicRR = clamp(dynamicRR, CONFIG.rrMinClamp, CONFIG.rrMaxClamp);

      const stopLoss = e21 * 0.97;
      const risk = price - stopLoss;
      const takeProfit = risk > 0 ? price + risk * dynamicRR : 0;
      const riskReward = risk > 0 ? dynamicRR : 0;

      let score = 55;
      const warnings = [];
      if (freshCrossNow) score += 10;
      else if (crossBarsAgo === 1) score += 8;
      else if (crossBarsAgo === 2) score += 5;
      else if (crossBarsAgo === 3) {
        score += 2;
        warnings.push('Cross 3 bar önce: giriş penceresinin son sınırı.');
      } else {
        score -= 35;
        warnings.push('Cross eski veya bulunamadı: giriş reddedildi.');
      }

      if (crossTooOld) score -= 30;
      if (lateEntryTrap) score -= 35;
      if (postCrossPumpDetected) score -= 30;
      if (moveSinceCrossTooHigh) score -= 18;
      if (priceTooFarAfterCross) score -= 18;
      if (currentCandleTooAggressive) score -= 20;

      if (e5 > e21) score += 6;
      if (e5 > e55) score += 4;
      if (e55 > e144) score += 4;
      if (price > e5) score += 4;
      if (rsi >= 50) score += 4;
      if (macd.hist != null && macd.hist > 0) score += 4;
      if (volMult >= 1.1) score += 4;

      score = Math.round(clamp(score, 0, 100));
      const tier = score >= 85 ? 'A' : score >= 70 ? 'B' : 'C';

      const tradeEligible =
        emaRuleStrict &&
        validCrossWindow &&
        !crossTooOld &&
        !lateEntryTrap &&
        cleanMomentum &&
        volumeOk &&
        !isPump &&
        risk > 0 &&
        riskReward >= CONFIG.minRR &&
        score >= CONFIG.minCandidateScore;

      const reasons = [];
      if (!ema5Above21) reasons.push('EMA5 <= EMA21');
      if (!(price > e5)) reasons.push('Fiyat EMA5 üstünde değil');
      if (!validCrossWindow) reasons.push('Cross giriş penceresinde değil');
      if (crossTooOld) reasons.push('Cross çok eski veya yok');
      if (lateEntryTrap) reasons.push('Geç giriş tuzağı');
      if (!cleanMomentum) reasons.push('Momentum temiz değil (RSI/MACD)');
      if (!volumeOk) reasons.push('Hacim yetersiz');
      if (isPump) reasons.push('Pump riski');
      if (!(risk > 0)) reasons.push('Risk hesaplanamadı');
      if (!(riskReward >= CONFIG.minRR)) reasons.push(`RR < ${CONFIG.minRR}`);
      if (!(score >= CONFIG.minCandidateScore)) reasons.push(`Skor < ${CONFIG.minCandidateScore}`);

      const hitRules = [
        `ema5Above21=${ema5Above21}`,
        `price>ema5=${price > e5}`,
        `freshCrossNow=${freshCrossNow}`,
        `recentCross=${recentCross}`,
        `validCrossWindow=${validCrossWindow}`,
        `crossTooOld=${crossTooOld}`,
        `lateEntryTrap=${lateEntryTrap}`,
        `postCrossPumpDetected=${postCrossPumpDetected}`,
        `currentCandleTooAggressive=${currentCandleTooAggressive}`,
      ].join(', ');

      const scoreDetail = [
        `score=${score}`,
        `tier=${tier}`,
        `crossBarsAgo=${crossBarsAgo == null ? 'null' : crossBarsAgo}`,
        `moveSinceCrossPct=${moveSinceCrossPct}`,
        `distEma21Pct=${distPriceEma21Pct.toFixed(2)}`,
        `distEma5Pct=${distPriceEma5Pct.toFixed(2)}`,
        `maxPostCrossVolMult=${maxPostCrossVolMult}`,
        `maxPostCrossBodyPct=${maxPostCrossCandlePct}`,
        `maxPostCrossRangePct=${maxPostCrossRangePct}`,
        `volMult=${volMult.toFixed(2)}`,
        `rsi=${rsi.toFixed(2)}`,
        `macdHist=${macd.hist == null ? 'null' : macd.hist.toFixed(6)}`,
        `dynamicRR=${riskReward.toFixed(2)}`,
      ].join(' | ');

      return {
        symbol,
        score,
        tier,
        action: tradeEligible ? 'BUY' : 'WATCHLIST',
        tradeEligible,
        reasons,
        warnings,
        hitRules,
        scoreDetail,
        scoreBreakdown: {
          freshCross: Boolean(freshCrossNow),
          trendOk: Boolean(ema5Above21),
          priceAboveEma21: e21 > 0 ? price >= e21 : false,
          breakout: false,
          pullbackReclaim: Boolean(ema5Above21),
          volMultOk: Boolean(volMult >= 1.1),
          ema21SlopeUp: false,
          flatPenalty: false,
          pumpPenalty: Boolean(isPump),
        },
        entry: Number(price.toFixed(6)),
        target: Number(takeProfit.toFixed(6)),
        stop: Number(stopLoss.toFixed(6)),
        riskReward: Number(riskReward.toFixed(2)),
        lastPrice: Number(lastPrice.toFixed(6)),
        lastChangePercent: Number(lastChangePercent.toFixed(2)),
        ema5: Number(e5.toFixed(6)),
        ema21: Number(e21.toFixed(6)),
        ema55: Number(e55.toFixed(6)),
        ema144: Number(e144.toFixed(6)),
        e5: Number(e5.toFixed(6)),
        e21: Number(e21.toFixed(6)),
        e55: Number(e55.toFixed(6)),
        e144: Number(e144.toFixed(6)),
        rsi: Number(rsi.toFixed(2)),
        macdHist: macd.hist == null ? null : Number(macd.hist.toFixed(6)),
        atr: Number(atr.toFixed(6)),
        volMult: Number(volMult.toFixed(2)),
        validCrossWindow,
        crossTooOld,
        lateEntryTrap,
        postCrossPumpDetected,
        postCrossBarsAnalyzed,
        moveSinceCrossPct,
        maxPostCrossVolMult,
        maxPostCrossCandlePct,
        maxPostCrossRangePct,
        currentCandleTooAggressive,
        moveSinceCrossTooHigh,
        priceTooFarAfterCross,
      };
    }

    async function buildCandidate(t) {
      const symbol = String(t.symbol || '').trim().toUpperCase();
      if (!symbol) return null;
      if (!allowedSymbolsSet.has(symbol)) return null;
      let klines;
      try {
        klines = await fetchBinanceVisionKlines({ symbol, interval: '1h', limit: 200, timeoutMs });
      } catch {
        return null;
      }
      if (!Array.isArray(klines) || klines.length < 60) return null;

      const opens = [];
      const closes = [];
      const highs = [];
      const lows = [];
      const volumes = [];
      for (const k of klines) {
        if (!Array.isArray(k) || k.length < 6) continue;
        const o = toNum(k[1]);
        const h = toNum(k[2]);
        const l = toNum(k[3]);
        const c = toNum(k[4]);
        const v = toNum(k[5]);
        if (!Number.isFinite(o) || !Number.isFinite(c) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(v)) continue;
        if (o <= 0 || c <= 0 || h <= 0 || l <= 0 || v < 0) continue;
        opens.push(o);
        closes.push(c);
        highs.push(h);
        lows.push(l);
        volumes.push(v);
      }
      if (closes.length < 160) return null;

      return evaluateSymbol({ symbol, ticker: t, opens, highs, lows, closes, volumes });
    }

    for (let i = 0; i < tryTickers.length; i += concurrency) {
      const batch = tryTickers.slice(i, i + concurrency);
      const results = await Promise.all(batch.map((t) => buildCandidate(t)));
      for (const c of results) if (c) built.push(c);
      if (built.length >= desired) break;
    }

    built.sort((a, b) => b.score - a.score);

    return res.json({
      ok: true,
      data: built.slice(0, desired),
      meta: { quoteAsset, desired, maxTickers, concurrency, allowedSymbolsCount: allowedSymbolsSet.size },
    });
  });

  app.post('/scan', wrapAsync(async (req, res) => {
    try {
      const requestBody = req.body || {};

      function toNum(v, d = NaN) {
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
      }

      function calcEMA(data, p) {
        if (!Array.isArray(data) || data.length < p) return null;
        const k = 2 / (p + 1);
        let e = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
        for (let i = p; i < data.length; i++) e = data[i] * k + e * (1 - k);
        return +e.toFixed(6);
      }

      function calcRSI(data, p = 14) {
        if (!Array.isArray(data) || data.length < p + 1) return null;
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
        return +(100 - 100 / (1 + ag / al)).toFixed(2);
      }

      function calcATR(h, l, c, p = 14) {
        if (!Array.isArray(h) || h.length < p + 1) return null;
        const trs = [];
        for (let i = 1; i < h.length; i++) {
          trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
        }
        if (trs.length < p) return null;
        return +(trs.slice(-p).reduce((a, b) => a + b, 0) / p).toFixed(6);
      }

      function calcMACD(data) {
        if (!Array.isArray(data) || data.length < 35) return null;
        const series = [];
        for (let i = 26; i <= data.length; i++) {
          const e12 = calcEMA(data.slice(0, i), 12);
          const e26 = calcEMA(data.slice(0, i), 26);
          if (e12 != null && e26 != null) series.push(e12 - e26);
        }
        if (!series.length) return null;
        const macd = series[series.length - 1];
        const signal = calcEMA(series, 9);
        const hist = signal == null ? null : +(macd - signal).toFixed(6);
        return { macd: +macd.toFixed(6), signal, hist };
      }

      const quoteAsset = normalizeQuoteAsset(requestBody.quoteAsset || 'TRY') || 'TRY';
      assertQuoteAssetTry(quoteAsset);

      // 1) SYMBOL ÇÖZÜMLEME
      let symbol = String(requestBody.symbol || '').toUpperCase().trim();
      if (!symbol) symbol = 'NO_SYMBOL';
      assertSymbolTryPair(symbol);

      // 2) KLINES INPUT ÇÖZÜMLEME
      let klines = requestBody.klines || requestBody.data || [];

      if (!Array.isArray(klines)) klines = [];

      const klineValidation = validateBinanceKlinesArray(klines);
      if (!klineValidation.ok) {
        return res.status(400).json({ symbol, motorOk: false, reason: 'Kline formatı geçersiz', details: klineValidation });
      }

      const now = nowMs();
      let allowedSymbols = [];
      if (binanceTrSymbolsState.expiresAtMs > now && binanceTrSymbolsState.quoteAsset === 'TRY') {
        allowedSymbols = binanceTrSymbolsState.symbols;
      }
      if (allowedSymbols.length === 0) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const r = await fetch('https://www.binance.tr/open/v1/common/symbols', {
            signal: controller.signal,
            headers: {
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            }
          });
          clearTimeout(timeout);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = await r.json();
          const list = body?.data?.list;
          if (Array.isArray(list)) {
            allowedSymbols = list
              .map((x) => (typeof x?.symbol === 'string' ? x.symbol : ''))
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean)
              .filter((s) => s.endsWith('_TRY'))
              .map((s) => s.replace('_', ''));
          }
          if (allowedSymbols.length > 0) {
            binanceTrSymbolsState.expiresAtMs = now + 10 * 60_000;
            binanceTrSymbolsState.quoteAsset = 'TRY';
            binanceTrSymbolsState.symbols = allowedSymbols;
          }
        } catch {
        }
      }

      const allowedSet = new Set(allowedSymbols);
      if (allowedSet.size === 0) {
        const envSymbols = readAllowedSymbolsTryFromEnv();
        if (envSymbols.length === 0) {
          return res.status(503).json({ symbol, motorOk: false, reason: 'Binance TR sembol listesi alınamadı' });
        }
        for (const s of envSymbols) allowedSet.add(s);
      }
      if (!allowedSet.has(symbol)) {
        return res.status(403).json({ symbol, motorOk: false, reason: 'Symbol allowlist dışı (Binance TR listesinde yok)' });
      }

      if (!symbol || symbol === 'NO_SYMBOL') {
        return res.json({ symbol: 'UNKNOWN', motorOk: false, reason: 'symbol bulunamadı' });
      }

      if (klines.length < 60) {
        return res.json({ symbol, motorOk: false, reason: `Yetersiz veri: ${klines.length} bar` });
      }

      // 3) KLINES PARSE
      const rows = klines.map(k => ({
        ts: toNum(k?.[0]),
        o: toNum(k?.[1]),
        h: toNum(k?.[2]),
        l: toNum(k?.[3]),
        c: toNum(k?.[4]),
        v: toNum(k?.[5]),
      })).filter(r => r.c > 0 && r.h > 0 && r.l > 0 && r.v >= 0);

      if (rows.length < 60) {
        return res.json({ symbol, motorOk: false, reason: `Geçerli bar < 60 (${rows.length})` });
      }

      const closes = rows.map(r => r.c);
      const highs = rows.map(r => r.h);
      const lows = rows.map(r => r.l);
      const volumes = rows.map(r => r.v);
      const price = closes[closes.length - 1];

      // 4) İNDİKATÖRLER
      const e5 = calcEMA(closes, 5);
      const e21 = calcEMA(closes, 21);
      const e55 = calcEMA(closes, 55);
      const rsi = calcRSI(closes, 14);
      const atr = calcATR(highs, lows, closes, 14);
      const macd = calcMACD(closes);

      if ([e5, e21, e55, rsi, atr].some(v => v == null) || !macd) {
        return res.json({ symbol, motorOk: false, reason: 'İndikatör hesaplanamadı' });
      }

      const vol20 = volumes.slice(-20);
      const vol20avg = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
      const curVol = volumes[volumes.length - 1];
      const volMult = vol20avg > 0 ? +(curVol / vol20avg).toFixed(2) : 0;

      // 5) LONG SCORE + STOP/TARGET
      const trendLong = e5 > e21 && e21 > e55;
      const macdLong = macd.hist != null && macd.hist > 0;
      const volLong = volMult >= 1.1;

      const gates = [trendLong, macdLong, volLong].filter(Boolean).length;
      let longScore = gates * 20 + (rsi > 50 ? 10 : 0) + (volMult > 1.5 ? 10 : 0);
      longScore = Math.max(0, Math.min(100, Math.round(longScore)));

      let stop = Math.min(price - atr * 1.6, Math.min(...lows.slice(-20)) * 0.99);
      stop = Math.max(stop, price * 0.90); 
      stop = Math.min(stop, price * 0.95); 
      const longStop = +stop.toFixed(6);

      const risk = price - longStop;
      const longTarget = +(price + risk * 2.5).toFixed(6);
      const longRR = risk > 0 ? +((longTarget - price) / risk).toFixed(2) : 0;

      const scoreOk = longScore >= 30;

      const setupType = trendLong ? 'EMA21_MOMENTUM_PULLBACK' : 'EMA144_GOLDEN_PULLBACK';
      const stopType = setupType.includes('144') ? 'EMA144_DYNAMIC (-3%)' : 'EMA21_DYNAMIC (-3%)';
      const tier = longScore >= 85 ? 'A' : (longScore >= 70 ? 'B' : 'C');
      const primaryTrigger = trendLong ? 'EMA21 Pullback + Trend Devam' : '3 Mum Momentum + Hacim';

      // 6) OUTPUT
      return res.json({
          symbol,
          motorOk: true,
          price: +price.toFixed(6),
          e5, e21, e55, rsi,
          macdHist: macd.hist,
          volMult, atr,
          longScore,
          dominantDirection: 'LONG',
          longStop,
          longTarget,
          longRR,
          score: String(longScore),
          tier,
          setup: 'LONG_ONLY',
          setupType,
          primaryTrigger,
          hitRules: `trendLong=${trendLong}, macdLong=${macdLong}, volLong=${volLong}`,
          scoreDetail: `gates=${gates}, rsi=${rsi}, volMult=${volMult}`,
          entryPrice: String(price.toFixed(6)),
          stopLoss: String(longStop.toFixed(6)),
          takeProfit: String(longTarget.toFixed(6)),
          stopType,
          riskReward: String(longRR.toFixed(2)),
          riskPercent: String((((price - longStop) / price) * 100).toFixed(2)),
          profitPercent: String((((longTarget - price) / price) * 100).toFixed(2)),
          intradayChg: "0.00",
          range12Pct: "0.00",
          chg3: "0.00",
          isFlat: rsi < 30 || rsi > 85,
          isPump: volMult >= 4.0 && rsi > 90,
          gradualVolUpStrict: volMult >= 1.2,
          gradualVolUpSoft: volMult >= 1.05
      });
    } catch (e) {
      const status = e && typeof e === 'object' && Number.isFinite(e.status) ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      const details = e && typeof e === 'object' ? e.details : undefined;
      return res.status(status).json({ error: message, details });
    }
  }));

  app.post('/auth/register', wrapAsync(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '').trim();
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : null;

    if (!isValidEmail(email)) return errorResponse(res, 400, 'Geçerli bir e-mail gir.');
    if (password.length < 6) return errorResponse(res, 400, 'Şifre en az 6 karakter olmalı.');

    const salt = generateSaltHex();
    const passwordHash = hashPassword(password, salt);
    const createdAtMs = nowMs();

    try {
      const result = await pool.query(
        `
          INSERT INTO users (email, display_name, password_hash, password_salt, created_at_ms)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id::text as id, email::text as email, display_name as "displayName", created_at_ms as "createdAtMs"
        `,
        [email, displayName, passwordHash, salt, createdAtMs],
      );

      const user = result.rows[0];
      await pool.query(
        `
          INSERT INTO user_settings (user_id, auto_trade_enabled, min_risk_reward, updated_at_ms)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id) DO NOTHING
        `,
        [user.id, false, 1.5, nowMs()],
      );

      res.json(user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('unique')) {
        return errorResponse(res, 409, 'Bu e-mail zaten kayıtlı.');
      }
      return dbUnavailable(res);
    }
  }));

  app.post('/auth/login', wrapAsync(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '').trim();
    if (!isValidEmail(email) || password.length === 0) return errorResponse(res, 400, 'E-mail ve şifre zorunludur.');

    const result = await pool.query(
      `
        SELECT
          id::text as id,
          email::text as email,
          display_name as "displayName",
          password_hash as "passwordHash",
          password_salt as "passwordSalt",
          created_at_ms as "createdAtMs"
        FROM users
        WHERE email = $1
        LIMIT 1
      `,
      [email],
    );

    const user = result.rows[0];
    if (!user) return errorResponse(res, 401, 'E-mail veya şifre hatalı.');

    const expected = hashPassword(password, user.passwordSalt);
    if (expected !== user.passwordHash) return errorResponse(res, 401, 'E-mail veya şifre hatalı.');

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAtMs: Number(user.createdAtMs),
    });
  }));

  app.get('/users/:userId/settings', wrapAsync(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.json(null);

    const result = await pool.query(
      `
        SELECT
          user_id::text as "userId",
          auto_trade_enabled as "autoTradeEnabled",
          min_risk_reward as "minRiskReward",
          custom_strategy_code as "customStrategyCode",
          updated_at_ms as "updatedAtMs"
        FROM user_settings
        WHERE user_id = $1::uuid
        LIMIT 1
      `,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return res.json(null);
    res.json({
      userId: row.userId,
      autoTradeEnabled: Boolean(row.autoTradeEnabled),
      minRiskReward: Number(row.minRiskReward),
      customStrategyCode: typeof row.customStrategyCode === 'string' ? row.customStrategyCode : undefined,
      updatedAtMs: Number(row.updatedAtMs),
    });
  }));

  app.put('/users/:userId/settings', wrapAsync(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return errorResponse(res, 400, 'Kullanıcı bulunamadı.');

    const autoTradeEnabled = Boolean(req.body?.autoTradeEnabled);
    const minRiskReward = Number(req.body?.minRiskReward);
    if (!Number.isFinite(minRiskReward) || minRiskReward <= 0) return errorResponse(res, 400, 'Min risk/reward hatalı.');
    const customStrategyCode = typeof req.body?.customStrategyCode === 'string' ? req.body.customStrategyCode : null;

    const updatedAtMs = nowMs();
    const result = await pool.query(
      `
        INSERT INTO user_settings (user_id, auto_trade_enabled, min_risk_reward, custom_strategy_code, updated_at_ms)
        VALUES ($1::uuid, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET
          auto_trade_enabled = EXCLUDED.auto_trade_enabled,
          min_risk_reward = EXCLUDED.min_risk_reward,
          custom_strategy_code = COALESCE(EXCLUDED.custom_strategy_code, user_settings.custom_strategy_code),
          updated_at_ms = EXCLUDED.updated_at_ms
        RETURNING user_id::text as "userId", auto_trade_enabled as "autoTradeEnabled", min_risk_reward as "minRiskReward", custom_strategy_code as "customStrategyCode", updated_at_ms as "updatedAtMs"
      `,
      [userId, autoTradeEnabled, minRiskReward, customStrategyCode, updatedAtMs],
    );

    const row = result.rows[0];
    res.json({
      userId: row.userId,
      autoTradeEnabled: Boolean(row.autoTradeEnabled),
      minRiskReward: Number(row.minRiskReward),
      customStrategyCode: typeof row.customStrategyCode === 'string' ? row.customStrategyCode : undefined,
      updatedAtMs: Number(row.updatedAtMs),
    });
  }));

  app.get('/users/:userId/api-credentials', wrapAsync(async (req, res) => {
    const denied = requireInternalToken(req, res);
    if (denied) return;
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.json(null);

    const result = await pool.query(
      `
        SELECT api_key_enc as "apiKeyEnc", api_secret_enc as "apiSecretEnc", updated_at_ms as "updatedAtMs"
        FROM user_api_credentials
        WHERE user_id = $1::uuid
        LIMIT 1
      `,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return res.json(null);
    return res.json({ userId, hasCredentials: true, updatedAtMs: Number(row.updatedAtMs) });
  }));

  app.put('/users/:userId/api-credentials', wrapAsync(async (req, res) => {
    const denied = requireInternalToken(req, res);
    if (denied) return;
    const userId = String(req.params.userId || '').trim();
    if (!userId) return errorResponse(res, 400, 'Kullanıcı bulunamadı.');

    const apiKey = String(req.body?.apiKey || '').trim();
    const apiSecret = String(req.body?.apiSecret || '').trim();
    if (!apiKey || !apiSecret) return errorResponse(res, 400, 'API Key ve Secret Key zorunludur.');

    const updatedAtMs = nowMs();
    const apiKeyEnc = encryptText(apiKey);
    const apiSecretEnc = encryptText(apiSecret);
    await pool.query(
      `
        INSERT INTO user_api_credentials (user_id, api_key_enc, api_secret_enc, updated_at_ms)
        VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4)
        ON CONFLICT (user_id) DO UPDATE SET
          api_key_enc = EXCLUDED.api_key_enc,
          api_secret_enc = EXCLUDED.api_secret_enc,
          updated_at_ms = EXCLUDED.updated_at_ms
      `,
      [userId, JSON.stringify(apiKeyEnc), JSON.stringify(apiSecretEnc), updatedAtMs],
    );
    return res.json({ ok: true, updatedAtMs });
  }));

  app.get('/users/:userId/positions', wrapAsync(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.json([]);

    const result = await pool.query(
      `
        SELECT
          id,
          user_id::text as "userId",
          opened_at_ms as "openedAtMs",
          payload_json as "payloadJson",
          updated_at_ms as "updatedAtMs"
        FROM positions
        WHERE user_id = $1::uuid
        ORDER BY opened_at_ms DESC
      `,
      [userId],
    );

    res.json(
      result.rows.map((r) => ({
        id: String(r.id),
        userId: r.userId,
        openedAtMs: Number(r.openedAtMs),
        payloadJson: JSON.stringify(r.payloadJson ?? {}),
        updatedAtMs: Number(r.updatedAtMs),
      })),
    );
  }));

  app.put('/users/:userId/positions', wrapAsync(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return errorResponse(res, 400, 'Kullanıcı bulunamadı.');

    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    const updatedAtMs = nowMs();

    let allowedSymbolsSet = null;
    try {
      const now = nowMs();
      if (binanceTrSymbolsState.expiresAtMs > now && binanceTrSymbolsState.quoteAsset === 'TRY' && binanceTrSymbolsState.symbols.length > 0) {
        allowedSymbolsSet = new Set(binanceTrSymbolsState.symbols);
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const r = await fetch('https://www.binance.tr/open/v1/common/symbols', {
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          }
        });
        clearTimeout(timeout);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        const list = body?.data?.list;
        const symbols = Array.isArray(list)
          ? list
            .map((x) => (typeof x?.symbol === 'string' ? x.symbol : ''))
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
            .filter((s) => s.endsWith('_TRY'))
            .map((s) => s.replace('_', ''))
          : [];
        if (symbols.length === 0) throw new Error('No symbols');
        binanceTrSymbolsState.expiresAtMs = now + 10 * 60_000;
        binanceTrSymbolsState.quoteAsset = 'TRY';
        binanceTrSymbolsState.symbols = symbols;
        allowedSymbolsSet = new Set(symbols);
      }
    } catch (e) {
      const envSymbols = readAllowedSymbolsTryFromEnv();
      if (envSymbols.length === 0) {
        return res.status(503).json({ ok: false, error: 'Binance TR sembol listesi alınamadı.', details: e instanceof Error ? e.message : String(e) });
      }
      allowedSymbolsSet = new Set(envSymbols);
    }

    for (const p of positions) {
      const symbol = normalizeSymbol(p?.payload?.symbol ?? p?.symbol ?? '');
      if (!symbol) continue;
      try {
        assertSymbolTryPair(symbol);
      } catch (e) {
        return res.status(e?.status || 400).json({ ok: false, error: e instanceof Error ? e.message : 'Geçersiz symbol.', symbol });
      }
      if (!allowedSymbolsSet.has(symbol)) {
        return res.status(403).json({ ok: false, error: 'Symbol allowlist dışı (Binance TR listesinde yok).', symbol });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM positions WHERE user_id = $1::uuid', [userId]);
      for (const p of positions) {
        const id = String(p?.id || '').trim();
        const openedAtMs = Number(p?.openedAtMs);
        const payload = p?.payload;
        if (!id) continue;
        if (!Number.isFinite(openedAtMs)) continue;
        if (payload === undefined) continue;
        await client.query(
          `
            INSERT INTO positions (id, user_id, opened_at_ms, payload_json, updated_at_ms)
            VALUES ($1, $2::uuid, $3, $4::jsonb, $5)
          `,
          [id, userId, openedAtMs, JSON.stringify(payload), updatedAtMs],
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
      }
      return errorResponse(res, 500, 'Pozisyonlar kaydedilemedi.');
    } finally {
      client.release();
    }
  }));

  app.get('/users/:userId/reports', wrapAsync(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.json([]);

    const sinceMsRaw = typeof req.query?.sinceMs === 'string' ? Number(req.query.sinceMs) : Number.NaN;
    const sinceMs = Number.isFinite(sinceMsRaw) ? Math.max(0, Math.trunc(sinceMsRaw)) : null;

    const result = await pool.query(
      `
        SELECT *
        FROM (
          SELECT DISTINCT ON (symbol, opened_at_ms, outcome)
            id,
            user_id::text as "userId",
            symbol,
            opened_at_ms as "openedAtMs",
            closed_at_ms as "closedAtMs",
            entry,
            exit,
            outcome,
            pnl_pct as "pnlPct",
            risk_reward_at_entry as "riskRewardAtEntry",
            created_at_ms as "createdAtMs"
          FROM trade_reports
          WHERE user_id = $1::uuid
            AND ($2::bigint IS NULL OR closed_at_ms >= $2::bigint)
          ORDER BY symbol, opened_at_ms, outcome, closed_at_ms DESC
        ) t
        ORDER BY t."closedAtMs" DESC
      `,
      [userId, sinceMs],
    );

    res.json(
      result.rows.map((r) => ({
        id: String(r.id),
        userId: r.userId,
        symbol: String(r.symbol),
        openedAtMs: Number(r.openedAtMs),
        closedAtMs: Number(r.closedAtMs),
        entry: Number(r.entry),
        exit: Number(r.exit),
        outcome: r.outcome === 'TP' ? 'TP' : 'SL',
        pnlPct: Number(r.pnlPct),
        riskRewardAtEntry: Number(r.riskRewardAtEntry),
        createdAtMs: Number(r.createdAtMs),
      })),
    );
  }));

  app.delete('/users/:userId/reports', wrapAsync(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return errorResponse(res, 400, 'Kullanıcı bulunamadı.');
    await pool.query('DELETE FROM trade_reports WHERE user_id = $1::uuid', [userId]);
    return res.json({ ok: true });
  }));

  app.post('/users/:userId/reports', wrapAsync(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return errorResponse(res, 400, 'Kullanıcı bulunamadı.');

    const reports = Array.isArray(req.body?.reports) ? req.body.reports : [];
    if (reports.length === 0) return res.json({ ok: true });

    let allowedSymbolsSet = null;
    try {
      const now = nowMs();
      if (binanceTrSymbolsState.expiresAtMs > now && binanceTrSymbolsState.quoteAsset === 'TRY' && binanceTrSymbolsState.symbols.length > 0) {
        allowedSymbolsSet = new Set(binanceTrSymbolsState.symbols);
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const r = await fetch('https://www.binance.tr/open/v1/common/symbols', {
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          }
        });
        clearTimeout(timeout);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        const list = body?.data?.list;
        const symbols = Array.isArray(list)
          ? list
            .map((x) => (typeof x?.symbol === 'string' ? x.symbol : ''))
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
            .filter((s) => s.endsWith('_TRY'))
            .map((s) => s.replace('_', ''))
          : [];
        if (symbols.length === 0) throw new Error('No symbols');
        binanceTrSymbolsState.expiresAtMs = now + 10 * 60_000;
        binanceTrSymbolsState.quoteAsset = 'TRY';
        binanceTrSymbolsState.symbols = symbols;
        allowedSymbolsSet = new Set(symbols);
      }
    } catch (e) {
      const envSymbols = readAllowedSymbolsTryFromEnv();
      if (envSymbols.length === 0) {
        return res.status(503).json({ ok: false, error: 'Binance TR sembol listesi alınamadı.', details: e instanceof Error ? e.message : String(e) });
      }
      allowedSymbolsSet = new Set(envSymbols);
    }

    const createdAtMs = nowMs();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of reports) {
        const symbol = String(r?.symbol || '').trim().toUpperCase();
        try {
          assertSymbolTryPair(symbol);
        } catch (e) {
          return res.status(e?.status || 400).json({ ok: false, error: e instanceof Error ? e.message : 'Geçersiz symbol.', symbol });
        }
        if (!allowedSymbolsSet.has(symbol)) {
          return res.status(403).json({ ok: false, error: 'Symbol allowlist dışı (Binance TR listesinde yok).', symbol });
        }
        const openedAtMs = Number(r?.openedAtMs);
        const closedAtMs = Number(r?.closedAtMs);
        const entry = Number(r?.entry);
        const exit = Number(r?.exit);
        const outcome = r?.outcome === 'TP' ? 'TP' : 'SL';
        const id = `${symbol}-${openedAtMs}-${outcome}`;
        const pnlPct = Number(r?.pnlPct);
        const riskRewardAtEntry = Number(r?.riskRewardAtEntry);

        if (!id || !symbol) continue;
        if (!Number.isFinite(openedAtMs) || !Number.isFinite(closedAtMs)) continue;
        if (!Number.isFinite(entry) || !Number.isFinite(exit)) continue;
        if (!Number.isFinite(pnlPct) || !Number.isFinite(riskRewardAtEntry)) continue;

        await client.query(
          `
            INSERT INTO trade_reports (
              id, user_id, symbol, opened_at_ms, closed_at_ms,
              entry, exit, outcome, pnl_pct, risk_reward_at_entry, created_at_ms
            ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              symbol = EXCLUDED.symbol,
              opened_at_ms = EXCLUDED.opened_at_ms,
              closed_at_ms = EXCLUDED.closed_at_ms,
              entry = EXCLUDED.entry,
              exit = EXCLUDED.exit,
              outcome = EXCLUDED.outcome,
              pnl_pct = EXCLUDED.pnl_pct,
              risk_reward_at_entry = EXCLUDED.risk_reward_at_entry
          `,
          [
            id,
            userId,
            symbol,
            openedAtMs,
            closedAtMs,
            entry,
            exit,
            outcome,
            pnlPct,
            riskRewardAtEntry,
            createdAtMs,
          ],
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
      }
      return errorResponse(res, 500, 'Raporlar kaydedilemedi.');
    } finally {
      client.release();
    }
  }));

  app.post('/binance/ticker', wrapAsync(async (req, res) => {
    const symbol = String(req.body?.symbol || '').trim().toUpperCase();
    const price = Number(req.body?.price);
    const eventAtMs = Number.isFinite(Number(req.body?.atMs)) ? Number(req.body.atMs) : nowMs();
    const source = typeof req.body?.source === 'string' && req.body.source.trim() ? req.body.source.trim() : 'unknown';
    const userIdRaw = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';

    if (!symbol) return errorResponse(res, 400, 'Sembol zorunlu.');
    if (!Number.isFinite(price)) return errorResponse(res, 400, 'Fiyat hatalı.');

    const userId = userIdRaw ? userIdRaw : null;

    try {
      await pool.query(
        `
          INSERT INTO binance_ticker_prices (symbol, price, event_at_ms, user_id, source)
          VALUES ($1, $2, $3, $4::uuid, $5)
        `,
        [symbol, price, eventAtMs, userId, source],
      );
      res.json({ ok: true });
    } catch (e) {
      return dbUnavailable(res);
    }
  }));

  app.post('/binance/ticker/batch', wrapAsync(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.json({ ok: true, inserted: 0 });

    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      for (const it of items) {
        const symbol = String(it?.symbol || '').trim().toUpperCase();
        const price = Number(it?.price);
        const eventAtMs = Number.isFinite(Number(it?.atMs)) ? Number(it.atMs) : nowMs();
        const source = typeof it?.source === 'string' && it.source.trim() ? it.source.trim() : 'unknown';
        const userIdRaw = typeof it?.userId === 'string' ? it.userId.trim() : '';

        if (!symbol) continue;
        if (!Number.isFinite(price)) continue;

        const userId = userIdRaw ? userIdRaw : null;
        await client.query(
          `
            INSERT INTO binance_ticker_prices (symbol, price, event_at_ms, user_id, source)
            VALUES ($1, $2, $3, $4::uuid, $5)
          `,
          [symbol, price, eventAtMs, userId, source],
        );
        inserted += 1;
      }
      await client.query('COMMIT');
      res.json({ ok: true, inserted });
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
      }
      return dbUnavailable(res);
    } finally {
      client.release();
    }
  }));

  app.use((err, _req, res, _next) => {
    const code = err && typeof err === 'object' ? err.code : null;
    const message = err instanceof Error ? err.message : String(err || '');
    if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') return dbUnavailable(res);
    if (typeof message === 'string' && message.toLowerCase().includes('timeout')) return dbUnavailable(res);
    if (typeof message === 'string' && message.toLowerCase().includes('self-signed')) return dbUnavailable(res);
    try {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      process.stderr.write(`${msg}\n`);
    } catch {
    }
    return errorResponse(res, 500, 'Sunucu hatası.');
  });

  return app;
}

async function main() {
  const app = createApp();
  const port = Number(process.env.PORT) || 3001;
  app.listen(port, () => {
    process.stdout.write(`API listening on http://localhost:${port}\n`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(e instanceof Error ? e.stack || e.message : String(e));
    process.stderr.write('\n');
    process.exit(1);
  });
}

module.exports = {
  createApp,
  __test: {
    normalizeQuoteAsset,
    normalizeSymbol,
    assertQuoteAssetTry,
    assertSymbolTryPair,
    validateBinanceKlinesArray,
  },
};
