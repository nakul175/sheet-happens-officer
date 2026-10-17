"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useGet } from "@/components/api";
import { QuickAdd, type Target } from "./QuickAdd";
import "./extras.css";

type Ctx = { canAdd: boolean; openAdd: () => void };
const X = createContext<Ctx>({ canAdd: false, openAdd: () => {} });
export const useExtras = () => useContext(X);

/** True when a key press belongs to a field, so single-key shortcuts must not fire (SHO-US-14.5 AC5, 14.6 AC3). */
export function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return !!el.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox']");
}

/** Shared by the shortcuts: no modifier, nobody typing, and no dialog open on top. */
export function plainKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  if (isTyping(e.target)) return false;
  if (document.querySelector("[aria-modal='true']")) return false;
  return true;
}

type Targets = { projects: Target[]; lastProjectId: string | null };

export function Extras({ children }: { children: React.ReactNode }) {
  const t = useGet<Targets>("/api/quick-add");
  const [dialog, setDialog] = useState<"add" | null>(null);
  const [fresh, setFresh] = useState(0);
  const projects = t.data?.projects ?? [];
  const canAdd = projects.length > 0;
  const { reload } = t;

  const openAdd = useCallback(() => { if (canAdd) setDialog("add"); }, [canAdd]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "c" && !e.shiftKey && plainKey(e) && canAdd) { e.preventDefault(); setDialog("add"); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [canAdd]);

  // The next open should default to the project just used.
  useEffect(() => {
    const on = () => { setFresh((n) => n + 1); reload(); };
    window.addEventListener("sho:task-added", on);
    return () => window.removeEventListener("sho:task-added", on);
  }, [reload]);

  const value = useMemo(() => ({ canAdd, openAdd }), [canAdd, openAdd]);
  return (
    <X.Provider value={value}>
      {children}
      {dialog === "add" && <QuickAdd key={fresh} projects={projects} lastId={t.data?.lastProjectId ?? null} onClose={() => setDialog(null)} />}
    </X.Provider>
  );
}

/** The "+ New task" button in the top bar. Absent when the person cannot write anywhere. */
export function NewTaskButton() {
  const { canAdd, openAdd } = useExtras();
  if (!canAdd) return null;
  return <button className="btn sm newtask" onClick={openAdd}>+ New task</button>;
}
