import * as React from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
export function RegisterScreen() {
  return (
    <SafeAreaView className="flex-1 bg-bg-950">
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-base font-semibold text-gray-100">Kayıt ekranı erişime kapatıldı</Text>
        <Text className="mt-2 text-center text-sm text-gray-400">
          Bu sürümde sadece Dashboard ve Raporlar sayfaları aktiftir.
        </Text>
      </View>
    </SafeAreaView>
  );
}

