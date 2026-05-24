import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { FileText, LayoutGrid, User } from 'lucide-react-native';
import * as React from 'react';
import { Text, View } from 'react-native';

import { ApiKeySetupScreen } from '../screens/ApiKeySetupScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { RegisterScreen } from '../screens/RegisterScreen';
import { ReportsScreen } from '../screens/ReportsScreen';
import { selectAppReady, selectAuthPhase, useAppStore } from '../store/useAppStore';

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
  ApiKeys: undefined;
};

export type AppTabParamList = {
  Dashboard: undefined;
  Reports: undefined;
  Profile: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tabs = createBottomTabNavigator<AppTabParamList>();

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#0b1326',
    card: '#171f33',
    border: '#424656',
    text: '#dae2fd',
    primary: '#0066ff',
  },
};

function AuthStackNavigator({
  initialRouteName,
}: {
  initialRouteName: keyof AuthStackParamList;
}) {
  return (
    <AuthStack.Navigator
      initialRouteName={initialRouteName}
      screenOptions={{
        headerShown: false,
        animation: 'fade',
        contentStyle: { backgroundColor: '#05070a' },
      }}
    >
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Register" component={RegisterScreen} />
      <AuthStack.Screen name="ApiKeys" component={ApiKeySetupScreen} />
    </AuthStack.Navigator>
  );
}

function AppTabsNavigator() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          left: 16,
          right: 16,
          bottom: 12,
          height: 64,
          paddingBottom: 8,
          paddingTop: 8,
          borderTopWidth: 0,
          borderWidth: 1,
          borderColor: 'rgba(66, 70, 86, 0.35)',
          borderRadius: 18,
          backgroundColor: 'rgba(23, 31, 51, 0.85)',
        },
        tabBarActiveTintColor: '#0066ff',
        tabBarInactiveTintColor: '#8c90a1',
      }}
    >
      <Tabs.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => (
            <LayoutGrid color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="Reports"
        component={ReportsScreen}
        options={{
          title: 'Raporlar',
          tabBarIcon: ({ color, size }) => (
            <FileText color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          title: 'Profil',
          tabBarIcon: ({ color, size }) => <User color={color} size={size} />,
        }}
      />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const appReady = useAppStore((s) =>
    selectAppReady({ hasLocalHydrated: s.hasLocalHydrated, hasSecureHydrated: s.hasSecureHydrated }),
  );
  const authPhase = useAppStore((s) =>
    selectAuthPhase({ isSignedIn: s.isSignedIn, apiCredentials: s.apiCredentials }),
  );

  if (!appReady) {
    return (
      <View className="flex-1 items-center justify-center bg-bg-950">
        <Text className="text-sm text-gray-400">Yükleniyor…</Text>
      </View>
    );
  }

  const initialAuthRoute: keyof AuthStackParamList =
    authPhase === 'needsApiCredentials' ? 'ApiKeys' : 'Login';

  return (
    <NavigationContainer theme={navTheme}>
      {authPhase === 'ready' ? (
        <AppTabsNavigator />
      ) : (
        <AuthStackNavigator initialRouteName={initialAuthRoute} />
      )}
    </NavigationContainer>
  );
}
