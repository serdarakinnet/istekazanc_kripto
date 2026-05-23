import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, RefreshCcw } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useLiveTickerPrices } from '../hooks/useLiveTickerPrices';
import { applyLivePricesAndRotate, runInitialScanAndSetPositions } from '../services/botController';
import type { ScannedCandidate } from '../services/tradingEngine';
import { scanTop3 } from '../services/tradingEngine';
import { useAppStore } from '../store/useAppStore';

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(4);
  return value.toFixed(8);
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function scoreToUi(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function CandidateCard({
  candidate,
  livePrice,
}: {
  candidate: ScannedCandidate;
  livePrice: { price: number; direction: 'up' | 'down' | null } | null;
}) {
  const priceValue = livePrice?.price ?? candidate.lastPrice;
  const priceFlash =
    livePrice?.direction === 'up'
      ? 'bg-[#07130d] border-[#13241b]'
      : livePrice?.direction === 'down'
        ? 'bg-[#12090d] border-[#2a1b22]'
        : 'bg-transparent border-[#1c2430]';

  const pct = candidate.lastChangePercent;
  const pctUp = pct >= 0;
  const pnlPct =
    candidate.entry > 0 ? ((priceValue - candidate.entry) / candidate.entry) * 100 : Number.NaN;
  const pnlUp = pnlPct >= 0;

  return (
    <View className="rounded-2xl border border-[#1c2430] bg-bg-900 p-4">
      <View className="flex-row items-start justify-between">
        <View>
          <Text className="text-lg font-semibold text-gray-100">
            {candidate.symbol}
          </Text>
          <Text className="mt-1 text-xs text-gray-400">
            AI Skoru: {scoreToUi(candidate.score)}/100
          </Text>
        </View>

        <View
          className={[
            'rounded-xl border px-3 py-2',
            priceFlash,
          ].join(' ')}
        >
          <Text className="text-base font-semibold text-gray-100">
            {formatPrice(priceValue)}
          </Text>
          <View className="mt-1 flex-row items-center justify-end gap-1">
            {pctUp ? (
              <ArrowUpRight size={14} color="#00ff88" />
            ) : (
              <ArrowDownRight size={14} color="#ff3b5c" />
            )}
            <Text
              className={[
                'text-xs font-semibold',
                pctUp ? 'text-[#00ff88]' : 'text-[#ff3b5c]',
              ].join(' ')}
            >
              {formatPercent(pct)}
            </Text>
          </View>
        </View>
      </View>

      <View className="mt-4 flex-row justify-between">
        <View>
          <Text className="text-[11px] text-gray-500">Entry</Text>
          <Text className="mt-1 text-sm font-semibold text-gray-200">
            {formatPrice(candidate.entry)}
          </Text>
        </View>
        <View>
          <Text className="text-[11px] text-gray-500">Target</Text>
          <Text className="mt-1 text-sm font-semibold text-[#00ff88]">
            {formatPrice(candidate.target)}
          </Text>
        </View>
        <View>
          <Text className="text-[11px] text-gray-500">Stop</Text>
          <Text className="mt-1 text-sm font-semibold text-[#ff3b5c]">
            {formatPrice(candidate.stop)}
          </Text>
        </View>
        <View>
          <Text className="text-[11px] text-gray-500">K/Z</Text>
          <Text
            className={[
              'mt-1 text-sm font-semibold',
              pnlUp ? 'text-[#00ff88]' : 'text-[#ff3b5c]',
            ].join(' ')}
          >
            {formatPercent(pnlPct)}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function DashboardScreen() {
  const minRiskReward = useAppStore((s) => s.settings.minRiskReward);
  const autoTradeEnabled = useAppStore((s) => s.settings.autoTradeEnabled);
  const watchlist = useAppStore((s) => s.watchlist);
  const positions = useAppStore((s) => s.positions);
  const lastScanMs = useAppStore((s) => s.lastScanMs);
  const setWatchlist = useAppStore((s) => s.setWatchlist);

  const scanQuery = useQuery({
    queryKey: ['scanTop3', minRiskReward],
    queryFn: async () => scanTop3({ minRiskReward }),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  });

  React.useEffect(() => {
    if (scanQuery.data?.topCandidates) {
      setWatchlist(scanQuery.data.topCandidates, scanQuery.data.asOfMs);
    }
  }, [scanQuery.data?.asOfMs, scanQuery.data?.topCandidates, setWatchlist]);

  const candidates =
    autoTradeEnabled && positions.length > 0
      ? positions
      : watchlist.length > 0
        ? watchlist
        : scanQuery.data?.topCandidates ?? [];
  const symbols = candidates.map((c) => c.symbol);
  const livePrices = useLiveTickerPrices(symbols, { throttleMs: 1000, flashMs: 250 });

  React.useEffect(() => {
    if (!autoTradeEnabled) return;
    if (symbols.length === 0) return;

    const prices: Record<string, number> = {};
    for (const symbol of symbols) {
      const p = livePrices[symbol];
      if (p) prices[symbol] = p.price;
    }

    if (Object.keys(prices).length === 0) return;
    applyLivePricesAndRotate(prices);
  }, [autoTradeEnabled, livePrices, symbols.join('|')]);

  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <View className="px-6 pt-6">
        <View className="flex-row items-start justify-between">
          <View className="flex-1 pr-4">
            <Text className="text-2xl font-semibold text-gray-100">
              Aktif Seçimler
            </Text>
            <View className="mt-2 flex-row items-center gap-2">
              <Text className="text-sm text-gray-400">
                En İyi 3 kripto: tarama + canlı fiyat.
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
                runInitialScanAndSetPositions();
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
            Min R:R: {minRiskReward.toFixed(2)}
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

        <View className="mt-6 gap-4">
          {scanQuery.isLoading && candidates.length === 0 ? (
            <>
              <View className="h-[124px] rounded-2xl border border-[#1c2430] bg-bg-900" />
              <View className="h-[124px] rounded-2xl border border-[#1c2430] bg-bg-900" />
              <View className="h-[124px] rounded-2xl border border-[#1c2430] bg-bg-900" />
            </>
          ) : (
            candidates.map((candidate) => (
              <CandidateCard
                key={candidate.symbol}
                candidate={candidate}
                livePrice={
                  livePrices[candidate.symbol]
                    ? {
                        price: livePrices[candidate.symbol]!.price,
                        direction: livePrices[candidate.symbol]!.direction,
                      }
                    : null
                }
              />
            ))
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
