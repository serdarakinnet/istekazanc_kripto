import * as React from 'react';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { usePriceHistoryStore } from '../../store/priceHistoryStore';
import { PriceFlash } from './PriceFlash';

export interface CryptoCardProps {
  symbol: string;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  score: number;
  onClose?: () => void;
}

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

function CryptoCardImpl({ symbol, entryPrice, targetPrice, stopPrice, score, onClose }: CryptoCardProps) {
  const upperSymbol = useMemo(() => symbol.toUpperCase(), [symbol]);
  const currentPrice = usePriceHistoryStore((s) => s.currentPrices[upperSymbol] ?? null);

  const pnlPct = useMemo(() => {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return Number.NaN;
    if (currentPrice === null || !Number.isFinite(currentPrice)) return Number.NaN;
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }, [currentPrice, entryPrice]);

  const pnlUp = pnlPct >= 0;

  const badgeBorder =
    score >= 85 ? 'border-neon-green/60' : score >= 70 ? 'border-[#FBBF24]/70' : 'border-outline-500/35';
  const badgeText = score >= 85 ? 'text-neon-green' : score >= 70 ? 'text-[#FBBF24]' : 'text-gray-300';

  const progressPct = useMemo(() => {
    if (currentPrice === null || !Number.isFinite(currentPrice)) return 0;
    if (!Number.isFinite(stopPrice) || !Number.isFinite(targetPrice)) return 0;
    const denom = targetPrice - stopPrice;
    if (!Number.isFinite(denom) || denom === 0) return 0;
    const raw = ((currentPrice - stopPrice) / denom) * 100;
    return clamp(raw, 0, 100);
  }, [currentPrice, stopPrice, targetPrice]);

  const displaySymbol = stripTry(symbol);

  return (
    <PriceFlash
      price={currentPrice}
      style={[
        { marginHorizontal: 16, marginVertical: 8 },
      ]}
    >
      <View className="overflow-hidden rounded-2xl border border-outline-500/35 bg-bg-900/60">
        <View className="p-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-[20px] font-semibold text-gray-100">{displaySymbol}</Text>
            <View className="flex-row items-center gap-2">
              {onClose ? (
                <Pressable
                  onPress={onClose}
                  className="rounded-full border border-neon-red/25 bg-neon-red/10 px-3 py-1"
                >
                  <Text className="text-xs font-semibold text-neon-red">Kapat</Text>
                </Pressable>
              ) : null}
              <View className={['rounded-full border px-3 py-1', badgeBorder].join(' ')}>
                <Text className={['text-xs font-semibold', badgeText].join(' ')}>
                  ⚡ {Math.round(score)}
                </Text>
              </View>
            </View>
          </View>

          <View className="mt-4 flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text className="text-[16px] font-semibold text-gray-100">
                {currentPrice !== null ? formatTry(currentPrice) : '—'}
              </Text>
              <Text
                className={[
                  'mt-1 text-sm font-semibold',
                  pnlUp ? 'text-neon-green' : 'text-neon-red',
                ].join(' ')}
              >
                {pnlUp ? '▲' : '▼'} {formatPct(pnlPct)}
              </Text>
            </View>
          </View>

          <View className="mt-4 flex-row justify-between">
            <View>
              <Text className="text-[11px] text-[#A0AEC0]">Giriş</Text>
              <Text className="mt-1 text-sm font-semibold text-gray-200">
                {formatTry(entryPrice)}
              </Text>
            </View>
            <View>
              <Text className="text-[11px] text-neon-green">Hedef</Text>
              <Text className="mt-1 text-sm font-semibold text-gray-200">
                {formatTry(targetPrice)}
              </Text>
            </View>
            <View>
              <Text className="text-[11px] text-neon-red">Stop</Text>
              <Text className="mt-1 text-sm font-semibold text-gray-200">
                {formatTry(stopPrice)}
              </Text>
            </View>
          </View>
        </View>

        <View className="h-1 bg-outline-500/20">
          <View className="h-1 bg-outline-500/20" style={{ width: `${progressPct}%` }} />
        </View>
      </View>
    </PriceFlash>
  );
}

export const CryptoCard = React.memo(CryptoCardImpl);
