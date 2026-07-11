import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { registerPushToken } from './api';
import { navigationRef } from './navigation';

// Show pushes even while the app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Ask permission, fetch the Expo push token and register it with the active
// vault. Safe to call repeatedly (login, vault switch, app start) — the server
// upserts by token. Returns the token or null (denied / simulator / error).
export async function registerForPush() {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== 'granted') return null;
    const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await registerPushToken(token);
    return token;
  } catch (e) {
    console.log('[FV] push registration failed:', e?.message || e);
    return null;
  }
}

// Tapping a push routes to the relevant tab. Returns the unsubscribe fn.
export function listenForPushTaps() {
  let cancelled = false;

  const routeTo = (resp, attempts = 0) => {
    if (cancelled) return;
    const data = resp?.notification?.request?.content?.data || {};
    if (!data.type) return;
    if (!navigationRef.isReady()) {
      // Cold start: navigation mounts after the tap lands — retry briefly
      if (attempts < 12) setTimeout(() => routeTo(resp, attempts + 1), 400);
      return;
    }
    if (data.type === 'message') {
      navigationRef.navigate('Main', { screen: 'Messages' });
    } else {
      navigationRef.navigate('Main', { screen: 'Feed', params: { screen: 'Notifications' } });
    }
  };

  const sub = Notifications.addNotificationResponseReceivedListener(routeTo);
  // The tap that launched the app fires before this listener attaches
  Notifications.getLastNotificationResponseAsync?.()
    .then((resp) => { if (resp) routeTo(resp); })
    .catch(() => {});

  return () => { cancelled = true; sub.remove(); };
}
