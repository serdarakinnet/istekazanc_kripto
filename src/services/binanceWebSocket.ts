import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePriceHistoryStore } from '../store/priceHistoryStore';
import { useAppStore } from '../store/useAppStore';
import { Platform } from 'react-native';

type OnPrice = (symbol: string, price: number) => void;

const DEFAULT_API_BASE_URL =
  Platform.OS === 'web'
    ? 'http://localhost:3001'
    : Platform.OS === 'android'
      ? 'http://10.0.2.2:3001'
      : 'http://localhost:3001';

const API_BASE_URL = String(process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
const PERSIST_THROTTLE_MS = 5000;
const lastPersistedAtBySymbol: Record<string, number | undefined> = {};

type PendingTickerItem = {
  symbol: string;
  price: number;
  atMs: number;
  userId: string | null;
  source: string;
};

const PENDING_TICKER_KEY = 'bist_pending_ticker_v1';

async function loadPendingTickers(): Promise<PendingTickerItem[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_TICKER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as PendingTickerItem[];
  } catch {
    return [];
  }
}

async function savePendingTickers(items: PendingTickerItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_TICKER_KEY, JSON.stringify(items));
  } catch {
  }
}

async function enqueueTicker(item: PendingTickerItem): Promise<void> {
  const existing = await loadPendingTickers();
  const next = [...existing, item].slice(-1000);
  await savePendingTickers(next);
}

async function flushPendingTickers(): Promise<void> {
  const items = await loadPendingTickers();
  if (items.length === 0) return;

  const batch = items.slice(0, 200);
  try {
    const res = await fetch(`${API_BASE_URL}/binance/ticker/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: batch }),
    });
    if (!res.ok) return;
    const remaining = items.slice(batch.length);
    await savePendingTickers(remaining);
  } catch {
  }
}

function persistTickerPrice(symbol: string, price: number) {
  const now = Date.now();
  const last = lastPersistedAtBySymbol[symbol] ?? 0;
  if (now - last < PERSIST_THROTTLE_MS) return;
  lastPersistedAtBySymbol[symbol] = now;

  const userId = useAppStore.getState().user?.id ?? null;
  void fetch(`${API_BASE_URL}/binance/ticker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, price, atMs: now, userId, source: 'ws' }),
  })
    .then((res) => {
      if (res.ok) void flushPendingTickers();
      else void enqueueTicker({ symbol, price, atMs: now, userId, source: 'ws' });
    })
    .catch(() => {
      void enqueueTicker({ symbol, price, atMs: now, userId, source: 'ws' });
    });
}

function buildCombinedTickerStreamUrl(symbols: string[]): string | null {
  const streams = symbols
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => `${s}@ticker`);

  if (streams.length === 0) return null;

  return `wss://data-stream.binance.vision:443/stream?streams=${streams.join('/')}`;
}

function safeParseFloat(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export class BinanceWebSocketService {
  private ws: WebSocket | null = null;
  private symbols: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onPrice: OnPrice | null = null;
  private closing = false;

  subscribe(symbols: string[], onPrice?: OnPrice) {
    const normalized = symbols
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const nextKey = normalized.join('|');
    const prevKey = this.symbols.join('|');

    this.onPrice = onPrice ?? null;
    if (nextKey === prevKey && this.ws) return;

    this.symbols = normalized;
    this.connect();
  }

  disconnect() {
    this.closing = true;
    this.onPrice = null;
    this.symbols = [];
    this.clearReconnect();

    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    this.closing = false;
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect() {
    this.clearReconnect();
    if (this.closing) return;
    if (this.symbols.length === 0) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }

  private connect() {
    this.clearReconnect();

    const url = buildCombinedTickerStreamUrl(this.symbols);
    if (!url) {
      this.disconnect();
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onmessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : null;
      if (!text) return;

      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }

      const envelope = message as {
        data?: { s?: unknown; c?: unknown } | unknown;
      };
      const data = envelope?.data as { s?: unknown; c?: unknown } | undefined;

      const symbol = typeof data?.s === 'string' ? data.s.toUpperCase() : null;
      const price = safeParseFloat(data?.c);
      if (!symbol || price === null) return;
      if (!this.symbols.includes(symbol)) return;

      usePriceHistoryStore.getState().addPrice(symbol, price);
      persistTickerPrice(symbol, price);
      if (this.onPrice) this.onPrice(symbol, price);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };
  }
}

export const binanceWS = new BinanceWebSocketService();
