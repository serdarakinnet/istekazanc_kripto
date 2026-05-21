import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Lock, Mail, User as UserIcon } from 'lucide-react-native';
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

type Props = NativeStackScreenProps<AuthStackParamList, 'Register'>;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase());
}

export function RegisterScreen({ navigation }: Props) {
  const signUpWithEmail = useAppStore((s) => s.signUpWithEmail);
  const hasApiCredentials = useAppStore((s) => Boolean(s.apiCredentials));

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => {
    if (loading) return false;
    if (!isValidEmail(email)) return false;
    if (password.trim().length < 6) return false;
    if (password !== confirm) return false;
    return true;
  }, [confirm, email, loading, password]);

  const onSubmit = async () => {
    try {
      setLoading(true);
      setError(null);
      await signUpWithEmail({
        email,
        password,
        displayName: displayName.trim() || undefined,
      });

      if (!hasApiCredentials) {
        navigation.replace('ApiKeys');
      } else {
        navigation.replace('Login');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Kayıt başarısız.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-1 px-6">
          <View className="pt-10">
            <Text className="text-2xl font-semibold text-gray-100">
              Kayıt Ol
            </Text>
            <Text className="mt-2 text-sm text-gray-400">
              E-mail ile hesap oluştur. Şifre min 6 karakter.
            </Text>
          </View>

          <View className="mt-8 gap-4">
            <View className="rounded-2xl border border-[#1c2430] bg-bg-900 px-4 py-3">
              <View className="flex-row items-center gap-3">
                <UserIcon size={18} color="#9ca3af" />
                <TextInput
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder="Ad Soyad (opsiyonel)"
                  placeholderTextColor="#6b7280"
                  autoCapitalize="words"
                  autoCorrect={false}
                  className="flex-1 text-base text-gray-100"
                />
              </View>
            </View>

            <View className="rounded-2xl border border-[#1c2430] bg-bg-900 px-4 py-3">
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

            <View className="rounded-2xl border border-[#1c2430] bg-bg-900 px-4 py-3">
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
                  returnKeyType="next"
                />
              </View>
            </View>

            <View className="rounded-2xl border border-[#1c2430] bg-bg-900 px-4 py-3">
              <View className="flex-row items-center gap-3">
                <Lock size={18} color="#9ca3af" />
                <TextInput
                  value={confirm}
                  onChangeText={setConfirm}
                  placeholder="Şifre tekrar"
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

            {error ? (
              <View className="rounded-2xl border border-[#2a1b22] bg-[#12090d] px-4 py-3">
                <Text className="text-sm text-[#ff3b5c]">{error}</Text>
              </View>
            ) : null}
          </View>

          <View className="mt-6">
            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              className={[
                'rounded-2xl px-4 py-4',
                canSubmit ? 'bg-neon-green' : 'bg-[#0f2a1d]',
              ].join(' ')}
            >
              <Text
                className={[
                  'text-center text-base font-semibold',
                  canSubmit ? 'text-bg-950' : 'text-[#86efac]',
                ].join(' ')}
              >
                {loading ? 'Oluşturuluyor…' : 'Hesap Oluştur'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => navigation.goBack()}
              className="mt-3 rounded-2xl border border-[#1c2430] bg-bg-900 px-4 py-4"
            >
              <Text className="text-center text-sm font-semibold text-gray-200">
                Giriş ekranına dön
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

