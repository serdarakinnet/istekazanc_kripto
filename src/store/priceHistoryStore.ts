import { create } from 'zustand';

interface PriceHistoryState {
  history: Record<string, number[]>;
  currentPrices: Record<string, number>;
  addPrice: (symbol: string, price: number) => void;
}

export const usePriceHistoryStore = create<PriceHistoryState>((set) => ({
  history: {},
  currentPrices: {},
  addPrice: (symbol, price) => {
    const normalizedSymbol = symbol.trim().toUpperCase();
    if (!normalizedSymbol) return;
    if (!Number.isFinite(price)) return;

    set((state) => {
      const prevHistory = state.history[normalizedSymbol] ?? [];
      const nextHistory = [...prevHistory, price].slice(-60);
      return {
        history: { ...state.history, [normalizedSymbol]: nextHistory },
        currentPrices: { ...state.currentPrices, [normalizedSymbol]: price },
      };
    });
  },
}));

