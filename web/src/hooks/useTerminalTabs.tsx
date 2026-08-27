import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AdhocTarget, ConnectionColor } from '../types';

export interface TermTab {
  key: string;
  connectionId?: string;
  adhoc?: AdhocTarget;
  title: string;
  color?: ConnectionColor;
}

interface TabsState {
  tabs: TermTab[];
  activeKey: string | null;
  openTab: (tab: Omit<TermTab, 'key'>) => string;
  closeTab: (key: string) => void;
  setActive: (key: string) => void;
}

const TabsContext = createContext<TabsState | null>(null);
let counter = 0;

export function TerminalTabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const openTab = useCallback<TabsState['openTab']>((tab) => {
    // Always open a fresh session — even a second one to the same host.
    const key = `t${++counter}`;
    setTabs((prev) => [...prev, { ...tab, key }]);
    setActiveKey(key);
    return key;
  }, []);

  const closeTab = useCallback<TabsState['closeTab']>((key) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      setActiveKey((cur) => (cur === key ? (next.at(-1)?.key ?? null) : cur));
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ tabs, activeKey, openTab, closeTab, setActive: setActiveKey }),
    [tabs, activeKey, openTab, closeTab],
  );
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTerminalTabs(): TabsState {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('useTerminalTabs must be used within TerminalTabsProvider');
  return ctx;
}
