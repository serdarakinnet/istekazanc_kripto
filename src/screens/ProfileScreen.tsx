import * as React from 'react';
import { Eye, EyeOff, KeyRound, Minus, Plus, Shield, ToggleLeft, ToggleRight } from 'lucide-react-native';
import { Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  registerBotBackgroundTask,
  runInitialScanAndSetPositions,
  unregisterBotBackgroundTask,
} from '../services/botController';
import { useAppStore } from '../store/useAppStore';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maskKey(key: string): string {
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function ProfileScreen() {
  const user = useAppStore((s) => s.user);
  const signOut = useAppStore((s) => s.signOut);
  const apiCredentials = useAppStore((s) => s.apiCredentials);
  const saveApiCredentials = useAppStore((s) => s.saveApiCredentials);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const minRiskReward = React.useMemo(() => {
    const raw = settings.minRiskReward;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 1.5;
  }, [settings.minRiskReward]);

  const [apiKey, setApiKey] = React.useState('');
  const [apiSecret, setApiSecret] = React.useState('');
  const [showSecret, setShowSecret] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <View className="absolute inset-0" pointerEvents="none">
        <View className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-neon-cyan/10" />
        <View className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-neon-green/5" />
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
        <View className="px-6 pt-6">
          <Text className="text-2xl font-semibold text-gray-100">Profil</Text>
          <Text className="mt-2 text-sm text-gray-400">
            E-mail: {user?.email ?? '—'}
          </Text>

          <View className="mt-8 rounded-2xl border border-outline-500/35 bg-bg-900/60 p-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <Shield size={16} color="#9ca3af" />
                <Text className="text-sm font-semibold text-gray-200">
                  Bot Ayarları
                </Text>
              </View>
              <View className="flex-row items-center gap-2">
                {settings.autoTradeEnabled ? (
                  <ToggleRight size={18} color="#05e777" />
                ) : (
                  <ToggleLeft size={18} color="#9ca3af" />
                )}
                <Switch
                  value={settings.autoTradeEnabled}
                  onValueChange={(enabled) => {
                    setError(null);
                    if (enabled && !apiCredentials) {
                      updateSettings({ autoTradeEnabled: false });
                      setError('Önce Binance TR API Key ve Secret Key kaydet.');
                      return;
                    }
                    updateSettings({ autoTradeEnabled: enabled });
                    void (async () => {
                      try {
                        if (enabled) {
                          await runInitialScanAndSetPositions();
                          await registerBotBackgroundTask();
                        } else {
                          await unregisterBotBackgroundTask();
                        }
                      } catch (e) {
                        const message =
                          e instanceof Error ? e.message : 'İşlem başarısız.';
                        setError(message);
                      }
                    })();
                  }}
                />
              </View>
            </View>

            <View className="mt-4 rounded-2xl border border-outline-500/35 bg-bg-950/40 p-4">
              <Text className="text-xs text-gray-500">Min Risk/Reward</Text>
              <View className="mt-2 flex-row items-center justify-between">
                <Pressable
                  onPress={() => {
                    const next = clamp(Number((minRiskReward - 0.1).toFixed(2)), 1.5, 5);
                    updateSettings({ minRiskReward: next });
                  }}
                  className="rounded-xl border border-outline-500/35 bg-bg-900/60 p-3"
                >
                  <Minus size={16} color="#9ca3af" />
                </Pressable>

                <Text className="text-base font-semibold text-gray-100">
                  {Number.isFinite(minRiskReward) ? minRiskReward.toFixed(2) : '—'}
                </Text>

                <Pressable
                  onPress={() => {
                    const next = clamp(Number((minRiskReward + 0.1).toFixed(2)), 1.5, 5);
                    updateSettings({ minRiskReward: next });
                  }}
                  className="rounded-xl border border-outline-500/35 bg-bg-900/60 p-3"
                >
                  <Plus size={16} color="#9ca3af" />
                </Pressable>
              </View>
            </View>
          </View>

          <View className="mt-6 rounded-2xl border border-outline-500/35 bg-bg-900/60 p-4">
            <View className="flex-row items-center gap-2">
              <KeyRound size={16} color="#9ca3af" />
              <Text className="text-sm font-semibold text-gray-200">
                Binance TR API
              </Text>
            </View>

            <Text className="mt-2 text-xs text-gray-500">
              Kayıtlı: {apiCredentials ? maskKey(apiCredentials.apiKey) : 'Yok'}
            </Text>

            <View className="mt-4 gap-3">
              <View className="rounded-2xl border border-outline-500/35 bg-bg-950/40 px-4 py-3">
                <TextInput
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder="Yeni API Key"
                  placeholderTextColor="#6b7280"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="text-base text-gray-100"
                />
              </View>

              <View className="rounded-2xl border border-outline-500/35 bg-bg-950/40 px-4 py-3">
                <View className="flex-row items-center gap-3">
                  <TextInput
                    value={apiSecret}
                    onChangeText={setApiSecret}
                    placeholder="Yeni Secret Key"
                    placeholderTextColor="#6b7280"
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={!showSecret}
                    className="flex-1 text-base text-gray-100"
                  />
                  <Pressable
                    onPress={() => setShowSecret((s) => !s)}
                    className="p-1"
                    accessibilityLabel={
                      showSecret ? 'Secret gizle' : 'Secret göster'
                    }
                  >
                    {showSecret ? (
                      <EyeOff size={18} color="#9ca3af" />
                    ) : (
                      <Eye size={18} color="#9ca3af" />
                    )}
                  </Pressable>
                </View>
              </View>

              {error ? (
                <View className="rounded-2xl border border-[#2a1b22] bg-[#12090d] px-4 py-3">
                  <Text className="text-sm text-neon-red">{error}</Text>
                </View>
              ) : null}

              <Pressable
                onPress={async () => {
                  try {
                    setSaving(true);
                    setError(null);
                    await saveApiCredentials({ apiKey, apiSecret });
                    setApiKey('');
                    setApiSecret('');
                  } catch (e) {
                    const message =
                      e instanceof Error ? e.message : 'Güncelleme başarısız.';
                    setError(message);
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving || apiKey.trim().length === 0 || apiSecret.trim().length === 0}
                className={[
                  'rounded-2xl px-4 py-4',
                  saving || apiKey.trim().length === 0 || apiSecret.trim().length === 0
                    ? 'bg-neon-cyan/20'
                    : 'bg-neon-cyan',
                ].join(' ')}
              >
                <Text
                  className={[
                    'text-center text-base font-semibold',
                    saving || apiKey.trim().length === 0 || apiSecret.trim().length === 0
                      ? 'text-neon-cyan'
                      : 'text-bg-950',
                  ].join(' ')}
                >
                  {saving ? 'Kaydediliyor…' : 'API Key Güncelle'}
                </Text>
              </Pressable>
            </View>
          </View>

          <Pressable
            onPress={signOut}
            className="mt-6 rounded-2xl border border-neon-red/25 bg-neon-red/10 px-4 py-4"
          >
            <Text className="text-center text-sm font-semibold text-neon-red">
              Çıkış Yap
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
