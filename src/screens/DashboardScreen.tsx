import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, RefreshCcw, TrendingDown, TrendingUp } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
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
    if (next.length === 0) return;
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
        contentContainerStyle={{ paddingTop: 16, paddingBottom: 100 }}
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

            {/* Section header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={{ fontSize: 22, fontWeight: '700', color: '#f3f4f6' }}>Aktif Seçimler</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <View
                    style={{
                      borderRadius: 20,
                      borderWidth: 1,
                      borderColor: autoTradeEnabled ? 'rgba(0,255,157,0.3)' : 'rgba(66,70,86,0.5)',
                      backgroundColor: autoTradeEnabled ? 'rgba(0,255,157,0.08)' : 'rgba(17,24,46,0.5)',
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: autoTradeEnabled ? '#00ff9d' : '#6b7280',
                      }}
                    />
                    <Text
                      style={{
                        fontSize: 10,
                        fontWeight: '700',
                        letterSpacing: 0.8,
                        color: autoTradeEnabled ? '#00ff9d' : '#6b7280',
                      }}
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
                style={{
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: 'rgba(66,70,86,0.4)',
                  backgroundColor: 'rgba(17,24,46,0.6)',
                  padding: 12,
                }}
                accessibilityLabel="Yenile"
              >
                <RefreshCcw
                  size={18}
                  color={(scanQuery.isFetching || isScanning) ? '#6b7280' : '#9ca3af'}
                />
              </Pressable>
            </View>

            {/* Son tarama bilgisi */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ fontSize: 11, color: '#6b7280' }}>
                Min R:R: {Number.isFinite(minRiskReward) ? minRiskReward.toFixed(2) : '—'}
              </Text>
              <Text style={{ fontSize: 11, color: '#6b7280' }}>
                {lastScanMs ? `Son: ${new Date(lastScanMs).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` : 'Henüz tarama yapılmadı'}
              </Text>
            </View>

            {/* Tarama durumu göstergesi */}
            {(scanQuery.isLoading || isScanning) && candidates.length === 0 ? (
              <View
                style={{
                  marginBottom: 8,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: 'rgba(0,255,157,0.2)',
                  backgroundColor: 'rgba(0,255,157,0.05)',
                  padding: 20,
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <ActivityIndicator size="large" color="#00ff9d" />
                <View style={{ alignItems: 'center', gap: 4 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#d1fae5' }}>
                    {isScanning ? 'Piyasa Taranıyor…' : 'Kripto Analiz Ediliyor…'}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#6b7280', textAlign: 'center' }}>
                    {isScanning
                      ? 'Deep Fibonacci V6.5 motoru çalışıyor, en iyi 3 kripto belirleniyor.'
                      : 'Binance verisi işleniyor, lütfen bekleyin.'}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          if (item.kind === 'empty') {
            if (isScanning || scanQuery.isLoading) return null;
            return (
              <View style={{ marginHorizontal: 12, marginVertical: 6 }}>
                <View
                  style={{
                    borderRadius: 20,
                    borderWidth: 1,
                    borderColor: 'rgba(66,70,86,0.3)',
                    backgroundColor: 'rgba(17,24,46,0.6)',
                    borderStyle: 'dashed',
                    padding: 24,
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <Text style={{ fontSize: 28 }}>🔍</Text>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#9ca3af', textAlign: 'center' }}>
                    Uygun Sinyal Bulunamadı
                  </Text>
                  <Text style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', lineHeight: 18 }}>
                    Piyasa şu an strateji kriterlerini (Trend, Hacim, RSI) karşılamıyor olabilir.{`\n`}Yenile butonuna basarak tekrar taratabilirsiniz.
                  </Text>
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
