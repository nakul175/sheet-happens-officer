"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type Res<T = Record<string, any>> = { ok: boolean; status: number; error?: string; data: T }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Call the JSON API. Never throws; network trouble comes back as status 0 with a message. */
export async function api<T = Record<string, any>>(method: string, path: string, body?: unknown): Promise<Res<T>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const undoId = res.headers.get("x-undo-id");
    if (undoId && res.ok && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("sho:undo", { detail: { id: undoId, label: res.headers.get("x-undo-label") ?? "Done", notified: res.headers.get("x-undo-notified") === "1" } }));
    }
    const data = (res.headers.get("content-type")?.includes("json") ? await res.json() : {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const error = res.ok ? undefined : data?.issues?.[0]?.message ?? data?.error ?? "Something went wrong. Try again.";
    if (res.status === 401 && typeof window !== "undefined") window.location.href = "/signin";
    return { ok: res.ok, status: res.status, error, data };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server. Check your connection and try again.", data: {} as T };
  }
}

/** SHO-US-14.2: no answer from the server, or a server fault. Never a statement about the person's access. */
export const isNetworkFailure = (status: number) => status === 0 || status >= 500;
export const COULD_NOT_REACH = "Could not reach the server.";

/** GET a path; `reload()` fetches again. `data` stays on screen while reloading. */
export function useGet<T = Record<string, any>>(path: string | null) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [state, setState] = useState<{ data: T | null; error: string | null; status: number; loading: boolean }>({ data: null, error: null, status: 0, loading: true });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!path) return;
    const mine = ++seq.current;
    api<T>("GET", path).then((r) => {
      if (mine !== seq.current) return;
      // A dropped connection must not wipe what is already on screen or look like a permission problem.
      setState((prev) => ({ data: r.ok ? r.data : isNetworkFailure(r.status) ? prev.data : null, error: r.ok ? null : isNetworkFailure(r.status) ? COULD_NOT_REACH : r.error ?? "Error", status: r.status, loading: false }));
    });
  }, [path, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

export function dueLabel(d: string | null) {
  if (!d) return "No date";
  return new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}
export const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
export const isOverdue = (d: string | null) => !!d && d < todayIST();
/** Date text that also says "Overdue" in words, so colour is not the only signal. */
export const dueState = (d: string | null, done = false) => (!done && isOverdue(d) ? `Overdue · ${dueLabel(d)}` : dueLabel(d));
/** Props that make a clickable row reachable and openable from the keyboard. */
export const rowKeys = (open: () => void) => ({
  tabIndex: 0, role: "link" as const,
  onClick: open,
  onKeyDown: (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } },
});

export const PRIORITY: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };
export const ROLE: Record<string, string> = { LEADER: "Leader", EDITOR: "Editor", VIEWER: "Viewer" };
