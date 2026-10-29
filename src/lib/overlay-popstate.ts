// A document-level listener must exist before the router's popstate listener. A query-driven task
// can otherwise unmount (and remove its own listener) while the same native event is being delivered.
type Handler = (event: PopStateEvent) => void;
const handlers: Handler[] = [];
let installed = false;
export function initializeOverlayPopstate() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("popstate", event => {
    for (const handler of [...handlers].reverse()) {
      handler(event);
      if (event.cancelBubble) break;
    }
  }, true);
}
export function onOverlayPopstate(handler: Handler) {
  initializeOverlayPopstate();
  handlers.push(handler);
  return () => { const index = handlers.indexOf(handler); if (index !== -1) handlers.splice(index, 1); };
}
