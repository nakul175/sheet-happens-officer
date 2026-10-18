"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { isSignInScreen, sessionSignInTarget } from "@/lib/return-to";

export type Res<T = Record<string, any>> = { ok: boolean; status: number; error?: string; data: T }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Where an expired session lands (APL-2652).
 * `/signin?expired=1` plus the safe return path. No navigation on `/signin` or `/signin/`.
 */
export const sessionNav = {
  toSignIn() {
    const href = sessionSignInTarget(window.location.pathname, window.location.search);
    if (href) window.location.href = href;
  },
};

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
    // APL-2652. A 401 goes to sign-in with expired=1 and the return path, unless that screen is already showing.
    if (res.status === 401 && typeof window !== "undefined" && !isSignInScreen(window.location.pathname)) sessionNav.toSignIn();
    return { ok: res.ok, status: res.status, error, data };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server. Check your connection and try again.", data: {} as T };
  }
}

/** SHO-US-14.2: no answer from the server, or a server fault. Never a statement about the person's access. */
export const isNetworkFailure = (status: number) => status === 0 || status >= 500;
export const COULD_NOT_REACH = "Could not reach the server.";

const responseCode = (data: unknown): string | null => {
  if (!data || typeof data !== "object" || !("code" in data)) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

type Got<T> = { forPath: string | null; req: number; data: T | null; error: string | null; status: number; code: string | null; loading: boolean };

/** GET a path; `reload()` fetches again. Data stays on screen while the same path reloads.
 * A different path reports loading, no error and no data in that same render, so the previous page cannot stick.
 * Pass `{ keepPrevious: true }` to keep the last payload on screen while the new path loads (search). Project pages leave it off.
 * Only the latest request for the current path may paint. A late answer for an older path is ignored.
 * `code` is the error body's code (for example PASSWORD_CHANGE_REQUIRED) and is cleared with the error when the path changes.
 * `failed` is true only once an answer came back as a network failure: status starts at 0, so an in-flight request must never read as one. */
export function useGet<T = Record<string, any>>(path: string | null, opts?: { keepPrevious?: boolean }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const keepPrevious = opts?.keepPrevious === true;
  const [state, setState] = useState<Got<T>>({ forPath: path, req: 0, data: null, error: null, status: 0, code: null, loading: true });
  const [tick, setTick] = useState(0);
  const [seenPath, setSeenPath] = useState(path);
  const [generation, setGeneration] = useState(0);
  const seq = useRef(0);
  // A new path gets a new generation during this render, so the previous answer is not shown.
  let gen = generation;
  if (path !== seenPath) {
    gen = generation + 1;
    setSeenPath(path);
    setGeneration(gen);
  }
  useEffect(() => {
    if (!path) return;
    const mine = ++seq.current;
    const requested = path;
    const stamp = gen;
    api<T>("GET", requested).then((r) => {
      if (mine !== seq.current) return;
      setState((prev) => ({
        forPath: requested,
        req: stamp,
        // A dropped connection on this same request must not wipe what is already on screen or look like a permission problem.
        data: r.ok ? r.data : isNetworkFailure(r.status) ? (prev.forPath === requested && prev.req === stamp ? prev.data : null) : null,
        error: r.ok ? null : isNetworkFailure(r.status) ? COULD_NOT_REACH : r.error ?? "Error",
        status: r.status,
        code: r.ok ? null : responseCode(r.data),
        loading: false,
      }));
    });
  }, [path, tick, gen]);
  const reload = useCallback(() => { setState((p) => (p.data ? p : { ...p, loading: true, error: null })); setTick((n) => n + 1); }, []);
  const fresh = state.forPath === path && state.req === gen;
  // Stale-while-loading is opt-in. The default still hides the previous page the moment the path changes.
  const shown = fresh
    ? state
    : keepPrevious && path !== null && state.data != null
      ? { data: state.data, error: null as string | null, status: 0, code: null as string | null, loading: true }
      : { data: null as T | null, error: null as string | null, status: 0, code: null as string | null, loading: path !== null };
  return { data: shown.data, error: shown.error, status: shown.status, code: shown.code, loading: shown.loading, failed: path !== null && !shown.loading && isNetworkFailure(shown.status), reload };
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
