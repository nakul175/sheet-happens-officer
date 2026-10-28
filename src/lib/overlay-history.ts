import { onOverlayPopstate } from "@/lib/overlay-popstate";
const PANEL = "__shoPanel", BASE = "__shoPanelBase";
type PanelEntry = { id: string; token: string; href: string };
type ActiveOverlay = { close: (after?: () => void) => void };
const activeOverlays: ActiveOverlay[] = [];
/** Finish an outgoing menu's real Back traversal before opening another overlay. */
export function closeTopOverlayThen(after: () => void) {
  const active = activeOverlays.at(-1);
  if (active) active.close(after); else after();
}
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
  let restoring: (() => void) | null = null, closing = false, finished = false, afterClose: (() => void) | undefined;
  const forget = () => { const index = activeOverlays.indexOf(control); if (index !== -1) activeOverlays.splice(index, 1); };
  const finish = () => { if (finished) return; finished = true; forget(); onClose(); afterClose?.(); };
  const close = (after?: () => void) => {
    if (finished) { after?.(); return; }
    if (closing) { afterClose ??= after; return; }
    afterClose = after;
    if (restoring) { closing = true; return; }
    if (panel(history.state)?.token !== entry.token || location.href !== entry.href) { finish(); return; }
    closing = true;
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
  const control = { close, detach: () => { forget(); detach(); } };
  activeOverlays.push(control);
  return control;
}
