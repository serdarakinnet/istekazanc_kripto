import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

export type PriceDirection = 'up' | 'down';

export type LivePrice = {
  symbol: string;
  price: number;
  direction: PriceDirection | null;
  updatedAtMs: number;
};

type LivePriceMap = Record<string, LivePrice | undefined>;

type Options = {
  throttleMs?: number;
  flashMs?: number;
  reconnectMaxDelayMs?: number;
};

const DEFAULTS: Required<Options> = {
  throttleMs: 1000,
  flashMs: 250,
  reconnectMaxDelayMs: 10_000,
};

function buildCombinedStreamUrl(symbols: string[]): string | null {
  const streams = symbols
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => `${s}@ticker`);

  if (streams.length === 0) return null;

  const url = new URL('wss://data-stream.binance.vision:443/stream');
  url.searchParams.set('streams', streams.join('/'));
  return url.toString();
}

function safeParseFloat(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function useLiveTickerPrices(symbols: string[], options?: Options) {
  const merged = useMemo(
    () => ({ ...DEFAULTS, ...options }),
    [options?.flashMs, options?.reconnectMaxDelayMs, options?.throttleMs],
  );

  const stableSymbols = useMemo(() => {
    return symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  }, [symbols.join('|')]);

  const [prices, setPrices] = useState<LivePriceMap>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEmitMsRef = useRef<Record<string, number | undefined>>({});
  const flashTimerRef = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});

  useEffect(() => {
    const url = buildCombinedStreamUrl(stableSymbols);
    if (!url) {
      setPrices({});
      return;
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const clearFlashTimer = (symbol: string) => {
      const timer = flashTimerRef.current[symbol];
      if (timer) clearTimeout(timer);
      flashTimerRef.current[symbol] = undefined;
    };

    const disconnect = () => {
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };

    const connect = () => {
      disconnect();

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        const now = Date.now();
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
        if (!stableSymbols.includes(symbol)) return;

        const lastEmit = lastEmitMsRef.current[symbol] ?? 0;
        if (now - lastEmit < merged.throttleMs) return;
        lastEmitMsRef.current[symbol] = now;

        setPrices((prev) => {
          const prevItem = prev[symbol];
          const direction: PriceDirection | null =
            prevItem && prevItem.price !== price ? (price > prevItem.price ? 'up' : 'down') : null;

          if (direction) {
            clearFlashTimer(symbol);
            flashTimerRef.current[symbol] = setTimeout(() => {
              setPrices((current) => {
                const existing = current[symbol];
                if (!existing) return current;
                return {
                  ...current,
                  [symbol]: { ...existing, direction: null },
                };
              });
            }, merged.flashMs);
          }

          return {
            ...prev,
            [symbol]: {
              symbol,
              price,
              direction,
              updatedAtMs: now,
            },
          };
        });
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onclose = () => {
        clearReconnectTimer();

        reconnectAttemptRef.current += 1;
        const delay = Math.min(
          merged.reconnectMaxDelayMs,
          500 * 2 ** (reconnectAttemptRef.current - 1),
        );

        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      disconnect();
      Object.keys(flashTimerRef.current).forEach((symbol) => clearFlashTimer(symbol));
    };
  }, [merged.flashMs, merged.reconnectMaxDelayMs, merged.throttleMs, stableSymbols.join('|')]);

  return prices;
}

