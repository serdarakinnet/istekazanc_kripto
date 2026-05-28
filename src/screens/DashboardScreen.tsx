import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, RefreshCcw, TrendingDown, TrendingUp } from 'lucide-react-native';
import * as React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CryptoCard } from '../components/CryptoCard/CryptoCard';
import { binanceWS } from '../services/binanceWebSocket';
import { applyLivePricesAndRotate, runBotCycle, runInitialScanAndSetPositions } from '../services/botController';
import { scanTop3 } from '../services/tradingEngine';
import { usePriceHistoryStore } from '../store/priceHistoryStore';
import { useAppStore } from '../store/useAppStore';

export function DashboardScreen() {
  const navigation = useNavigation<any>();
  const reports = useAppStore((s) => s.reports);
  const rawMinRiskReward = useAppStore((s) => s.settings.minRiskReward);
  const autoTradeEnabled = useAppStore((s) => s.settings.autoTradeEnabled);
  const watchlist = useAppStore((s) => s.watchlist);
  const positions = useAppStore((s) => s.positions);
  const lastScanMs = useAppStore((s) => s.lastScanMs);
  const setWatchlist = useAppStore((s) => s.setWatchlist);
  const closePositionManually = useAppStore((s) => s.closePositionManually);

  const lastRotateMsRef = React.useRef(0);
  const [isScanning, setIsScanning] = React.useState(false);

  const minRiskReward = React.useMemo(() => {
    const n = typeof rawMinRiskReward === 'number' ? rawMinRiskReward : Number(rawMinRiskReward);
    return Number.isFinite(n) && n > 0 ? n : 1.5;
  }, [rawMinRiskReward]);

  const scanQuery = useQuery({
    queryKey: ['scanTop3', minRiskReward],
    queryFn: async () => {
      try {
        return await scanTop3({ minRiskReward });
      } catch {
        return {
          asOfMs: Date.now(),
          quoteAsset: 'TRY',
          topCandidates: watchlist.slice(0, 3),
          rejected: [],
        };
      }
    },
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

  // GÖREV 1: Auto-trade açıkken ve aktif pozisyon kalmadığında otomatik taramayı tetikle
  React.useEffect(() => {
    if (autoTradeEnabled && positions.length === 0 && !isScanning) {
      const triggerAutoScan = async () => {
        setIsScanning(true);
        try {
          await runInitialScanAndSetPositions();
        } catch (e) {
          console.error('Otomatik tarama hatası:', e);
        } finally {
          setIsScanning(false);
        }
      };

      const now = Date.now();
      const lastScan = lastScanMs ?? 0;
      // 10 saniyelik cooldown ile sonsuz hızlı tarama döngüsünü engelle
      if (now - lastScan > 10000) {
        void triggerAutoScan();
      }
    }
  }, [autoTradeEnabled, positions.length, lastScanMs, isScanning]);

  const showingPositions = autoTradeEnabled && positions.length > 0;
  const candidates = React.useMemo(() => {
    const base =
      autoTradeEnabled && positions.length > 0
        ? positions
        : watchlist.length > 0
          ? watchlist
          : scanQuery.data?.topCandidates ?? [];

    const pool = autoTradeEnabled
      ? [...base, ...watchlist, ...(scanQuery.data?.topCandidates ?? [])]
      : base;

    const out: typeof base = [];
    const seen = new Set<string>();
    for (const item of pool) {
      const sym = String(item.symbol || '').trim().toUpperCase();
      if (!sym) continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      out.push({ ...item, symbol: sym });
      if (out.length >= 3) break;
    }
    return out;
  }, [autoTradeEnabled, positions, scanQuery.data?.topCandidates, watchlist]);

  const todayReports = React.useMemo(() => {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    return reports.filter((r) => r.closedAtMs >= cutoff);
  }, [reports]);

  const todayStats = React.useMemo(() => {
    const total = todayReports.length;
    let wins = 0;
    let netPnlPct = 0;
    for (const r of todayReports) {
      if (r.outcome === 'TP') wins++;
      if (Number.isFinite(r.pnlPct)) netPnlPct += r.pnlPct;
    }
    return { total, wins, losses: total - wins, netPnlPct };
  }, [todayReports]);

  type Row =
    | ({ kind: 'crypto' } & (typeof candidates)[number])
    | { kind: 'empty'; id: string };

  const rows = React.useMemo<Row[]>(() => {
    const cryptoRows: Row[] = candidates.map((c) => ({ ...c, kind: 'crypto' }));
    const missing = Math.max(0, 3 - cryptoRows.length);
    for (let i = 0; i < missing; i += 1) {
      cryptoRows.push({ kind: 'empty', id: `empty-${i}` });
    }
    return cryptoRows;
  }, [candidates]);

  const symbols = React.useMemo(
    () => rows.filter((r): r is Extract<Row, { kind: 'crypto' }> => r.kind === 'crypto').map((r) => r.symbol),
    [rows],
  );

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
      <View className="absolute inset-0">
        <View className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-neon-cyan/10" />
        <View className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-neon-green/5" />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => (item.kind === 'empty' ? item.id : item.symbol)}
        contentContainerStyle={{ paddingTop: 24, paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="px-6">
            <View className="mb-6 rounded-2xl border border-outline-500/35 bg-bg-900/60 p-4">
              <View className="flex-row items-center justify-between border-b border-outline-500/20 pb-3">
                <View>
                  <Text className="text-xs font-medium text-gray-400">Son 24 Saat Performansı</Text>
                  <View className="mt-1 flex-row items-baseline gap-2">
                    <Text className={`text-2xl font-bold ${todayStats.netPnlPct >= 0 ? 'text-neon-green' : 'text-neon-red'}`}>
                      {todayStats.netPnlPct > 0 ? '+' : ''}{todayStats.netPnlPct.toFixed(2)}%
                    </Text>
                    <Text className="text-xs text-gray-500">
                      ({todayStats.wins} TP / {todayStats.losses} SL)
                    </Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => navigation.navigate('Reports')}
                  className="flex-row items-center rounded-lg bg-bg-950/50 px-3 py-2 border border-outline-500/20"
                >
                  <Text className="text-xs font-semibold text-gray-300 mr-1">Raporlar</Text>
                  <ChevronRight size={14} color="#d1d5db" />
                </Pressable>
              </View>

              <View className="pt-3">
                {todayReports.length === 0 ? (
                  <Text className="py-2 text-center text-xs text-gray-500">Son 24 saatte işlem bulunmuyor.</Text>
                ) : (
                  todayReports.slice(0, 3).map((r, i) => {
                    const isWin = r.outcome === 'TP';
                    return (
                      <View key={r.id} className={`flex-row items-center justify-between ${i !== 0 ? 'mt-3' : ''}`}>
                        <View className="flex-row items-center gap-2">
                          <View className={`rounded-full p-1.5 ${isWin ? 'bg-neon-green/10' : 'bg-neon-red/10'}`}>
                            {isWin ? <TrendingUp size={14} color="#00ff9d" /> : <TrendingDown size={14} color="#ff3366" />}
                          </View>
                          <Text className="text-[15px] font-semibold text-gray-200">{r.symbol}</Text>
                        </View>
                        <View className="items-end">
                          <Text className={`text-sm font-semibold ${isWin ? 'text-neon-green' : 'text-neon-red'}`}>
                            {isWin ? '+' : ''}{r.pnlPct.toFixed(2)}%
                          </Text>
                          <Text className="text-[10px] text-gray-500">
                            {new Date(r.closedAtMs).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                          </Text>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            </View>

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
                        ? 'border-neon-green/20 bg-neon-green/10'
                        : 'border-outline-500/35 bg-bg-900/60',
                    ].join(' ')}
                  >
                    <Text
                      className={[
                        'text-[10px] font-semibold',
                        autoTradeEnabled ? 'text-neon-green' : 'text-outline-400',
                      ].join(' ')}
                    >
                      {autoTradeEnabled ? 'AUTO-TRADE AÇIK' : 'AUTO-TRADE KAPALI'}
                    </Text>
                  </View>
                </View>
              </View>

              <Pressable
                onPress={async () => {
                  if (autoTradeEnabled) {
                    setIsScanning(true);
                    try {
                      await runInitialScanAndSetPositions();
                    } catch (e) {
                      console.error('Yenileme tarama hatası:', e);
                    } finally {
                      setIsScanning(false);
                    }
                  } else {
                    scanQuery.refetch();
                  }
                }}
                disabled={scanQuery.isFetching || isScanning}
                className="rounded-xl border border-outline-500/35 bg-bg-900/60 p-3"
                accessibilityLabel="Yenile"
              >
                <RefreshCcw
                  size={18}
                  color={(scanQuery.isFetching || isScanning) ? '#6b7280' : '#9ca3af'}
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

            {(scanQuery.isLoading || isScanning) && candidates.length === 0 ? (
              <View className="mt-6 gap-4">
                <View className="h-[180px] rounded-2xl border border-outline-500/35 bg-bg-900/60" />
                <View className="h-[180px] rounded-2xl border border-outline-500/35 bg-bg-900/60" />
                <View className="h-[180px] rounded-2xl border border-outline-500/35 bg-bg-900/60" />
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          if (item.kind === 'empty') {
            return (
              <View style={{ marginHorizontal: 16, marginVertical: 8 }}>
                <View className="overflow-hidden rounded-2xl border border-outline-500/35 bg-bg-900/60">
                  <View className="p-5">
                    <Text className="text-[15px] font-semibold text-gray-200">
                      Tarama Sonucu Uygun Kripto Bulunamadı
                    </Text>
                  </View>
                </View>
              </View>
            );
          }

          return (
            <CryptoCard
              symbol={item.symbol}
              entryPrice={item.entry}
              targetPrice={item.target}
              stopPrice={item.stop}
              score={item.score}
              onClose={
                showingPositions
                  ? () => {
                      const sym = item.symbol.trim().toUpperCase();
                      closePositionManually({ symbol: sym });
                      void runBotCycle().catch(() => {});
                    }
                  : undefined
              }
            />
          );
        }}
      />
    </SafeAreaView>
  );
}
