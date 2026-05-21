import './global.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RootNavigator } from './src/navigation/RootNavigator';
import { runBotCycle } from './src/services/botController';
import { initUserDb } from './src/services/userDb';
import { useAppStore } from './src/store/useAppStore';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
    },
  },
});

function BotSupervisor() {
  const autoTradeEnabled = useAppStore((s) => s.settings.autoTradeEnabled);

  useEffect(() => {
    if (!autoTradeEnabled) return;

    let mounted = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;

    const tick = async () => {
      if (!mounted) return;
      if (busy) return;
      busy = true;
      try {
        await runBotCycle();
      } finally {
        busy = false;
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        tick();
      }, 5000);
      tick();
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });

    start();

    return () => {
      mounted = false;
      stop();
      sub.remove();
    };
  }, [autoTradeEnabled]);

  return null;
}

export default function App() {
  const hydrateSecure = useAppStore((s) => s.hydrateSecure);

  useEffect(() => {
    initUserDb();
    hydrateSecure();
  }, [hydrateSecure]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <BotSupervisor />
          <RootNavigator />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
