import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Eye, EyeOff, KeyRound, LogOut } from 'lucide-react-native';
import * as React from 'react';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AuthStackParamList } from '../navigation/RootNavigator';
import { useAppStore } from '../store/useAppStore';

type Props = NativeStackScreenProps<AuthStackParamList, 'ApiKeys'>;

export function ApiKeySetupScreen({ navigation }: Props) {
  const saveApiCredentials = useAppStore((s) => s.saveApiCredentials);
  const signOut = useAppStore((s) => s.signOut);

  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSave = useMemo(() => {
    return apiKey.trim().length > 0 && apiSecret.trim().length > 0 && !loading;
  }, [apiKey, apiSecret, loading]);

  const onSave = async () => {
    try {
      setLoading(true);
      setError(null);
      await saveApiCredentials({ apiKey, apiSecret });
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Anahtarlar kaydedilemedi.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const onLogout = () => {
    signOut();
    navigation.replace('Login');
  };

  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-1 px-6">
          <View className="flex-row items-start justify-between pt-10">
            <View className="flex-1 pr-4">
              <Text className="text-2xl font-semibold text-gray-100">
                API Anahtarları
              </Text>
              <Text className="mt-2 text-sm text-gray-400">
                Binance TR API Key ve Secret Key bilgilerini güvenli şekilde
                kaydet.
              </Text>
            </View>

            <Pressable
              onPress={onLogout}
              className="rounded-xl border border-[#1c2430] bg-bg-900 p-3"
              accessibilityLabel="Çıkış Yap"
            >
              <LogOut size={18} color="#9ca3af" />
            </Pressable>
          </View>

          <View className="mt-8 gap-4">
            <View className="rounded-2xl border border-[#1c2430] bg-bg-900 px-4 py-3">
              <View className="flex-row items-center gap-3">
                <KeyRound size={18} color="#9ca3af" />
                <TextInput
                  value={apiKey}
                  onChangeText={setApiKey}
                  placeholder="Binance TR API Key"
                  placeholderTextColor="#6b7280"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="flex-1 text-base text-gray-100"
                />
              </View>
            </View>

            <View className="rounded-2xl border border-[#1c2430] bg-bg-900 px-4 py-3">
              <View className="flex-row items-center gap-3">
                <KeyRound size={18} color="#9ca3af" />
                <TextInput
                  value={apiSecret}
                  onChangeText={setApiSecret}
                  placeholder="Binance TR Secret Key"
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

            <View className="rounded-2xl border border-[#13241b] bg-[#07130d] px-4 py-3">
              <Text className="text-xs leading-5 text-[#00ff88]">
                Güvenlik notu: Anahtarlar SecureStore ile şifrelenir. Uygulama bu
                verileri loglamaz.
              </Text>
            </View>

            {error ? (
              <View className="rounded-2xl border border-[#2a1b22] bg-[#12090d] px-4 py-3">
                <Text className="text-sm text-[#ff3b5c]">{error}</Text>
              </View>
            ) : null}
          </View>

          <View className="mt-6">
            <Pressable
              onPress={onSave}
              disabled={!canSave}
              className={[
                'rounded-2xl px-4 py-4',
                canSave ? 'bg-neon-green' : 'bg-[#0f2a1d]',
              ].join(' ')}
            >
              <Text
                className={[
                  'text-center text-base font-semibold',
                  canSave ? 'text-bg-950' : 'text-[#86efac]',
                ].join(' ')}
              >
                {loading ? 'Kaydediliyor…' : 'Kaydet ve Devam Et'}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
