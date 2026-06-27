import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, StyleSheet, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useVault } from '../context/VaultContext';
import { useTheme } from '../context/ThemeContext';
import { navigationRef } from '../utils/navigation';

export function VaultSwitcherButton() {
  const { vaults, activeIndex, switchVault } = useVault();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);

  const activeVault = vaults[activeIndex];
  if (!activeVault) return null;

  const label = activeVault.vaultName || 'Vault';

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.border }]}
        hitSlop={{ top: 10, bottom: 10, left: 16, right: 16 }}
      >
        <Text style={[styles.chipText, { color: colors.text }]} numberOfLines={1}>
          {label}
        </Text>
        <Feather name="chevron-down" size={11} color={colors.textSub} />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.backdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setOpen(false)} />
          <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
            <Text style={[styles.sectionLabel, { color: colors.textSub }]}>YOUR VAULTS</Text>

            {vaults.map((v, i) => (
              <TouchableOpacity
                key={i}
                style={[styles.vaultRow, { borderBottomColor: colors.border }]}
                onPress={async () => {
                  setOpen(false);
                  if (i !== activeIndex) await switchVault(i);
                }}
                activeOpacity={0.7}
              >
                <View style={[styles.vaultIcon, { backgroundColor: colors.card }]}>
                  <Text style={[styles.vaultInitial, { color: colors.text }]}>
                    {(v.vaultName || 'V')[0].toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.vaultName, { color: colors.text }]}>
                    {v.vaultName || 'Family Vault'}
                  </Text>
                  <Text style={[styles.vaultMember, { color: colors.textSub }]}>{v.name}</Text>
                </View>
                {i === activeIndex && (
                  <Feather name="check" size={18} color={colors.accent} />
                )}
              </TouchableOpacity>
            ))}

            <TouchableOpacity
              style={[styles.addRow, { borderTopColor: colors.border }]}
              onPress={() => {
                setOpen(false);
                if (navigationRef.isReady()) {
                  navigationRef.navigate('Scan', { addMode: true });
                }
              }}
              activeOpacity={0.7}
            >
              <Feather name="plus-circle" size={16} color={colors.accent} />
              <Text style={[styles.addText, { color: colors.accent }]}>Connect another vault</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

export function NotificationBell() {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={styles.bell}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      onPress={() => {}}
      activeOpacity={0.6}
    >
      <Feather name="bell" size={20} color={colors.text} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: 180,
  },
  chipText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  bell: { marginRight: 14 },

  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    alignSelf: 'center', marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
    paddingHorizontal: 20, marginBottom: 6,
  },
  vaultRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  vaultIcon: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
  },
  vaultInitial: { fontSize: 17, fontWeight: '700' },
  vaultName: { fontSize: 15, fontWeight: '600' },
  vaultMember: { fontSize: 12, marginTop: 2 },
  addRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 4,
  },
  addText: { fontSize: 15, fontWeight: '500' },
});
