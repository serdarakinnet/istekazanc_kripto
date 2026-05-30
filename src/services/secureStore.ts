import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const LEGACY_SENSITIVE_KEYS = [
  'binance_tr_api_key',
  'binance_tr_api_secret',
  'bist_login_email',
  'bist_login_password',
] as const;

async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(key);
    return;
  }

  const available = await SecureStore.isAvailableAsync();
  if (!available) return;

  await SecureStore.deleteItemAsync(key);
}

export async function clearLegacySensitiveStorage(): Promise<void> {
  await Promise.all(LEGACY_SENSITIVE_KEYS.map((k) => deleteItem(k)));
}
