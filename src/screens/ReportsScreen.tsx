import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, SectionList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Line, Rect } from 'react-native-svg';

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
  return {
    total,
    wins,
    losses,
    winRate,
    netPnlPct,
    avgPnlPct,
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
        'flex-1 rounded-xl px-3 py-3 min-h-12',
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

type PnlBucket = {
  label: string;
  pnlPct: number;
};

function buildPnlBuckets(items: TradeReport[], range: RangeKey): PnlBucket[] {
  const now = Date.now();
  const buckets: PnlBucket[] = [];

  if (range === 'day') {
    const endHour = Math.floor(now / 3_600_000) * 3_600_000;
    for (let i = 23; i >= 0; i -= 1) {
      const start = endHour - i * 3_600_000;
      const end = start + 3_600_000;
      let pnl = 0;
      for (const r of items) {
        if (r.closedAtMs >= start && r.closedAtMs < end) pnl += r.pnlPct;
      }
      const dt = new Date(start);
      const hh = String(dt.getHours()).padStart(2, '0');
      buckets.push({ label: `${hh}:00`, pnlPct: pnl });
    }
    return buckets;
  }

  const days = range === 'week' ? 7 : 30;
  const endDay = new Date(now);
  endDay.setHours(0, 0, 0, 0);
  const endMs = endDay.getTime();
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = endMs - i * 86_400_000;
    const end = start + 86_400_000;
    let pnl = 0;
    for (const r of items) {
      if (r.closedAtMs >= start && r.closedAtMs < end) pnl += r.pnlPct;
    }
    const dt = new Date(start);
    buckets.push({
      label: dt.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }),
      pnlPct: pnl,
    });
  }
  return buckets;
}

function PnlChart({ buckets }: { buckets: PnlBucket[] }) {
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null);
  const selected = selectedIndex === null ? null : buckets[selectedIndex] ?? null;

  const maxAbs = React.useMemo(() => {
    let m = 0;
    for (const b of buckets) m = Math.max(m, Math.abs(b.pnlPct));
    return m > 0 ? m : 1;
  }, [buckets]);

  const barW = 18;
  const gap = 10;
  const h = 140;
  const midY = h / 2;
  const width = Math.max(1, buckets.length) * (barW + gap);

  return (
    <View className="mt-6 rounded-2xl border border-outline-500/35 bg-bg-900/60 p-4">
      <View className="flex-row items-start justify-between">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-semibold text-gray-100">Kazanç / Kayıp Grafiği</Text>
          <Text className="mt-1 text-xs text-gray-500">Kaydırarak dönemleri inceleyin.</Text>
        </View>
        {selected ? (
          <View className="items-end">
            <Text className="text-[11px] text-gray-500">{selected.label}</Text>
            <Text className={['mt-1 text-sm font-semibold', selected.pnlPct >= 0 ? 'text-neon-green' : 'text-neon-red'].join(' ')}>
              {formatPct(selected.pnlPct)}
            </Text>
          </View>
        ) : null}
      </View>

      <View className="mt-4 overflow-hidden rounded-xl border border-outline-500/20 bg-bg-950/40">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}>
          <Svg width={width} height={h}>
            <Line x1={0} y1={midY} x2={width} y2={midY} stroke="rgba(148,163,184,0.25)" strokeWidth={1} />
            {buckets.map((b, i) => {
              const x = i * (barW + gap);
              const v = b.pnlPct;
              const barH = Math.max(2, (Math.abs(v) / maxAbs) * (h / 2 - 10));
              const y = v >= 0 ? midY - barH : midY;
              const fill = v >= 0 ? 'rgba(0,255,157,0.85)' : 'rgba(255,51,102,0.85)';
              return (
                <Rect
                  key={`${b.label}-${i}`}
                  x={x}
                  y={y}
                  width={barW}
                  height={barH}
                  rx={6}
                  fill={fill}
                  onPress={() => setSelectedIndex(i)}
                />
              );
            })}
          </Svg>
        </ScrollView>
      </View>
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
  const reportsResetAtMs = useAppStore((s) => s.reportsResetAtMs);
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
  const buckets = React.useMemo(() => buildPnlBuckets(filtered, range), [filtered, range]);
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
                <Text className="mt-2 text-sm text-gray-400">Son işlemler ve performans özeti.</Text>
                {reportsResetAtMs > 0 ? (
                  <Text className="mt-2 text-xs text-gray-500">
                    Temizlik tarihi:{' '}
                    {new Date(reportsResetAtMs).toLocaleString('tr-TR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </Text>
                ) : null}
              </View>
            </View>

            <View className="mt-5 flex-row gap-2 rounded-2xl border border-outline-500/35 bg-bg-950/40 p-2">
              <Tab label="Günlük" active={range === 'day'} onPress={() => setRange('day')} />
              <Tab label="Haftalık" active={range === 'week'} onPress={() => setRange('week')} />
              <Tab label="Aylık" active={range === 'month'} onPress={() => setRange('month')} />
            </View>

            <View className="mt-5 flex-row gap-3">
              <StatCard
                label="İşlem"
                value={`${stats.total}`}
                caption={`${stats.wins} TP • ${stats.losses} SL`}
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
                label="Win Rate"
                value={`${stats.winRate.toFixed(1)}%`}
                tone={stats.winRate >= 50 ? 'good' : 'default'}
                caption={`Aralık: ${range === 'day' ? 'Günlük' : range === 'week' ? 'Haftalık' : 'Aylık'}`}
              />
              <StatCard
                label="Ortalama"
                value={formatPct(stats.avgPnlPct)}
                tone={stats.avgPnlPct >= 0 ? 'good' : 'bad'}
                caption="İşlem başına"
              />
            </View>

            <PnlChart buckets={buckets} />

            {filtered.length === 0 ? (
              <View className="mt-6 rounded-2xl border border-outline-500/35 bg-bg-900/60 p-4">
                <Text className="text-sm text-gray-400">Bu aralıkta rapor bulunmuyor.</Text>
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
