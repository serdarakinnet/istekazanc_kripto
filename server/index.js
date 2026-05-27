const crypto = require('crypto');

const cors = require('cors');
const express = require('express');

const { pool } = require('./db');
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

async function main() {
  const dbState = { ready: false, lastError: null };
  const binanceTrSymbolsState = { expiresAtMs: 0, quoteAsset: null, symbols: [] };

  const initDb = async () => {
    try {
      await migrate();
      dbState.ready = true;
      dbState.lastError = null;
    } catch (e) {
      dbState.ready = false;
      dbState.lastError = e instanceof Error ? e.message : String(e);
    }
  };

  const ensureDbReady = async () => {
    if (dbState.ready) return;
    await initDb();
    if (!dbState.ready) {
      setTimeout(() => {
        void ensureDbReady();
      }, 5000);
    }
  };

  void ensureDbReady();

  const app = express();
  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    if (!dbState.ready) {
      return res.status(503).json({ ok: false, dbReady: false, error: 'Veritabanına bağlanılamadı.', details: dbState.lastError });
    }

    try {
      await pool.query('SELECT 1');
      return res.json({ ok: true, dbReady: true });
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, dbReady: false, error: 'Veritabanına bağlanılamadı.', details: e instanceof Error ? e.message : String(e) });
    }
  });

  app.use((req, res, next) => {
    if (
      req.path === '/health' ||
      req.path === '/binance-tr/symbols' ||
      req.path === '/market/last-price' ||
      req.path === '/market/last-prices' ||
      req.path === '/market/ticker/24hr' ||
      req.path === '/market/klines'
    ) {
      return next();
    }
    if (!dbState.ready) {
      return errorResponse(res, 503, 'Veritabanına bağlanılamadı.');
    }
    return next();
  });

  app.get('/binance-tr/symbols', async (req, res) => {
    const quoteAssetRaw = typeof req.query?.quoteAsset === 'string' ? req.query.quoteAsset : '';
    const quoteAsset = (quoteAssetRaw || 'TRY').trim().toUpperCase();
    const now = nowMs();

    if (binanceTrSymbolsState.expiresAtMs > now && binanceTrSymbolsState.quoteAsset === quoteAsset) {
      return res.json({ ok: true, quoteAsset, symbols: binanceTrSymbolsState.symbols });
    }

    try {
      const r = await fetch('https://www.binance.tr/open/v1/common/symbols');
      if (!r.ok) return res.json({ ok: false, quoteAsset, symbols: [], error: `HTTP ${r.status}` });
      const body = await r.json();
      const list = body?.data?.list;
      if (!Array.isArray(list)) return res.json({ ok: false, quoteAsset, symbols: [], error: 'Invalid response' });

      const symbols = list
        .map((x) => (typeof x?.symbol === 'string' ? x.symbol : ''))
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .filter((s) => s.endsWith(`_${quoteAsset}`))
        .map((s) => s.replace('_', ''));

      binanceTrSymbolsState.expiresAtMs = now + 10 * 60_000;
      binanceTrSymbolsState.quoteAsset = quoteAsset;
      binanceTrSymbolsState.symbols = symbols;

      return res.json({ ok: true, quoteAsset, symbols });
    } catch (e) {
      return res.json({ ok: false, quoteAsset, symbols: [], error: e instanceof Error ? e.message : String(e) });
    }
  });

  const BINANCE_HTTP_BASES = [
    'https://data-api.binance.vision',
    'https://api.binance.com',
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

  app.post('/auth/register', async (req, res) => {
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
      return errorResponse(res, 500, 'Kayıt başarısız.');
    }
  });

  app.post('/auth/login', async (req, res) => {
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
  });

  app.get('/users/:userId/settings', async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.json(null);

    const result = await pool.query(
      `
        SELECT
          user_id::text as "userId",
          auto_trade_enabled as "autoTradeEnabled",
          min_risk_reward as "minRiskReward",
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
      updatedAtMs: Number(row.updatedAtMs),
    });
  });

  app.put('/users/:userId/settings', async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return errorResponse(res, 400, 'Kullanıcı bulunamadı.');

    const autoTradeEnabled = Boolean(req.body?.autoTradeEnabled);
    const minRiskReward = Number(req.body?.minRiskReward);
    if (!Number.isFinite(minRiskReward) || minRiskReward <= 0) return errorResponse(res, 400, 'Min risk/reward hatalı.');

    const updatedAtMs = nowMs();
    const result = await pool.query(
      `
        INSERT INTO user_settings (user_id, auto_trade_enabled, min_risk_reward, updated_at_ms)
        VALUES ($1::uuid, $2, $3, $4)
        ON CONFLICT (user_id) DO UPDATE SET
          auto_trade_enabled = EXCLUDED.auto_trade_enabled,
          min_risk_reward = EXCLUDED.min_risk_reward,
          updated_at_ms = EXCLUDED.updated_at_ms
        RETURNING user_id::text as "userId", auto_trade_enabled as "autoTradeEnabled", min_risk_reward as "minRiskReward", updated_at_ms as "updatedAtMs"
      `,
      [userId, autoTradeEnabled, minRiskReward, updatedAtMs],
    );

    const row = result.rows[0];
    res.json({
      userId: row.userId,
      autoTradeEnabled: Boolean(row.autoTradeEnabled),
      minRiskReward: Number(row.minRiskReward),
      updatedAtMs: Number(row.updatedAtMs),
    });
  });

  app.get('/users/:userId/api-credentials', async (req, res) => {
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
  });

  app.put('/users/:userId/api-credentials', async (req, res) => {
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
  });

  app.get('/users/:userId/positions', async (req, res) => {
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
  });

  app.put('/users/:userId/positions', async (req, res) => {
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
  });

  app.get('/users/:userId/reports', async (req, res) => {
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
  });

  app.post('/users/:userId/reports', async (req, res) => {
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
  });

  app.post('/binance/ticker', async (req, res) => {
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
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(res, 500, msg);
    }
  });

  app.post('/binance/ticker/batch', async (req, res) => {
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
      return errorResponse(res, 500, 'Kayıt başarısız.');
    } finally {
      client.release();
    }
  });

  const port = Number(process.env.PORT) || 3001;
  app.listen(port, () => {
    process.stdout.write(`API listening on http://localhost:${port}\n`);
  });
}

main().catch((e) => {
  process.stderr.write(e instanceof Error ? e.stack || e.message : String(e));
  process.stderr.write('\n');
  process.exit(1);
});
