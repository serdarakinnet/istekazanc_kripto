import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { TradeReport } from '../store/useAppStore';
import { useAppStore } from '../store/useAppStore';

type RangeKey = 'day' | 'week' | 'month';

function rangeMs(range: RangeKey): number {
  if (range === 'day') return 24 * 60 * 60 * 1000;
  if (range === 'week') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(4);
  return value.toFixed(8);
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function computeStats(items: TradeReport[]) {
  const total = items.length;
  const wins = items.filter((r) => r.outcome === 'TP').length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const pnlPct = items.reduce((acc, r) => acc + (Number.isFinite(r.pnlPct) ? r.pnlPct : 0), 0);
  return { total, wins, winRate, pnlPct };
}

function Tab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={[
        'flex-1 rounded-xl px-3 py-3',
        active ? 'bg-bg-900 border border-[#1c2430]' : 'bg-transparent border border-transparent',
      ].join(' ')}
    >
      <Text
        className={[
          'text-center text-xs font-semibold',
          active ? 'text-gray-100' : 'text-gray-500',
        ].join(' ')}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ReportsScreen() {
  const reports = useAppStore((s) => s.reports);
  const [range, setRange] = React.useState<RangeKey>('day');

  const now = Date.now();
  const filtered = React.useMemo(() => {
    const cutoff = now - rangeMs(range);
    return reports.filter((r) => r.closedAtMs >= cutoff);
  }, [now, range, reports]);

  const stats = React.useMemo(() => computeStats(filtered), [filtered]);

  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <View className="px-6 pt-6">
        <View className="flex-row items-start justify-between">
          <View className="flex-1 pr-4">
            <Text className="text-2xl font-semibold text-gray-100">Raporlar</Text>
            <Text className="mt-2 text-sm text-gray-400">
              TP/SL kapanışları, Win Rate ve PnL özeti.
            </Text>
          </View>
        </View>

        <View className="mt-5 flex-row gap-2 rounded-2xl border border-[#1c2430] bg-bg-950 p-2">
          <Tab label="Günlük" active={range === 'day'} onPress={() => setRange('day')} />
          <Tab label="Haftalık" active={range === 'week'} onPress={() => setRange('week')} />
          <Tab label="Aylık" active={range === 'month'} onPress={() => setRange('month')} />
        </View>

        <View className="mt-5 flex-row gap-3">
          <View className="flex-1 rounded-2xl border border-[#1c2430] bg-bg-900 p-4">
            <Text className="text-xs text-gray-500">Win Rate</Text>
            <Text className="mt-2 text-xl font-semibold text-gray-100">
              {stats.winRate.toFixed(1)}%
            </Text>
            <Text className="mt-1 text-[11px] text-gray-500">
              {stats.wins}/{stats.total} işlem
            </Text>
          </View>
          <View className="flex-1 rounded-2xl border border-[#1c2430] bg-bg-900 p-4">
            <Text className="text-xs text-gray-500">Toplam PnL</Text>
            <Text
              className={[
                'mt-2 text-xl font-semibold',
                stats.pnlPct >= 0 ? 'text-[#00ff88]' : 'text-[#ff3b5c]',
              ].join(' ')}
            >
              {formatPct(stats.pnlPct)}
            </Text>
            <Text className="mt-1 text-[11px] text-gray-500">
              Filtre: {range === 'day' ? 'Günlük' : range === 'week' ? 'Haftalık' : 'Aylık'}
            </Text>
          </View>
        </View>

        <View className="mt-6 gap-3">
          {filtered.length === 0 ? (
            <View className="rounded-2xl border border-[#1c2430] bg-bg-900 p-4">
              <Text className="text-sm text-gray-400">
                Bu aralıkta kapanmış işlem yok.
              </Text>
            </View>
          ) : (
            filtered.map((r) => {
              const isWin = r.outcome === 'TP';
              return (
                <View
                  key={r.id}
                  className="rounded-2xl border border-[#1c2430] bg-bg-900 p-4"
                >
                  <View className="flex-row items-start justify-between">
                    <View>
                      <Text className="text-base font-semibold text-gray-100">
                        {r.symbol}
                      </Text>
                      <Text className="mt-1 text-xs text-gray-500">
                        {new Date(r.closedAtMs).toLocaleString()}
                      </Text>
                    </View>
                    <View
                      className={[
                        'rounded-full border px-3 py-1',
                        isWin
                          ? 'border-[#13241b] bg-[#07130d]'
                          : 'border-[#2a1b22] bg-[#12090d]',
                      ].join(' ')}
                    >
                      <Text
                        className={[
                          'text-[10px] font-semibold',
                          isWin ? 'text-[#00ff88]' : 'text-[#ff3b5c]',
                        ].join(' ')}
                      >
                        {isWin ? 'TAKE PROFIT' : 'STOP LOSS'}
                      </Text>
                    </View>
                  </View>

                  <View className="mt-3 flex-row justify-between">
                    <View>
                      <Text className="text-[11px] text-gray-500">Entry</Text>
                      <Text className="mt-1 text-sm font-semibold text-gray-200">
                        {formatPrice(r.entry)}
                      </Text>
                    </View>
                    <View>
                      <Text className="text-[11px] text-gray-500">Exit</Text>
                      <Text className="mt-1 text-sm font-semibold text-gray-200">
                        {formatPrice(r.exit)}
                      </Text>
                    </View>
                    <View>
                      <Text className="text-[11px] text-gray-500">PnL</Text>
                      <Text
                        className={[
                          'mt-1 text-sm font-semibold',
                          r.pnlPct >= 0 ? 'text-[#00ff88]' : 'text-[#ff3b5c]',
                        ].join(' ')}
                      >
                        {formatPct(r.pnlPct)}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
