/** Task-only history metadata. Draft text never goes into history or browser storage. */
const ENTRY = "__shoTaskSheet";
const BASE = "__shoTaskBase";
type Entry = { v: 1; token: string; id: string; href: string; base: string };
const stateObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
function cleanState() { const state = stateObject(history.state); delete state[ENTRY]; delete state[BASE]; return state; }
function readEntry(value: unknown, id: string): Entry | null {
  const raw = stateObject(value)[ENTRY];
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<Entry>;
  return e.v === 1 && e.id === id && typeof e.token === "string" && typeof e.href === "string" && typeof e.base === "string" ? e as Entry : null;
}
function urls(id: string) {
  const here = new URL(location.href);
  if (here.searchParams.get("task") !== id) return null;
  const base = new URL(here); base.searchParams.delete("task");
  return { here: here.href, base: base.href };
}
function sameBackground(a: string, b: string) {
  try { const x = new URL(a), y = new URL(b); x.hash = ""; y.hash = ""; return x.href === y.href; } catch { return false; }
}

/** Same-page query navigation uses Next's supported history integration. */
export function openTaskSheet(href: string): boolean {
  if (typeof window === "undefined") return false;
  const target = new URL(href, location.href), base = new URL(location.href);
  const id = target.searchParams.get("task");
  if (!id || target.origin !== base.origin || target.pathname !== base.pathname || base.searchParams.has("task")) return false;
  const token = crypto.randomUUID();
  History.prototype.replaceState.call(history, { ...cleanState(), [BASE]: token }, "", base.href);
  const entry: Entry = { v: 1, token, id, href: target.href, base: base.href };
  // Next can synchronously mount URL observers before its pushState wrapper writes the URL.
  // Write the one native entry first, then notify the router via its public replaceState integration.
  // Pass only our metadata to that wrapper: copied Next internals would bypass its observer update.
  History.prototype.pushState.call(history, { ...cleanState(), [ENTRY]: entry }, "", target.href);
  history.replaceState({ [ENTRY]: entry }, "", target.href);
  return true;
}

/** A direct link gets one background entry; reloading an already marked entry adds nothing. */
function ensureEntry(id: string): Entry | null {
  const url = urls(id); if (!url) return null;
  const existing = readEntry(history.state, id);
  if (existing?.href === url.here && sameBackground(existing.base, url.base)) return existing;
  const entry: Entry = { v: 1, token: crypto.randomUUID(), id, href: url.here, base: url.base };
  const opaque = cleanState();
  // This atomic pair ends at the same URL, so the router needs no intermediate background render.
  // Preserve its opaque state without depending on any private Next field names.
  History.prototype.replaceState.call(history, { ...opaque, [BASE]: entry.token }, "", entry.base);
  History.prototype.pushState.call(history, { ...opaque, [ENTRY]: entry }, "", entry.href);
  return entry;
}

export type TaskBackOptions = {
  id: string; blocked: () => boolean; beforePrompt: () => void; prompt: () => void;
  nestedClose: () => (() => void) | null;
};

/** Protect a single real Back traversal; Forward restores the same entry before a draft prompt. */
export function attachTaskSheetBack(options: TaskBackOptions) {
  const entry = ensureEntry(options.id);
  if (!entry) return { close: () => false, detach: () => {} };
  let restoring: (() => void) | null = null, allowClose = false, queuedClose = false;
  const close = () => {
    if (restoring) { queuedClose = true; return true; }
    if (allowClose) return true; // a second tap must not queue another Back before the first pop arrives
    if (readEntry(history.state, entry.id)?.token !== entry.token || location.href !== entry.href) return false;
    allowClose = true; history.back(); return true;
  };
  const pop = (event: PopStateEvent) => {
    if (restoring && readEntry(event.state, entry.id)?.token === entry.token) {
      event.stopImmediatePropagation();
      const resumed = restoring; restoring = null;
      if (queuedClose) { queuedClose = false; close(); } else resumed();
      return;
    }
    if (stateObject(event.state)[BASE] !== entry.token) return;
    if (allowClose) { allowClose = false; return; }
    const nested = options.nestedClose();
    if (!nested && !options.blocked()) return;
    event.stopImmediatePropagation();
    if (!nested) options.beforePrompt();
    restoring = nested ?? options.prompt;
    history.forward();
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (!options.blocked()) return;
    event.preventDefault(); event.returnValue = "";
  };
  window.addEventListener("popstate", pop, true);
  window.addEventListener("beforeunload", unload);
  return { close, detach: () => { window.removeEventListener("popstate", pop, true); window.removeEventListener("beforeunload", unload); } };
}
