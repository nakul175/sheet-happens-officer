"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { conciergeApi } from "./api";
import { freshMessages, mergeMessages, patchCard } from "./logic";
import type { Disabled, Message, QuickActionId, State } from "./types";
import "./concierge.css";

type Ctx = {
  loaded: boolean;
  loadError: string | null;
  available: boolean;
  disabled?: Disabled;
  hidden: boolean;
  voiceNoticeAcked: boolean;
  quickActions: State["quickActions"];
  messages: Message[];
  busy: boolean; // a request is in flight
  error: string | null;
  draft: string;
  setDraft: (s: string) => void;
  dismissError: () => void;
  retryLoad: () => void;
  send: (text: string) => Promise<boolean>;
  quick: (id: QuickActionId) => Promise<void>;
  choose: (m: Message, choiceId: string) => Promise<void>;
  confirm: (cardId: string, handover?: { taskId: string; assigneeId: string }[]) => Promise<void>;
  cancel: (cardId: string) => Promise<void>;
  undo: (cardId: string) => Promise<void>;
  clearChat: () => Promise<string | null>;
  improve: (text: string) => Promise<string | null>;
  setHidden: (h: boolean) => Promise<void>;
  ackVoice: () => Promise<void>;
};

const C = createContext<Ctx | null>(null);
export const useConcierge = () => useContext(C);

/** Holds the one thread for the whole app shell so it carries on across screens and placements. */
export function ConciergeProvider({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [disabled, setDisabled] = useState<Disabled | undefined>();
  const [hidden, setHiddenState] = useState(false);
  const [voiceNoticeAcked, setVoice] = useState(true); // assume acked until told otherwise, so the mic never starts unannounced
  const [quickActions, setQuick] = useState<State["quickActions"]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [tick, setTick] = useState(0);
  const tmp = useRef(0);

  useEffect(() => {
    let live = true;
    conciergeApi.state().then((r) => {
      if (!live) return;
      if (!r.ok) { setLoadError(r.error ?? "The concierge could not be loaded."); setLoaded(true); return; }
      const s = r.data;
      setAvailable(s.available); setDisabled(s.disabled); setHiddenState(s.hidden); setVoice(s.voiceNoticeAcked);
      setQuick(s.quickActions ?? []); setMessages(s.messages ?? []); setLoadError(null); setLoaded(true);
    });
    return () => { live = false; };
  }, [tick]);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setBusy(true); setError(null);
    try { return await fn(); } finally { setBusy(false); }
  }, []);

  const add = useCallback((incoming: Message[]) => setMessages((l) => mergeMessages(l, incoming)), []);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return false;
    const id = `tmp-${++tmp.current}`;
    setMessages((l) => [...l, { id, role: "USER", createdAt: new Date().toISOString(), kind: "text", text: t }]);
    setDraft("");
    return run(async () => {
      const r = await conciergeApi.send(t);
      setMessages((l) => l.filter((m) => m.id !== id));
      if (!r.ok) { setError(r.error ?? "That did not send."); setDraft(t); return false; }
      add(r.data.messages ?? []);
      if (r.data.disabled) setDisabled(r.data.disabled);
      return true;
    });
  }, [run, add]);

  const quick = useCallback(async (qid: QuickActionId) => {
    await run(async () => {
      const r = await conciergeApi.quick(qid);
      if (!r.ok) setError(r.error ?? "That did not work."); else add(r.data.messages ?? []);
    });
  }, [run, add]);

  const choose = useCallback(async (m: Message, choiceId: string) => {
    await run(async () => {
      const r = await conciergeApi.choose(m.id, choiceId);
      if (!r.ok) { setError(r.error ?? "That did not work."); return; }
      setMessages((l) => l.map((x) => (x.id === m.id ? { ...x, choiceAnswered: choiceId } : x)));
      add(r.data.messages ?? []);
    });
  }, [run, add]);

  const confirm = useCallback(async (cardId: string, handover?: { taskId: string; assigneeId: string }[]) => {
    await run(async () => {
      const r = await conciergeApi.confirm(cardId, handover);
      if (r.status === 409) { add(freshMessages(r.data)); setError("That changed since I prepared it, so nothing was written. Check the new card below."); return; }
      if (!r.ok) { setError(r.error ?? "That did not work."); return; }
      if (r.data.card) setMessages((l) => patchCard(l, r.data.card));
      add(r.data.messages ?? []);
    });
  }, [run, add]);

  const cancel = useCallback(async (cardId: string) => {
    await run(async () => {
      const r = await conciergeApi.cancel(cardId);
      if (!r.ok) setError(r.error ?? "That did not work."); else if (r.data.card) setMessages((l) => patchCard(l, r.data.card));
    });
  }, [run]);

  const undo = useCallback(async (cardId: string) => {
    await run(async () => {
      const r = await conciergeApi.undo(cardId);
      if (!r.ok) { setError(r.error ?? "That could not be undone."); return; }
      const now = new Date().toISOString();
      setMessages((l) => l.map((m) => (m.result?.cardId === cardId ? { ...m, result: { ...m.result, undoneAt: m.result.undoneAt ?? now } } : m)));
      add(r.data.messages ?? []);
    });
  }, [run, add]);

  const clearChat = useCallback(async () => {
    return run(async () => {
      const r = await conciergeApi.clear();
      if (!r.ok) return r.error ?? "Could not clear your chat. Try again.";
      setMessages([]); setDraft("");
      return null;
    });
  }, [run]);

  const improve = useCallback(async (text: string) => {
    return run(async () => {
      const r = await conciergeApi.improve(text);
      if (!r.ok) { setError(r.error ?? "Could not improve that. Try again."); return null; }
      return r.data.improved;
    });
  }, [run]);

  const setHidden = useCallback(async (h: boolean) => {
    const prev = hidden;
    setHiddenState(h);
    const r = await conciergeApi.setPrefs({ hidden: h });
    if (!r.ok) { setHiddenState(prev); setError(r.error ?? "Could not save that."); }
  }, [hidden]);

  const ackVoice = useCallback(async () => {
    setVoice(true);
    const r = await conciergeApi.setPrefs({ voiceNoticeAcked: true });
    if (!r.ok) setError(r.error ?? "Could not save that.");
  }, []);

  const value = useMemo<Ctx>(() => ({
    loaded, loadError, available, disabled, hidden, voiceNoticeAcked, quickActions, messages, busy, error, draft, setDraft,
    dismissError: () => setError(null), retryLoad: () => { setLoaded(false); setTick((n) => n + 1); },
    send, quick, choose, confirm, cancel, undo, clearChat, improve, setHidden, ackVoice,
  }), [loaded, loadError, available, disabled, hidden, voiceNoticeAcked, quickActions, messages, busy, error, draft, send, quick, choose, confirm, cancel, undo, clearChat, improve, setHidden, ackVoice]);

  return <C.Provider value={value}>{children}</C.Provider>;
}
