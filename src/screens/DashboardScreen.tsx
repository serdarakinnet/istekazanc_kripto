import { useQuery } from '@tanstack/react-query';
import { RefreshCcw } from 'lucide-react-native';
import * as React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CryptoCard } from '../components/CryptoCard/CryptoCard';
import { binanceWS } from '../services/binanceWebSocket';
import { applyLivePricesAndRotate, runInitialScanAndSetPositions } from '../services/botController';
import { scanTop3 } from '../services/tradingEngine';
import { usePriceHistoryStore } from '../store/priceHistoryStore';
import { useAppStore } from '../store/useAppStore';

export function DashboardScreen() {
  const rawMinRiskReward = useAppStore((s) => s.settings.minRiskReward);
  const autoTradeEnabled = useAppStore((s) => s.settings.autoTradeEnabled);
  const watchlist = useAppStore((s) => s.watchlist);
  const positions = useAppStore((s) => s.positions);
  const lastScanMs = useAppStore((s) => s.lastScanMs);
  const setWatchlist = useAppStore((s) => s.setWatchlist);

  const lastRotateMsRef = React.useRef(0);

  const minRiskReward = React.useMemo(() => {
    const n = typeof rawMinRiskReward === 'number' ? rawMinRiskReward : Number(rawMinRiskReward);
    return Number.isFinite(n) && n > 0 ? n : 1.5;
  }, [rawMinRiskReward]);

  const scanQuery = useQuery({
    queryKey: ['scanTop3', minRiskReward],
    queryFn: async () => scanTop3({ minRiskReward }),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  });

  React.useEffect(() => {
    const next = scanQuery.data?.topCandidates;
    const asOfMs = scanQuery.data?.asOfMs;
    if (!next || !asOfMs) return;
    if (lastScanMs === asOfMs) return;
    setWatchlist(next, asOfMs);
  }, [lastScanMs, scanQuery.data?.asOfMs, scanQuery.data?.topCandidates, setWatchlist]);

  const candidates =
    autoTradeEnabled && positions.length > 0
      ? positions
      : watchlist.length > 0
        ? watchlist
        : scanQuery.data?.topCandidates ?? [];
  const symbols = React.useMemo(() => candidates.map((c) => c.symbol), [candidates]);

  React.useEffect(() => {
    const key = symbols.join('|');
    if (!key) {
      binanceWS.disconnect();
      return;
    }

    binanceWS.subscribe(symbols, () => {
      if (!autoTradeEnabled) return;
      const now = Date.now();
      if (now - lastRotateMsRef.current < 1000) return;
      lastRotateMsRef.current = now;

      const snapshot = usePriceHistoryStore.getState().currentPrices;
      const prices: Record<string, number> = {};
      for (const sym of symbols) {
        const p = snapshot[sym.toUpperCase()];
        if (Number.isFinite(p)) prices[sym.toUpperCase()] = p;
      }
      if (Object.keys(prices).length === 0) return;
      void applyLivePricesAndRotate(prices).catch(() => {});
    });

    return () => {
      binanceWS.disconnect();
    };
  }, [autoTradeEnabled, symbols.join('|')]);

  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <FlatList
        data={candidates}
        keyExtractor={(item) => item.symbol}
        contentContainerStyle={{ paddingTop: 24, paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="px-6">
            <View className="flex-row items-start justify-between">
              <View className="flex-1 pr-4">
                <Text className="text-2xl font-semibold text-gray-100">
                  Aktif Seçimler
                </Text>
                <View className="mt-2 flex-row items-center gap-2">
                  <Text className="text-sm text-gray-400">
                    En İyi 3 kripto: tarama + canlı fiyat + sparkline.
                  </Text>
                  <View
                    className={[
                      'rounded-full border px-2 py-1',
                      autoTradeEnabled
                        ? 'border-[#13241b] bg-[#07130d]'
                        : 'border-[#1c2430] bg-bg-900',
                    ].join(' ')}
                  >
                    <Text
                      className={[
                        'text-[10px] font-semibold',
                        autoTradeEnabled ? 'text-[#00ff88]' : 'text-gray-400',
                      ].join(' ')}
                    >
                      {autoTradeEnabled ? 'AUTO-TRADE AÇIK' : 'AUTO-TRADE KAPALI'}
                    </Text>
                  </View>
                </View>
              </View>

              <Pressable
                onPress={() => {
                  if (autoTradeEnabled) {
                    void runInitialScanAndSetPositions().catch(() => {});
                  } else {
                    scanQuery.refetch();
                  }
                }}
                disabled={scanQuery.isFetching}
                className="rounded-xl border border-[#1c2430] bg-bg-900 p-3"
                accessibilityLabel="Yenile"
              >
                <RefreshCcw
                  size={18}
                  color={scanQuery.isFetching ? '#6b7280' : '#9ca3af'}
                />
              </Pressable>
            </View>

            <View className="mt-3 flex-row items-center justify-between">
              <Text className="text-xs text-gray-500">
                Min R:R: {Number.isFinite(minRiskReward) ? minRiskReward.toFixed(2) : '—'}
              </Text>
              <Text className="text-xs text-gray-500">
                {lastScanMs ? `Son tarama: ${new Date(lastScanMs).toLocaleTimeString()}` : '—'}
              </Text>
            </View>

            {scanQuery.isError ? (
              <View className="mt-4 rounded-2xl border border-[#2a1b22] bg-[#12090d] px-4 py-3">
                <Text className="text-sm text-[#ff3b5c]">
                  Tarama hatası. Tekrar dene.
                </Text>
              </View>
            ) : null}

            {scanQuery.isLoading && candidates.length === 0 ? (
              <View className="mt-6 gap-4">
                <View className="h-[180px] rounded-2xl border border-[#1c2430] bg-bg-900" />
                <View className="h-[180px] rounded-2xl border border-[#1c2430] bg-bg-900" />
                <View className="h-[180px] rounded-2xl border border-[#1c2430] bg-bg-900" />
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <CryptoCard
            symbol={item.symbol}
            entryPrice={item.entry}
            targetPrice={item.target}
            stopPrice={item.stop}
            score={item.score}
          />
        )}
      />
    </SafeAreaView>
  );
}
