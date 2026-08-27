import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdhocTarget, ConnectionColor } from '../types';

export interface TermTab {
  key: string;
  connectionId?: string;
  adhoc?: AdhocTarget;
  title: string;
  color?: ConnectionColor;
}

interface TabSink {
  sendData: (data: string) => void;
}

interface TabsState {
  tabs: TermTab[];
  activeKey: string | null;
  openTab: (tab: Omit<TermTab, 'key'>) => string;
  closeTab: (key: string) => void;
  setActive: (key: string) => void;
  /** per-tab server resume token, persisted so a remount can re-attach */
  getToken: (key: string) => string | undefined;
  setToken: (key: string, token: string) => void;
  /** broadcast: send keystrokes typed in one tab to every open session */
  broadcast: boolean;
  setBroadcast: (on: boolean) => void;
  registerSink: (key: string, sink: TabSink) => () => void;
  fanoutInput: (fromKey: string, data: string) => void;
}

const TabsContext = createContext<TabsState | null>(null);
let counter = 0;

export function TerminalTabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [broadcast, setBroadcast] = useState(false);
  const tokens = useRef(new Map<string, string>());
  const sinks = useRef(new Map<string, TabSink>());

  const openTab = useCallback<TabsState['openTab']>((tab) => {
    const key = `t${++counter}`;
    setTabs((prev) => [...prev, { ...tab, key }]);
    setActiveKey(key);
    return key;
  }, []);

  const closeTab = useCallback<TabsState['closeTab']>((key) => {
    tokens.current.delete(key);
    sinks.current.delete(key);
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      setActiveKey((cur) => (cur === key ? (next.at(-1)?.key ?? null) : cur));
      return next;
    });
  }, []);

  const getToken = useCallback((key: string) => tokens.current.get(key), []);
  const setToken = useCallback((key: string, token: string) => void tokens.current.set(key, token), []);

  const registerSink = useCallback((key: string, sink: TabSink) => {
    sinks.current.set(key, sink);
    return () => {
      if (sinks.current.get(key) === sink) sinks.current.delete(key);
    };
  }, []);

  const fanoutInput = useCallback((fromKey: string, data: string) => {
    for (const [key, sink] of sinks.current) {
      if (key !== fromKey) sink.sendData(data);
    }
  }, []);

  const value = useMemo(
    () => ({
      tabs,
      activeKey,
      openTab,
      closeTab,
      setActive: setActiveKey,
      getToken,
      setToken,
      broadcast,
      setBroadcast,
      registerSink,
      fanoutInput,
    }),
    [tabs, activeKey, openTab, closeTab, getToken, setToken, broadcast, registerSink, fanoutInput],
  );
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTerminalTabs(): TabsState {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('useTerminalTabs must be used within TerminalTabsProvider');
  return ctx;
}
