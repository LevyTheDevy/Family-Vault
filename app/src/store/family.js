import { useState, createContext, useContext } from 'react';

export const FamilyContext = createContext(null);

export function useFamilyStore() {
  return useContext(FamilyContext);
}

export function createFamilyStore() {
  const [vaultUrl, setVaultUrl] = useState(null);
  const [token, setToken] = useState(null);
  const [memberName, setMemberName] = useState(null);
  const [familyKey, setFamilyKey] = useState(null);

  return {
    vaultUrl,
    token,
    memberName,
    familyKey,
    setVault: (url, t, name, key) => {
      setVaultUrl(url);
      setToken(t);
      setMemberName(name);
      setFamilyKey(key);
    },
  };
}
