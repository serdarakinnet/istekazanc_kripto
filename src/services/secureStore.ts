import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const API_KEY_KEY = 'binance_tr_api_key';
const API_SECRET_KEY = 'binance_tr_api_secret';

export type ApiCredentials = {
  apiKey: string;
  apiSecret: string;
};

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(key);
  }

  const available = await SecureStore.isAvailableAsync();
  if (!available) return null;

  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(key, value);
    return;
  }

  const available = await SecureStore.isAvailableAsync();
  if (!available) {
    throw new Error('SecureStore kullanılamıyor.');
  }

  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
}

async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(key);
    return;
  }

  const available = await SecureStore.isAvailableAsync();
  if (!available) return;

  await SecureStore.deleteItemAsync(key);
}

export async function getApiCredentials(): Promise<ApiCredentials | null> {
  const [apiKey, apiSecret] = await Promise.all([
    getItem(API_KEY_KEY),
    getItem(API_SECRET_KEY),
  ]);

  if (!apiKey || !apiSecret) return null;

  return { apiKey, apiSecret };
}

export async function setApiCredentials(
  credentials: ApiCredentials,
): Promise<void> {
  await Promise.all([
    setItem(API_KEY_KEY, credentials.apiKey),
    setItem(API_SECRET_KEY, credentials.apiSecret),
  ]);
}

export async function clearApiCredentials(): Promise<void> {
  await Promise.all([deleteItem(API_KEY_KEY), deleteItem(API_SECRET_KEY)]);
}
