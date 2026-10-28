import { onOverlayPopstate } from "@/lib/overlay-popstate";
const PANEL = "__shoPanel", BASE = "__shoPanelBase";
type PanelEntry = { id: string; token: string; href: string };
const object = (state: unknown): Record<string, unknown> => state && typeof state === "object" && !Array.isArray(state) ? { ...state } : {};
const panel = (state: unknown) => object(state)[PANEL] as PanelEntry | undefined;

/** One same-URL entry per overlay. Keep Next's opaque state; no draft or credential enters history. */
export function attachOverlayBack(id: string, onClose: () => void, nestedClose: () => (() => void) | null = () => null) {
  const current = panel(history.state);
  let entry: PanelEntry;
  if (current?.id === id && current.href === location.href) entry = current;
  else {
    entry = { id, token: crypto.randomUUID(), href: location.href };
    const state = object(history.state); delete state[PANEL]; delete state[BASE];
    // Leave a parent's panel marker in its own base entry, so nested overlays close one at a time.
    History.prototype.replaceState.call(history, { ...object(history.state), [BASE]: entry.token }, "", entry.href);
    History.prototype.pushState.call(history, { ...state, [PANEL]: entry }, "", entry.href);
  }
  let restoring: (() => void) | null = null, closing = false, afterClose: (() => void) | undefined;
  const finish = () => { onClose(); afterClose?.(); };
  const close = (after?: () => void) => {
    if (closing) return;
    if (restoring) { closing = true; afterClose = after; return; }
    if (panel(history.state)?.token !== entry.token || location.href !== entry.href) { onClose(); after?.(); return; }
    closing = true; afterClose = after;
    history.back();
  };
  const pop = (event: PopStateEvent) => {
    if (restoring && panel(event.state)?.token === entry.token) {
      event.stopImmediatePropagation(); const resume = restoring; restoring = null;
      if (closing) history.back(); else resume();
      return;
    }
    if (object(event.state)[BASE] !== entry.token) return;
    event.stopImmediatePropagation();
    const nested = !closing && nestedClose();
    if (nested) { restoring = nested; history.forward(); }
    else finish();
  };
  const detach = onOverlayPopstate(pop);
  return { close, detach };
}
