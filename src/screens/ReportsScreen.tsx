import * as React from 'react';
import { Pressable, RefreshControl, SectionList, Text, View } from 'react-native';
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
  const losses = total - wins;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const netPnlPct = items.reduce((acc, r) => acc + (Number.isFinite(r.pnlPct) ? r.pnlPct : 0), 0);
  const avgPnlPct = total > 0 ? netPnlPct / total : 0;
  const grossProfit = items.reduce(
    (acc, r) => acc + (Number.isFinite(r.pnlPct) && r.pnlPct > 0 ? r.pnlPct : 0),
    0,
  );
  const grossLoss = items.reduce(
    (acc, r) => acc + (Number.isFinite(r.pnlPct) && r.pnlPct < 0 ? Math.abs(r.pnlPct) : 0),
    0,
  );
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const best = items.reduce((m, r) => (Number.isFinite(r.pnlPct) ? Math.max(m, r.pnlPct) : m), -Infinity);
  const worst = items.reduce((m, r) => (Number.isFinite(r.pnlPct) ? Math.min(m, r.pnlPct) : m), Infinity);
  return {
    total,
    wins,
    losses,
    winRate,
    netPnlPct,
    avgPnlPct,
    profitFactor,
    best: Number.isFinite(best) ? best : 0,
    worst: Number.isFinite(worst) ? worst : 0,
  };
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
        active ? 'bg-bg-900/60 border border-outline-500/35' : 'bg-transparent border border-transparent',
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

function StatCard({
  label,
  value,
  tone,
  caption,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'good' | 'bad';
  caption?: string;
}) {
  const toneClass =
    tone === 'good' ? 'text-neon-green' : tone === 'bad' ? 'text-neon-red' : 'text-gray-100';
  return (
    <View className="flex-1 rounded-2xl border border-outline-500/35 bg-bg-900/60 p-4">
      <Text className="text-xs text-gray-500">{label}</Text>
      <Text className={['mt-2 text-xl font-semibold', toneClass].join(' ')}>{value}</Text>
      {caption ? <Text className="mt-1 text-[11px] text-gray-500">{caption}</Text> : null}
    </View>
  );
}

function formatDayHeader(dateKey: string): string {
  const parts = dateKey.split('-').map((x) => Number(x));
  if (parts.length !== 3) return dateKey;
  const [y, m, d] = parts;
  const dt = new Date(y, m - 1, d);
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yestKey = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, '0')}-${String(yest.getDate()).padStart(2, '0')}`;
  if (dateKey === todayKey) return 'Bugün';
  if (dateKey === yestKey) return 'Dün';
  return dt.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', weekday: 'long' });
}

function formatDuration(openedAtMs: number, closedAtMs: number): string {
  const delta = Math.max(0, closedAtMs - openedAtMs);
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}dk`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}s ${rem}dk`;
}

function ReportRow({ item }: { item: TradeReport }) {
  const isWin = item.outcome === 'TP';
  return (
    <View className="mx-6 mb-3 rounded-2xl border border-outline-500/35 bg-bg-900/60 p-4">
      <View className="flex-row items-start justify-between">
        <View className="flex-1 pr-3">
          <Text className="text-base font-semibold text-gray-100">{item.symbol}</Text>
          <Text className="mt-1 text-xs text-gray-500">
            {new Date(item.closedAtMs).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} •{' '}
            {formatDuration(item.openedAtMs, item.closedAtMs)}
          </Text>
        </View>
        <View
          className={[
            'rounded-full border px-3 py-1',
            isWin ? 'border-neon-green/20 bg-neon-green/10' : 'border-neon-red/20 bg-neon-red/10',
          ].join(' ')}
        >
          <Text className={['text-[10px] font-semibold', isWin ? 'text-neon-green' : 'text-neon-red'].join(' ')}>
            {isWin ? 'TAKE PROFIT' : 'STOP LOSS'}
          </Text>
        </View>
      </View>

      <View className="mt-3 flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="text-[11px] text-gray-500">Entry</Text>
          <Text className="mt-1 text-sm font-semibold text-gray-200">{formatPrice(item.entry)}</Text>
        </View>
        <View className="flex-1 items-center">
          <Text className="text-[11px] text-gray-500">Exit</Text>
          <Text className="mt-1 text-sm font-semibold text-gray-200">{formatPrice(item.exit)}</Text>
        </View>
        <View className="flex-1 items-end">
          <Text className="text-[11px] text-gray-500">PnL</Text>
          <Text className={['mt-1 text-sm font-semibold', item.pnlPct >= 0 ? 'text-neon-green' : 'text-neon-red'].join(' ')}>
            {formatPct(item.pnlPct)}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function ReportsScreen() {
  const reports = useAppStore((s) => s.reports);
  const refreshReportsFromServer = useAppStore((s) => s.refreshReportsFromServer);
  const [range, setRange] = React.useState<RangeKey>('day');
  const [refreshing, setRefreshing] = React.useState(false);

  const now = Date.now();
  const filtered = React.useMemo(() => {
    const cutoff = now - rangeMs(range);
    const byKey = new Map<string, TradeReport>();
    for (const r of reports) {
      if (r.closedAtMs < cutoff) continue;
      const symbol = String(r.symbol || '').trim().toUpperCase();
      const openedAtMs = Number(r.openedAtMs);
      const closedAtMs = Number(r.closedAtMs);
      const outcome = r.outcome === 'TP' ? 'TP' : 'SL';
      if (!symbol) continue;
      if (!Number.isFinite(openedAtMs) || !Number.isFinite(closedAtMs)) continue;
      const key = `${symbol}|${openedAtMs}|${outcome}`;
      const existing = byKey.get(key);
      if (!existing || closedAtMs > existing.closedAtMs) {
        byKey.set(key, { ...r, symbol, openedAtMs, closedAtMs, outcome });
      }
    }
    return Array.from(byKey.values()).sort((a, b) => b.closedAtMs - a.closedAtMs);
  }, [now, range, reports]);

  const stats = React.useMemo(() => computeStats(filtered), [filtered]);
  const sections = React.useMemo(() => {
    const byDay = new Map<string, TradeReport[]>();
    for (const r of filtered) {
      const dt = new Date(r.closedAtMs);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const arr = byDay.get(key);
      if (arr) arr.push(r);
      else byDay.set(key, [r]);
    }
    const dayKeys = Array.from(byDay.keys()).sort((a, b) => (a < b ? 1 : -1));
    return dayKeys.map((k) => ({ title: formatDayHeader(k), data: byDay.get(k) ?? [] }));
  }, [filtered]);

  React.useEffect(() => {
    void (async () => {
      setRefreshing(true);
      try {
        await refreshReportsFromServer();
      } finally {
        setRefreshing(false);
      }
    })();
  }, [refreshReportsFromServer]);

  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <View className="absolute inset-0" pointerEvents="none">
        <View className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-neon-cyan/10" />
        <View className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-neon-green/5" />
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        removeClippedSubviews
        refreshControl={
          <RefreshControl
            tintColor="#9ca3af"
            refreshing={refreshing}
            onRefresh={() => {
              void (async () => {
                setRefreshing(true);
                try {
                  await refreshReportsFromServer();
                } finally {
                  setRefreshing(false);
                }
              })();
            }}
          />
        }
        ListHeaderComponent={
          <View className="px-6 pt-6">
            <View className="flex-row items-start justify-between">
              <View className="flex-1 pr-4">
                <Text className="text-2xl font-semibold text-gray-100">Raporlar</Text>
                <Text className="mt-2 text-sm text-gray-400">
                  Gerçekleşen TP/SL kapanışları, performans özeti ve işlem geçmişi.
                </Text>
              </View>
            </View>

            <View className="mt-5 flex-row gap-2 rounded-2xl border border-outline-500/35 bg-bg-950/40 p-2">
              <Tab label="Günlük" active={range === 'day'} onPress={() => setRange('day')} />
              <Tab label="Haftalık" active={range === 'week'} onPress={() => setRange('week')} />
              <Tab label="Aylık" active={range === 'month'} onPress={() => setRange('month')} />
            </View>

            <View className="mt-5 flex-row gap-3">
              <StatCard
                label="Win Rate"
                value={`${stats.winRate.toFixed(1)}%`}
                caption={`${stats.wins}/${stats.total} işlem`}
              />
              <StatCard
                label="Net PnL"
                value={formatPct(stats.netPnlPct)}
                tone={stats.netPnlPct >= 0 ? 'good' : 'bad'}
                caption={`Ortalama: ${formatPct(stats.avgPnlPct)}`}
              />
            </View>

            <View className="mt-3 flex-row gap-3">
              <StatCard
                label="Profit Factor"
                value={stats.profitFactor === 99 ? '∞' : stats.profitFactor.toFixed(2)}
                caption={`${stats.wins} TP • ${stats.losses} SL`}
              />
              <StatCard
                label="Best / Worst"
                value={`${formatPct(stats.best)} / ${formatPct(stats.worst)}`}
                caption={`Aralık: ${range === 'day' ? 'Günlük' : range === 'week' ? 'Haftalık' : 'Aylık'}`}
              />
            </View>

            {filtered.length === 0 ? (
              <View className="mt-6 rounded-2xl border border-outline-500/35 bg-bg-900/60 p-4">
                <Text className="text-sm text-gray-400">Bu aralıkta kapanmış işlem yok.</Text>
              </View>
            ) : (
              <View className="mt-6" />
            )}
          </View>
        }
        renderSectionHeader={({ section }) =>
          section.data.length === 0 ? null : (
            <View className="mx-6 mb-3 mt-2">
              <Text className="text-xs font-semibold text-gray-400">{section.title}</Text>
            </View>
          )
        }
        renderItem={({ item }) => <ReportRow item={item} />}
        ListFooterComponent={<View className="h-8" />}
      />
    </SafeAreaView>
  );
}
