"use client";

export const AUTHORITY_CHANGED = "sho:authority-changed";
export const AUTHORITY_INTERVAL_MS = 10_000;

/** One foreground watcher per authenticated shell, with bounded requests.
 * First observation also invalidates: the screen may predate the first poll.
 * A timeout is not a revocation; existing API handlers remain authoritative.
 */
export function watchAuthority(onChange: () => void) {
  let stopped = false;
  let revision: string | null = null;
  let inFlight: AbortController | null = null;
  async function check() {
    if (stopped || inFlight || document.visibilityState === "hidden") return;
    const controller = new AbortController();
    inFlight = controller;
    const deadline = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch("/api/auth/authority", { cache: "no-store", signal: controller.signal });
      if (stopped || controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        if (revision !== "denied") { revision = "denied"; onChange(); }
        return;
      }
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (stopped || controller.signal.aborted || !body || typeof body !== "object" || !("revision" in body)) return;
      const next = (body as { revision?: unknown }).revision;
      if (typeof next !== "string" || !/^[a-f0-9]{64}$/.test(next)) return;
      if (next !== revision) { revision = next; onChange(); }
    } catch { /* Network trouble is not an access decision. */ }
    finally { clearTimeout(deadline); inFlight = null; }
  }
  const focus = () => { void check(); };
  const timer = setInterval(focus, AUTHORITY_INTERVAL_MS);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", focus);
  focus();
  return () => {
    stopped = true; clearInterval(timer); inFlight?.abort();
    window.removeEventListener("focus", focus);
    document.removeEventListener("visibilitychange", focus);
  };
}
