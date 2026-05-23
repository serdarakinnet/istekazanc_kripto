import './global.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { useEffect } from 'react';
import { AppState, Platform, Pressable, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RootNavigator } from './src/navigation/RootNavigator';
import {
  registerBotBackgroundTask,
  runBotCycle,
  unregisterBotBackgroundTask,
} from './src/services/botController';
import { initUserDb } from './src/services/userDb';
import { useAppStore } from './src/store/useAppStore';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
    },
  },
});

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; componentStack?: string }
> {
  state: { error: Error | null; componentStack?: string } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, info: React.ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: '#05070a', padding: 16 }}>
        <Text style={{ color: '#e5e7eb', fontSize: 16, fontWeight: '700' }}>
          Uygulama Hatası
        </Text>
        <Text style={{ color: '#9ca3af', marginTop: 12 }} selectable>
          {this.state.error.message}
        </Text>
        {this.state.error.stack ? (
          <Text style={{ color: '#6b7280', marginTop: 12 }} selectable>
            {this.state.error.stack}
          </Text>
        ) : null}
        {this.state.componentStack ? (
          <Text style={{ color: '#6b7280', marginTop: 12 }} selectable>
            {this.state.componentStack}
          </Text>
        ) : null}
        <Pressable
          onPress={() => {
            if (Platform.OS === 'web' && typeof globalThis.location?.reload === 'function') {
              globalThis.location.reload();
            }
          }}
          style={{
            marginTop: 16,
            alignSelf: 'flex-start',
            borderWidth: 1,
            borderColor: '#1c2430',
            backgroundColor: '#0b0f14',
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 12,
          }}
        >
          <Text style={{ color: '#e5e7eb', fontWeight: '600' }}>Yenile</Text>
        </Pressable>
      </View>
    );
  }
}

function BotSupervisor() {
  const autoTradeEnabled = useAppStore((s) => s.settings.autoTradeEnabled);

  useEffect(() => {
    if (!autoTradeEnabled) {
      unregisterBotBackgroundTask();
      return;
    }

    registerBotBackgroundTask();

    let mounted = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;

    const tick = async () => {
      if (!mounted) return;
      if (busy) return;
      busy = true;
      try {
        await runBotCycle();
      } catch {
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
  const [globalError, setGlobalError] = React.useState<{ message: string; stack?: string } | null>(
    null,
  );

  useEffect(() => {
    initUserDb();
    hydrateSecure();
  }, [hydrateSecure]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const onError = (event: ErrorEvent) => {
      const err = event.error instanceof Error ? event.error : null;
      const message = err?.message ?? event.message;
      setGlobalError({ message, stack: err?.stack });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const err = reason instanceof Error ? reason : null;
      setGlobalError({ message: err?.message ?? String(reason), stack: err?.stack });
    };

    globalThis.addEventListener?.('error', onError as unknown as EventListener);
    globalThis.addEventListener?.('unhandledrejection', onRejection as unknown as EventListener);
    return () => {
      globalThis.removeEventListener?.('error', onError as unknown as EventListener);
      globalThis.removeEventListener?.('unhandledrejection', onRejection as unknown as EventListener);
    };
  }, []);

  if (globalError) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <View style={{ flex: 1, backgroundColor: '#05070a', padding: 16 }}>
            <Text style={{ color: '#e5e7eb', fontSize: 16, fontWeight: '700' }}>
              Uygulama Hatası
            </Text>
            <Text style={{ color: '#9ca3af', marginTop: 12 }} selectable>
              {globalError.message}
            </Text>
            {globalError.stack ? (
              <Text style={{ color: '#6b7280', marginTop: 12 }} selectable>
                {globalError.stack}
              </Text>
            ) : null}
            <Pressable
              onPress={() => {
                if (typeof globalThis.location?.reload === 'function') {
                  globalThis.location.reload();
                }
              }}
              style={{
                marginTop: 16,
                alignSelf: 'flex-start',
                borderWidth: 1,
                borderColor: '#1c2430',
                backgroundColor: '#0b0f14',
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 12,
              }}
            >
              <Text style={{ color: '#e5e7eb', fontWeight: '600' }}>Yenile</Text>
            </Pressable>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <BotSupervisor />
          <AppErrorBoundary>
            <RootNavigator />
          </AppErrorBoundary>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
