import { create } from 'zustand';

interface PriceHistoryState {
  history: Record<string, number[]>;
  currentPrices: Record<string, number>;
  lastHourBucketBySymbol: Record<string, number>;
  addPrice: (symbol: string, price: number) => void;
}

export const usePriceHistoryStore = create<PriceHistoryState>((set) => ({
  history: {},
  currentPrices: {},
  lastHourBucketBySymbol: {},
  addPrice: (symbol, price) => {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol) return;
    if (!Number.isFinite(price)) return;

    set((state) => {
      const nowMs = Date.now();
      const hourBucket = Math.floor(nowMs / (60 * 60 * 1000));
      const prevBucket = state.lastHourBucketBySymbol[normalizedSymbol];

      const prevHistory = state.history[normalizedSymbol] ?? [];
      const nextHistory = prevBucket === hourBucket ? prevHistory : [...prevHistory, price].slice(-60);
      return {
        history: { ...state.history, [normalizedSymbol]: nextHistory },
        currentPrices: { ...state.currentPrices, [normalizedSymbol]: price },
        lastHourBucketBySymbol:
          prevBucket === hourBucket
            ? state.lastHourBucketBySymbol
            : { ...state.lastHourBucketBySymbol, [normalizedSymbol]: hourBucket },
      };
    });
  },
}));
