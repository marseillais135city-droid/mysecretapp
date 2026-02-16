import { getServerURL } from '@/constants/Config';
import { authFetch, clearAuthCache, ensureRegistered, getMyID } from '@/utils/AuthHelper';
import { preventScreenCapture, allowScreenCapture } from '@/utils/ScreenshotDetector';
import { clearSecureStorageCache, secureGet } from '@/utils/SecureStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import 'react-native-reanimated';

import LockScreen from '@/components/LockScreen';
import * as SecureStore from 'expo-secure-store';
import { Alert, AppState, View } from 'react-native';

const PROFILE_KEY = "my_profile_data_v1";
const APP_LOCK_KEY = "my_app_lock_pin_v1";

import { ThemeProvider as AppThemeProvider, useTheme } from '@/context/ThemeContext';

function RootLayoutContent() {
  const { isDark } = useTheme();
  const router = useRouter();
  const segments = useSegments();
  const [isLocked, setIsLocked] = React.useState(false);
  const [hasPin, setHasPin] = React.useState(false);


  useEffect(() => {
    checkPin();
    checkAutoDelete(); // Check on mount
    applyScreenCapturePolicy(); // Apply screenshot prevention if enabled

    // Ensure server registration and reset timestamp to avoid immediate auto-delete
    ensureRegistered().then(() => {
      SecureStore.setItemAsync("security_last_active_timestamp", Date.now().toString());
    });

    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active') {
        checkAutoDelete(); // Check on resume
      } else if (nextAppState === 'inactive' || nextAppState === 'background') {
        // Lock instantly if PIN is set
        if (hasPin) setIsLocked(true);
        // Record last active time in SecureStore (tamper-resistant)
        SecureStore.setItemAsync("security_last_active_timestamp", Date.now().toString());
      }
    });
    return () => subscription.remove();
  }, [hasPin]);

  const applyScreenCapturePolicy = async () => {
    try {
      const enabled = await SecureStore.getItemAsync("security_screenshot_detection");
      if (enabled === "true") {
        await preventScreenCapture();
      } else {
        await allowScreenCapture();
      }
    } catch (e) {
      console.error("[SECURITY] Screen capture policy failed", e);
    }
  };

  const checkAutoDelete = async () => {
    try {
      // Read delay from SecureStore (tamper-resistant)
      const delayStr = await SecureStore.getItemAsync("security_auto_delete_delay");
      if (!delayStr) return;

      const lastActiveStr = await SecureStore.getItemAsync("security_last_active_timestamp");
      if (!lastActiveStr) {
        await SecureStore.setItemAsync("security_last_active_timestamp", Date.now().toString());
        return;
      }

      const delay = parseInt(delayStr);
      const lastActive = parseInt(lastActiveStr);

      if (isNaN(delay) || isNaN(lastActive)) return;

      if (Date.now() - lastActive > delay) {
        // Notify Server with authenticated request (best-effort)
        try {
          const myID = await getMyID();
          if (myID) {
            const serverURL = await getServerURL();
            await authFetch(`${serverURL}/delete-account`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: myID })
            });
          }
        } catch (e) {
          // Server notification failed but proceed with local wipe anyway
        }

        // Clear caches before wiping
        clearAuthCache();
        clearSecureStorageCache();

        // Wipe everything - local wipe ALWAYS happens regardless of server response
        await AsyncStorage.clear();
        await SecureStore.deleteItemAsync("my_permanent_secret_key_v1");
        await SecureStore.deleteItemAsync("my_app_lock_pin_v1");
        await SecureStore.deleteItemAsync("security_last_active_timestamp");
        await SecureStore.deleteItemAsync("security_auto_delete_delay");
        await SecureStore.deleteItemAsync("ghost_lock_failed_attempts");
        await SecureStore.deleteItemAsync("privacy_read_receipts");
        await SecureStore.deleteItemAsync("privacy_online_status");
        await SecureStore.deleteItemAsync("security_screenshot_detection");
        router.replace('/onboarding');
      } else {
        await SecureStore.setItemAsync("security_last_active_timestamp", Date.now().toString());
      }
    } catch (e) {
      console.error("Auto delete check failed", e);
    }
  };

  useEffect(() => {
    checkProfile();
  }, [segments]);

  const checkPin = async () => {
    const storedValue = await SecureStore.getItemAsync(APP_LOCK_KEY);
    if (storedValue) {
      setHasPin(true);
      setIsLocked(true); // Lock on startup
    } else {
      setHasPin(false);
    }
  };

  const checkProfile = async () => {
    const inAuthGroup = segments[0] === '(tabs)';

    try {
      const profile = await secureGet(PROFILE_KEY);

      if (!profile && inAuthGroup) {
        router.replace('/onboarding');
      } else if (profile && segments[0] === 'onboarding') {
        router.replace('/(tabs)');
      }
    } catch (e) {
      console.error("Profile check failed", e);
    }
  };

  // When locked, ONLY render the lock screen - don't mount the app content at all
  if (isLocked && hasPin) {
    return (
      <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
        <View style={{ flex: 1 }}>
          <LockScreen
            onUnlock={() => setIsLocked(false)}
          />
          <StatusBar style={isDark ? "light" : "dark"} />
        </View>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="contact-details" options={{ presentation: 'modal', title: 'Détails du contact' }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style={isDark ? "light" : "dark"} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <AppThemeProvider>
      <RootLayoutContent />
    </AppThemeProvider>
  );
}
