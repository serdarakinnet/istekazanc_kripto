import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Check, Lock, Mail, UserPlus } from 'lucide-react-native';
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
import { clearRememberedLogin, getRememberedLogin, setRememberedLogin } from '../services/secureStore';
import { useAppStore } from '../store/useAppStore';

type Props = NativeStackScreenProps<AuthStackParamList, 'Login'>;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase());
}

export function LoginScreen({ navigation }: Props) {
  const signInWithEmail = useAppStore((s) => s.signInWithEmail);
  const hasApiCredentials = useAppStore((s) => Boolean(s.apiCredentials));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    let mounted = true;
    void (async () => {
      const remembered = await getRememberedLogin();
      if (!mounted) return;
      if (!remembered) return;
      setEmail(remembered.email);
      setPassword(remembered.password);
      setRememberMe(true);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const canSubmit = useMemo(() => {
    return isValidEmail(email) && password.trim().length > 0 && !loading;
  }, [email, password, loading]);

  const onSubmit = async () => {
    try {
      setLoading(true);
      setError(null);
      await signInWithEmail({ email, password });

      if (rememberMe) {
        await setRememberedLogin({ email, password });
      } else {
        await clearRememberedLogin();
      }

      if (!hasApiCredentials) {
        navigation.replace('ApiKeys');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Giriş başarısız.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <View className="absolute inset-0">
        <View className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-neon-cyan/15" />
        <View className="absolute -bottom-24 -right-24 h-80 w-80 rounded-full bg-neon-green/10" />
      </View>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-1 px-6">
          <View className="pt-10">
            <Text className="text-2xl font-semibold text-gray-100">
              Üye Girişi
            </Text>
            <Text className="mt-2 text-sm text-gray-400">
              Premium kantitatif tarama ve auto-trade paneline hoş geldin.
            </Text>
          </View>

          <View className="mt-8 gap-4">
            <View className="rounded-2xl border border-outline-500/35 bg-bg-900/60 px-4 py-3">
              <View className="flex-row items-center gap-3">
                <Mail size={18} color="#9ca3af" />
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="E-mail"
                  placeholderTextColor="#6b7280"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  className="flex-1 text-base text-gray-100"
                  returnKeyType="next"
                />
              </View>
            </View>

            <View className="rounded-2xl border border-outline-500/35 bg-bg-900/60 px-4 py-3">
              <View className="flex-row items-center gap-3">
                <Lock size={18} color="#9ca3af" />
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Şifre"
                  placeholderTextColor="#6b7280"
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  className="flex-1 text-base text-gray-100"
                  returnKeyType="done"
                  onSubmitEditing={onSubmit}
                />
              </View>
            </View>

            <Pressable
              onPress={() => setRememberMe((v) => !v)}
              className="flex-row items-center gap-3"
              accessibilityRole="checkbox"
              accessibilityState={{ checked: rememberMe }}
            >
              <View
                className={[
                  'h-5 w-5 items-center justify-center rounded border',
                  rememberMe ? 'border-neon-cyan bg-neon-cyan/10' : 'border-outline-500/35 bg-bg-900/60',
                ].join(' ')}
              >
                {rememberMe ? <Check size={14} color="#0066ff" /> : null}
              </View>
              <Text className="text-sm text-gray-300">Beni hatırla</Text>
            </Pressable>

            {error ? (
              <View className="rounded-2xl border border-[#2a1b22] bg-[#12090d] px-4 py-3">
                <Text className="text-sm text-neon-red">{error}</Text>
              </View>
            ) : null}
          </View>

          <View className="mt-6">
            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              className={[
                'rounded-2xl px-4 py-4',
                canSubmit ? 'bg-neon-cyan' : 'bg-neon-cyan/20',
              ].join(' ')}
            >
              <Text
                className={[
                  'text-center text-base font-semibold',
                  canSubmit ? 'text-bg-950' : 'text-neon-cyan',
                ].join(' ')}
              >
                {loading ? 'Giriş yapılıyor…' : 'Giriş Yap'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => navigation.navigate('Register')}
              className="mt-3 flex-row items-center justify-center gap-2 rounded-2xl border border-outline-500/35 bg-bg-900/60 px-4 py-4"
            >
              <UserPlus size={16} color="#9ca3af" />
              <Text className="text-center text-sm font-semibold text-gray-200">
                Kayıt Ol
              </Text>
            </Pressable>

            <Text className="mt-3 text-center text-xs text-gray-500">
              Giriş e-mail ile yapılır. Hesabın yoksa kayıt ol.
            </Text>
          </View>

          <View className="flex-1" />

          <View className="pb-6">
            <Text className="text-center text-[11px] text-gray-600">
              Binance TR API anahtarların cihazında şifreli olarak saklanır.
            </Text>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
