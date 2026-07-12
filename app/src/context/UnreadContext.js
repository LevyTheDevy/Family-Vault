import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { fetchNotifSummary, setGifEnabled } from '../utils/api';
import { useVault } from './VaultContext';

const POLL_MS = 20_000;

const UnreadContext = createContext(null);
export const useUnread = () => useContext(UnreadContext);

export function UnreadProvider({ children }) {
  const { ready, vaults, activeIndex } = useVault();
  const [totalUnread, setTotalUnread] = useState(0);
  const [unseenNotifs, setUnseenNotifs] = useState(0);
  const inflightRef = useRef(false);

  // Single source of truth for both badges (Messages tab + bell). Screens call
  // refresh() right after an action that changes counts (e.g. reading a chat)
  // instead of waiting for the next poll.
  const refresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const s = await fetchNotifSummary();
      setTotalUnread(s.unreadMessages || 0);
      setUnseenNotifs(s.unseenNotifications || 0);
      setGifEnabled(s.gifEnabled);
    } catch {} // old server / offline — keep last known counts
    finally { inflightRef.current = false; }
  }, []);

  useEffect(() => {
    if (!ready || vaults.length === 0) return;
    refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') refresh();
    }, POLL_MS);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') refresh();
    });
    return () => { clearInterval(timer); sub.remove(); };
  }, [ready, vaults.length, activeIndex, refresh]);

  // Kept for screens that already have a fresh conversation list in hand
  const updateFromConversations = (conversations) => {
    const total = conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    setTotalUnread(total);
  };

  return (
    <UnreadContext.Provider value={{ totalUnread, unseenNotifs, refresh, updateFromConversations }}>
      {children}
    </UnreadContext.Provider>
  );
}
