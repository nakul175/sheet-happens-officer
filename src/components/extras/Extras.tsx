"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useGet } from "@/components/api";
import { Help } from "./Help";
import { listKey } from "./listkeys";
import { Palette, type Command } from "./Palette";
import { QuickAdd, type Target } from "./QuickAdd";
import "./extras.css";

type Ctx = { canAdd: boolean; openAdd: () => void; openPalette: () => void };
const X = createContext<Ctx>({ canAdd: false, openAdd: () => {}, openPalette: () => {} });
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
  const router = useRouter();
  const [dialog, setDialog] = useState<"add" | "palette" | "help" | null>(null);
  const [fresh, setFresh] = useState(0);
  const projects = t.data?.projects ?? [];
  const canAdd = projects.length > 0;
  const { reload } = t;

  const openAdd = useCallback(() => { if (canAdd) setDialog("add"); }, [canAdd]);

  useEffect(() => {
    let g = 0; // time of the last "G", for G then M or P
    const key = (e: KeyboardEvent) => {
      // Ctrl or Cmd+K works anywhere, also inside a field; it toggles.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); setDialog((d) => (d === "palette" ? null : "palette")); return; }
      // Everything below is a single key: never while typing, never with a modifier (those belong to the browser and screen reader), never over a dialog.
      if (e.defaultPrevented || e.repeat || !plainKey(e)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (g && Date.now() - g < 1200) {
        g = 0;
        if (k === "m") { e.preventDefault(); router.push("/"); return; }
        if (k === "p") { e.preventDefault(); router.push("/projects"); return; }
      }
      if (k === "g" && !e.shiftKey) { g = Date.now(); return; }
      if (k === "c" && !e.shiftKey) { if (canAdd) { e.preventDefault(); setDialog("add"); } return; }
      if (k === "/") { e.preventDefault(); setDialog("palette"); return; }
      if (k === "?") { e.preventDefault(); setDialog("help"); return; }
      if (!e.shiftKey && (k === "j" || k === "k" || k === "x" || k === "e")) { if (listKey(k)) e.preventDefault(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [canAdd, router]);

  // The next open should default to the project just used.
  useEffect(() => {
    const on = () => { setFresh((n) => n + 1); reload(); };
    window.addEventListener("sho:task-added", on);
    return () => window.removeEventListener("sho:task-added", on);
  }, [reload]);

  const openPalette = useCallback(() => setDialog("palette"), []);
  const close = useCallback(() => setDialog(null), []);
  const commands = useMemo<Command[]>(() => [
    ...(canAdd ? [{ id: "new-task", label: "New task", hint: "Press C", words: "add create", run: () => setTimeout(() => setDialog("add"), 0) }] : []),
    { id: "new-project", label: "New project", words: "add create", run: () => router.push("/projects/new") },
    { id: "go-my", label: "Go to My tasks", words: "home", run: () => router.push("/") },
    { id: "go-projects", label: "Go to Projects", run: () => router.push("/projects") },
    { id: "go-team", label: "Go to Team", words: "people", run: () => router.push("/team") },
    { id: "go-search", label: "Open the Search screen", run: () => router.push("/search") },
    { id: "help", label: "Keyboard shortcuts", hint: "Press ?", words: "keys help", run: () => setTimeout(() => setDialog("help"), 0) },
  ], [canAdd, router]);
  const value = useMemo(() => ({ canAdd, openAdd, openPalette }), [canAdd, openAdd, openPalette]);
  return (
    <X.Provider value={value}>
      {children}
      {dialog === "add" && <QuickAdd key={fresh} projects={projects} lastId={t.data?.lastProjectId ?? null} onClose={close} />}
      {dialog === "palette" && <Palette commands={commands} onClose={close} />}
      {dialog === "help" && <Help onClose={close} />}
    </X.Provider>
  );
}

/** The "+ New task" button in the top bar. Absent when the person cannot write anywhere. */
export function NewTaskButton() {
  const { canAdd, openAdd } = useExtras();
  if (!canAdd) return null;
  return <button className="btn sm newtask" onClick={openAdd}>+ New task</button>;
}

/** Top-bar entry to the palette; shows the shortcut. Hidden on phones, where the Search tab does the job. */
export function SearchButton() {
  const { openPalette } = useExtras();
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []); // eslint-disable-line react-hooks/set-state-in-effect
  return <button className="searchbtn" onClick={openPalette} aria-label="Search and commands">Search <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd></button>;
}
