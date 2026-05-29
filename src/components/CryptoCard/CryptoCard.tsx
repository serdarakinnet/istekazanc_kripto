import * as React from 'react';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { usePriceHistoryStore } from '../../store/priceHistoryStore';
import { PriceFlash } from './PriceFlash';
import { SparklineChart } from './SparklineChart';

export interface CryptoCardProps {
  symbol: string;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  score: number;
  onClose?: () => void;
}

const EMPTY_HISTORY: number[] = [];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatTry(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits =
    abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.1 ? 5 : abs >= 0.01 ? 6 : 8;
  try {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: 'TRY',
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `₺${value.toFixed(digits)}`;
  }
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function stripTry(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  return s.endsWith('TRY') ? s.slice(0, -3) : s;
}

function ScoreTier({ score }: { score: number }) {
  const tier =
    score >= 85
      ? { label: 'GÜÇLÜ', bg: 'bg-neon-green/15', border: 'border-neon-green/50', text: 'text-neon-green', dot: '#00ff9d' }
      : score >= 70
        ? { label: 'ORTA', bg: 'bg-[#FBBF24]/10', border: 'border-[#FBBF24]/50', text: 'text-[#FBBF24]', dot: '#FBBF24' }
        : { label: 'ZAYIF', bg: 'bg-outline-500/10', border: 'border-outline-500/35', text: 'text-gray-400', dot: '#9ca3af' };

  return (
    <View className={`flex-row items-center gap-1.5 rounded-full border px-2.5 py-1 ${tier.bg} ${tier.border}`}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tier.dot }} />
      <Text className={`text-[10px] font-bold tracking-wider ${tier.text}`}>
        {tier.label} · {Math.round(score)}
      </Text>
    </View>
  );
}

function CryptoCardImpl({ symbol, entryPrice, targetPrice, stopPrice, score, onClose }: CryptoCardProps) {
  const upperSymbol = useMemo(() => symbol.toUpperCase(), [symbol]);
  const history = usePriceHistoryStore((s) => s.history[upperSymbol] ?? EMPTY_HISTORY);
  const currentPrice = usePriceHistoryStore((s) => s.currentPrices[upperSymbol] ?? null);

  const pnlPct = useMemo(() => {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return Number.NaN;
    if (currentPrice === null || !Number.isFinite(currentPrice)) return Number.NaN;
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }, [currentPrice, entryPrice]);

  const pnlUp = !Number.isNaN(pnlPct) && pnlPct >= 0;

  const progressPct = useMemo(() => {
    if (currentPrice === null || !Number.isFinite(currentPrice)) return 0;
    if (!Number.isFinite(stopPrice) || !Number.isFinite(targetPrice)) return 0;
    const denom = targetPrice - stopPrice;
    if (!Number.isFinite(denom) || denom === 0) return 0;
    const raw = ((currentPrice - stopPrice) / denom) * 100;
    return clamp(raw, 0, 100);
  }, [currentPrice, stopPrice, targetPrice]);

  const sparkColor = pnlUp ? '#00ff9d' : '#ff3366';
  const displaySymbol = stripTry(symbol);

  const rr = useMemo(() => {
    if (!Number.isFinite(entryPrice) || !Number.isFinite(targetPrice) || !Number.isFinite(stopPrice)) return null;
    const reward = targetPrice - entryPrice;
    const risk = entryPrice - stopPrice;
    if (risk <= 0) return null;
    return reward / risk;
  }, [entryPrice, targetPrice, stopPrice]);

  return (
    <PriceFlash
      price={currentPrice}
      style={[{ marginHorizontal: 12, marginVertical: 6 }]}
    >
      {/* Card container — elevated look */}
      <View
        style={{
          borderRadius: 20,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: 'rgba(99,102,126,0.25)',
          backgroundColor: 'rgba(17,24,46,0.85)',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.35,
          shadowRadius: 12,
          elevation: 8,
        }}
      >
        {/* Top accent line based on score */}
        <View
          style={{
            height: 3,
            backgroundColor:
              score >= 85 ? '#00ff9d' : score >= 70 ? '#FBBF24' : '#424656',
          }}
        />

        <View style={{ padding: 16 }}>
          {/* Header row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 26, fontWeight: '700', color: '#f3f4f6', letterSpacing: -0.5 }}>
                  {displaySymbol}
                </Text>
                <View style={{ backgroundColor: 'rgba(0, 255, 157, 0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: 'rgba(0, 255, 157, 0.3)' }}>
                  <Text style={{ fontSize: 9, fontWeight: '700', color: '#00ff9d' }}>AI ✓</Text>
                </View>
              </View>
              <Text style={{ fontSize: 11, color: '#6b7280', marginTop: 2, letterSpacing: 0.5 }}>
                {symbol.trim().toUpperCase()}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {onClose ? (
                <Pressable
                  onPress={onClose}
                  style={{
                    borderRadius: 20,
                    borderWidth: 1,
                    borderColor: 'rgba(255,51,102,0.3)',
                    backgroundColor: 'rgba(255,51,102,0.1)',
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#ff3366' }}>KAPAT</Text>
                </Pressable>
              ) : null}
              <ScoreTier score={score} />
            </View>
          </View>

          {/* Price + Sparkline row */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 16 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Güncel Fiyat</Text>
              <Text style={{ fontSize: 22, fontWeight: '700', color: '#f3f4f6' }}>
                {currentPrice !== null ? formatTry(currentPrice) : '—'}
              </Text>
              {Number.isFinite(pnlPct) ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: pnlUp ? '#00ff9d' : '#ff3366' }}>
                    {pnlUp ? '▲' : '▼'} {formatPct(pnlPct)}
                  </Text>
                  <Text style={{ fontSize: 11, color: '#6b7280' }}>giriş'ten</Text>
                </View>
              ) : (
                <Text style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Fiyat bekleniyor…</Text>
              )}
            </View>
            {history.length >= 2 ? (
              <SparklineChart
                data={history.slice(-30)}
                width={110}
                height={52}
                color={sparkColor}
              />
            ) : null}
          </View>

          {/* Divider */}
          <View style={{ height: 1, backgroundColor: 'rgba(66,70,86,0.3)', marginVertical: 14 }} />

          {/* Entry / Target / Stop */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5 }}>Giriş</Text>
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#e5e7eb', marginTop: 4 }}>
                {formatTry(entryPrice)}
              </Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 10, color: '#00ff9d', textTransform: 'uppercase', letterSpacing: 0.5 }}>Hedef</Text>
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#00ff9d', marginTop: 4 }}>
                {formatTry(targetPrice)}
              </Text>
              {Number.isFinite(entryPrice) && Number.isFinite(targetPrice) ? (
                <Text style={{ fontSize: 10, color: '#00ff9d', opacity: 0.7 }}>
                  {formatPct(((targetPrice - entryPrice) / entryPrice) * 100)}
                </Text>
              ) : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontSize: 10, color: '#ff3366', textTransform: 'uppercase', letterSpacing: 0.5 }}>Stop</Text>
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#ff3366', marginTop: 4 }}>
                {formatTry(stopPrice)}
              </Text>
              {rr !== null ? (
                <Text style={{ fontSize: 10, color: '#9ca3af' }}>R:R {rr.toFixed(1)}</Text>
              ) : null}
            </View>
          </View>
        </View>

        {/* Progress bar */}
        <View style={{ height: 5, backgroundColor: 'rgba(66,70,86,0.3)' }}>
          <View
            style={{
              height: 5,
              width: `${progressPct}%`,
              backgroundColor: progressPct >= 70 ? '#00ff9d' : progressPct >= 40 ? '#FBBF24' : '#ff3366',
            }}
          />
        </View>
      </View>
    </PriceFlash>
  );
}

export const CryptoCard = React.memo(CryptoCardImpl);
