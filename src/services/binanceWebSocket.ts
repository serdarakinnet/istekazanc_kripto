import { usePriceHistoryStore } from '../store/priceHistoryStore';

type OnPrice = (symbol: string, price: number) => void;

function buildCombinedKlineStreamUrl(symbols: string[]): string | null {
  const streams = symbols
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => `${s}@kline_1h`);

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

    const url = buildCombinedKlineStreamUrl(this.symbols);
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
        data?: { k?: { s?: unknown; c?: unknown } } | unknown;
      };
      const kline = (envelope?.data as { k?: { s?: unknown; c?: unknown } } | undefined)?.k;

      const symbol = typeof kline?.s === 'string' ? kline.s.toUpperCase() : null;
      const price = safeParseFloat(kline?.c);
      if (!symbol || price === null) return;
      if (!this.symbols.includes(symbol)) return;

      usePriceHistoryStore.getState().addPrice(symbol, price);
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
