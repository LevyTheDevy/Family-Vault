import React, { createContext, useContext, useState } from 'react';

const UnreadContext = createContext(null);
export const useUnread = () => useContext(UnreadContext);

export function UnreadProvider({ children }) {
  const [totalUnread, setTotalUnread] = useState(0);

  const updateFromConversations = (conversations) => {
    const total = conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    setTotalUnread(total);
  };

  return (
    <UnreadContext.Provider value={{ totalUnread, updateFromConversations }}>
      {children}
    </UnreadContext.Provider>
  );
}
