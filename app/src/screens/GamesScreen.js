import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';

export default function GamesScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Games</Text>
      </View>
      <View style={styles.center}>
        <Text style={styles.placeholder}>Coming soon</Text>
        <Text style={styles.sub}>Family games and activities</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  placeholder: { color: '#333', fontSize: 16, fontWeight: '600' },
  sub: { color: '#2a2a2a', fontSize: 13 },
});
