import React, { useState, useEffect } from 'react';
import { View, Text, Image, ActivityIndicator, StyleSheet, ImageBackground } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import ScanScreen from './src/screens/ScanScreen';
import AuthScreen from './src/screens/AuthScreen';
import FeedScreen from './src/screens/FeedScreen';
import PostScreen from './src/screens/PostScreen';
import CollectionsScreen from './src/screens/CollectionsScreen';
import CollectionDetailScreen from './src/screens/CollectionDetailScreen';
import OfflineCollectionScreen from './src/screens/OfflineCollectionScreen';
import MessagesScreen from './src/screens/MessagesScreen';
import ChatScreen from './src/screens/ChatScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ThemeScreen from './src/screens/ThemeScreen';
import StoryViewScreen from './src/screens/StoryViewScreen';
import StoryCreateScreen from './src/screens/StoryCreateScreen';

import * as FileSystem from 'expo-file-system/legacy';
import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import { UnreadProvider, useUnread } from './src/context/UnreadContext';
import { ToastProvider } from './src/context/ToastContext';
import { VaultProvider, useVault } from './src/context/VaultContext';
import { VaultSwitcherButton, NotificationBell } from './src/components/VaultSwitcher';
import ResetPasswordScreen from './src/screens/ResetPasswordScreen';
import { navigationRef } from './src/utils/navigation';

const RootStack = createStackNavigator();
const Tab = createBottomTabNavigator();
const FeedStack = createStackNavigator();
const CollectionStack = createStackNavigator();
const MessagesStack = createStackNavigator();
const SettingsStack = createStackNavigator();

function makeHeader(colors) {
  return {
    headerStyle: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: '600', fontSize: 16 },
    cardStyle: { backgroundColor: colors.screenBg },
  };
}

function HeaderLogo() {
  return (
    <Image
      source={require('./assets/logo_app.png')}
      style={styles.headerLogo}
      resizeMode="contain"
    />
  );
}

function FeedStackScreen() {
  const { colors } = useTheme();
  return (
    <FeedStack.Navigator screenOptions={makeHeader(colors)}>
      <FeedStack.Screen
          name="FeedMain"
          component={FeedScreen}
          options={{
            headerLeft: () => <HeaderLogo />,
            headerTitle: () => <VaultSwitcherButton />,
            headerRight: () => <NotificationBell />,
          }}
        />
      <FeedStack.Screen name="Post" component={PostScreen} options={{ title: 'New Post' }} />
      <FeedStack.Screen name="StoryCreate" component={StoryCreateScreen} options={{ headerShown: false }} />
    </FeedStack.Navigator>
  );
}

function CollectionStackScreen() {
  const { colors } = useTheme();
  return (
    <CollectionStack.Navigator screenOptions={makeHeader(colors)}>
      <CollectionStack.Screen name="CollectionList" component={CollectionsScreen} options={{ title: 'Collections', headerLeft: () => <HeaderLogo /> }} />
      <CollectionStack.Screen name="CollectionDetail" component={CollectionDetailScreen} options={{ title: '' }} />
      <CollectionStack.Screen name="OfflineCollection" component={OfflineCollectionScreen} options={{ title: 'Offline' }} />
    </CollectionStack.Navigator>
  );
}

function MessagesStackScreen() {
  const { colors } = useTheme();
  return (
    <MessagesStack.Navigator screenOptions={makeHeader(colors)}>
      <MessagesStack.Screen name="ConversationList" component={MessagesScreen} options={{ title: 'Messages', headerLeft: () => <HeaderLogo /> }} />
      <MessagesStack.Screen name="Chat" component={ChatScreen} options={({ route }) => ({ title: route.params.conversation.name })} />
    </MessagesStack.Navigator>
  );
}

function SettingsStackScreen() {
  const { colors } = useTheme();
  return (
    <SettingsStack.Navigator screenOptions={makeHeader(colors)}>
      <SettingsStack.Screen name="SettingsMain" component={SettingsScreen} options={{ title: 'Settings', headerLeft: () => <HeaderLogo /> }} />
      <SettingsStack.Screen name="Theme" component={ThemeScreen} options={{ title: 'Appearance' }} />
    </SettingsStack.Navigator>
  );
}

function NewPostPlaceholder() {
  const { colors } = useTheme();
  return <View style={{ flex: 1, backgroundColor: colors.screenBg }} />;
}

const TAB_ICONS = { Feed: 'home', Collections: 'grid', Messages: 'message-square', Settings: 'user' };

function MainTabs() {
  const insets = useSafeAreaInsets();
  const { colors, bgImageUri, isLight } = useTheme();
  const { totalUnread } = useUnread();
  const tabBarHeight = 58 + insets.bottom;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: bgImageUri
            ? (isLight ? 'rgba(255,255,255,0.80)' : 'rgba(0,0,0,0.80)')
            : colors.tabBar,
          borderTopColor: colors.tabBorder,
          borderTopWidth: 1,
          height: tabBarHeight,
          paddingBottom: insets.bottom + 4,
          paddingTop: 6,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textSub,
        tabBarLabelStyle: { fontSize: 10 },
        tabBarIcon: ({ color, size }) =>
          TAB_ICONS[route.name]
            ? <Feather name={TAB_ICONS[route.name]} size={size - 2} color={color} />
            : null,
      })}
    >
      <Tab.Screen name="Feed" component={FeedStackScreen} />
      <Tab.Screen name="Collections" component={CollectionStackScreen} />

      <Tab.Screen
        name="NewPost"
        component={NewPostPlaceholder}
        options={{
          tabBarLabel: () => null,
          tabBarIcon: () => (
            <View style={[styles.plusCircle, { backgroundColor: colors.accent }]}>
              <Text style={[styles.plusText, { color: colors.accentText }]}>+</Text>
            </View>
          ),
        }}
        listeners={({ navigation }) => ({
          tabPress: (e) => {
            e.preventDefault();
            navigation.navigate('Feed', { screen: 'Post' });
          },
        })}
      />

      <Tab.Screen
        name="Messages"
        component={MessagesStackScreen}
        options={{
          tabBarBadge: totalUnread > 0 ? (totalUnread > 99 ? '99+' : totalUnread) : undefined,
          tabBarBadgeStyle: { backgroundColor: '#e53935', color: '#fff', fontSize: 10, minWidth: 16, height: 16, borderRadius: 8 },
        }}
      />
      <Tab.Screen name="Settings" component={SettingsStackScreen} />
    </Tab.Navigator>
  );
}

function AppInner() {
  const [initialRoute, setInitialRoute] = useState(null);
  const { colors, bgImageUri, isLight } = useTheme();
  const { vaults, ready } = useVault();

  useEffect(() => {
    if (!ready) return;
    FileSystem.deleteAsync(FileSystem.cacheDirectory + 'fv/', { idempotent: true }).catch(() => {});
    setInitialRoute(vaults.length > 0 ? 'Main' : 'Scan');
  }, [ready]);

  if (!initialRoute) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  const navTheme = {
    dark: !isLight,
    colors: {
      primary: colors.accent,
      background: 'transparent',
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      notification: '#e53935',
    },
  };

  // NavigationContainer always lives in the same View — prevents remount when bgImageUri changes
  const glassColor = isLight ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)';
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {bgImageUri && (
        <>
          <ImageBackground source={{ uri: bgImageUri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
          <View style={[StyleSheet.absoluteFillObject, { backgroundColor: glassColor }]} pointerEvents="none" />
        </>
      )}
      <NavigationContainer ref={navigationRef} theme={navTheme}>
        <RootStack.Navigator initialRouteName={initialRoute} screenOptions={makeHeader(colors)}>
          <RootStack.Screen name="Scan" component={ScanScreen} options={{ headerShown: false }} />
          <RootStack.Screen name="Auth" component={AuthScreen} options={{ headerShown: false }} />
          <RootStack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
          <RootStack.Screen name="ResetPassword" component={ResetPasswordScreen} options={{ headerShown: false }} />
          <RootStack.Screen
            name="StoryView"
            component={StoryViewScreen}
            options={{ headerShown: false, presentation: 'modal' }}
          />
        </RootStack.Navigator>
      </NavigationContainer>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <ThemeProvider>
          <VaultProvider>
            <UnreadProvider>
              <ToastProvider>
                <AppInner />
              </ToastProvider>
            </UnreadProvider>
          </VaultProvider>
        </ThemeProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerLogo: {
    width: 24, height: 24, borderRadius: 6, marginLeft: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18, shadowRadius: 4, elevation: 4,
  },
  plusCircle: {
    width: 50, height: 50, borderRadius: 25,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22, shadowRadius: 5, elevation: 5,
  },
  plusText: { fontSize: 28, fontWeight: '300', lineHeight: 30, marginTop: -2 },
});
