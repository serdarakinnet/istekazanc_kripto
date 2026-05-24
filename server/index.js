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
    if (req.path === '/health' || req.path === '/binance-tr/symbols') return next();
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
      if (!r.ok) return res.status(502).json({ ok: false, error: `HTTP ${r.status}` });
      const body = await r.json();
      const list = body?.data?.list;
      if (!Array.isArray(list)) return res.status(502).json({ ok: false, error: 'Invalid response' });

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
      return res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
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
        SELECT
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
        ORDER BY closed_at_ms DESC
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
        const id = String(r?.id || '').trim();
        const symbol = String(r?.symbol || '').trim().toUpperCase();
        const openedAtMs = Number(r?.openedAtMs);
        const closedAtMs = Number(r?.closedAtMs);
        const entry = Number(r?.entry);
        const exit = Number(r?.exit);
        const outcome = r?.outcome === 'TP' ? 'TP' : 'SL';
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
