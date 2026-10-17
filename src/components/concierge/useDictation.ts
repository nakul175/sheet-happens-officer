"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/* Minimal typings: SpeechRecognition is not in the TypeScript DOM lib. */
type Rec = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecCtor = new () => Rec;

export const DICTATION_LANG = "en-IN";
export const DICTATION_LIMIT_MS = 60_000;

function ctor(): RecCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Browser dictation, English (India). Stops after 60 s or on silence; cancel discards; never sends. */
export function useDictation(onText: (t: string) => void) {
  const supported = useSyncExternalStore(() => () => {}, () => !!ctor(), () => false);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<Rec | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const text = useRef("");
  const cancelled = useRef(false);
  const cb = useRef(onText);
  useEffect(() => { cb.current = onText; });

  const finish = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null; rec.current = null;
    setListening(false);
    if (!cancelled.current && text.current.trim()) cb.current(text.current.trim());
    text.current = "";
  }, []);

  const start = useCallback(() => {
    const R = ctor();
    if (!R || rec.current) return;
    setProblem(null); cancelled.current = false; text.current = "";
    const r = new R();
    r.lang = DICTATION_LANG; r.continuous = false; r.interimResults = true;
    r.onresult = (e) => {
      let s = "";
      for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
      text.current = s;
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        cancelled.current = true;
        setProblem("The microphone is blocked. Allow microphone access for this site in your browser settings, then try again.");
      } else if (e.error === "network") {
        setProblem("Your browser's speech service could not be reached. You can still type.");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        setProblem("Dictation did not work. You can still type.");
      }
    };
    r.onend = finish;
    rec.current = r;
    try { r.start(); setListening(true); } catch { rec.current = null; setProblem("Dictation did not start. You can still type."); return; }
    timer.current = setTimeout(() => rec.current?.stop(), DICTATION_LIMIT_MS);
  }, [finish]);

  const stop = useCallback(() => rec.current?.stop(), []);
  const cancel = useCallback(() => { cancelled.current = true; text.current = ""; rec.current?.abort(); }, []);
  useEffect(() => () => { cancelled.current = true; if (timer.current) clearTimeout(timer.current); rec.current?.abort(); }, []);

  return { supported, listening, problem, clearProblem: () => setProblem(null), start, stop, cancel };
}
