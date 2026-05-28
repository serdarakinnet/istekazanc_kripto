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

function dbUnavailable(res) {
  return errorResponse(res, 503, 'Veritabanına bağlanılamadı.');
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

  app.use(wrapAsync(async (req, res, next) => {
    if (
      req.path === '/health' ||
      req.path === '/binance-tr/symbols' ||
      req.path === '/market/last-price' ||
      req.path === '/market/last-prices' ||
      req.path === '/market/ticker/24hr' ||
      req.path === '/market/klines' ||
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

    if (binanceTrSymbolsState.expiresAtMs > now && binanceTrSymbolsState.quoteAsset === quoteAsset) {
      return res.json({ ok: true, quoteAsset, symbols: binanceTrSymbolsState.symbols });
    }

    let symbols = [];
    let fetchError = null;

    // 1. Try Binance TR API
    try {
      const r = await fetch('https://www.binance.tr/open/v1/common/symbols', {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        }
      });
      if (r.ok) {
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
      } else {
        fetchError = `Binance TR HTTP ${r.status}`;
      }
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e);
    }

    // 2. Fallback to Global Binance API if TR fails or returns empty
    if (symbols.length === 0) {
      try {
        const body = await fetchJsonFromBinance('/api/v3/exchangeInfo', null, 5000);
        if (Array.isArray(body?.symbols)) {
          symbols = body.symbols
            .filter((s) => s.status === 'TRADING' && s.quoteAsset === quoteAsset)
            .map((s) => s.symbol);
        }
      } catch (e) {
        fetchError = (fetchError ? fetchError + ' | ' : '') + (e instanceof Error ? e.message : String(e));
      }
    }

    if (symbols.length > 0) {
      binanceTrSymbolsState.expiresAtMs = now + 10 * 60_000;
      binanceTrSymbolsState.quoteAsset = quoteAsset;
      binanceTrSymbolsState.symbols = symbols;
      return res.json({ ok: true, quoteAsset, symbols });
    }

    return res.json({ ok: false, quoteAsset, symbols: [], error: fetchError || 'No symbols found' });
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

  app.post('/scan', (req, res) => {
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

      // 1) SYMBOL ÇÖZÜMLEME
      let symbol = String(requestBody.symbol || '').toUpperCase().trim();
      if (!symbol) symbol = 'NO_SYMBOL';

      // 2) KLINES INPUT ÇÖZÜMLEME
      let klines = requestBody.klines || requestBody.data || [];

      if (!Array.isArray(klines)) klines = [];

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
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

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
    try {
      const apiKey = decryptText(row.apiKeyEnc);
      const apiSecret = decryptText(row.apiSecretEnc);
      return res.json({ userId, apiKey, apiSecret, updatedAtMs: Number(row.updatedAtMs) });
    } catch (e) {
      return errorResponse(res, 500, e instanceof Error ? e.message : String(e));
    }
  }));

  app.put('/users/:userId/api-credentials', wrapAsync(async (req, res) => {
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
          ORDER BY symbol, opened_at_ms, outcome, closed_at_ms DESC
        ) t
        ORDER BY t."closedAtMs" DESC
      `,
      [userId],
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

  app.post('/users/:userId/reports', wrapAsync(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return errorResponse(res, 400, 'Kullanıcı bulunamadı.');

    const reports = Array.isArray(req.body?.reports) ? req.body.reports : [];
    if (reports.length === 0) return res.json({ ok: true });

    const createdAtMs = nowMs();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of reports) {
        const symbol = String(r?.symbol || '').trim().toUpperCase();
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

module.exports = { createApp };
