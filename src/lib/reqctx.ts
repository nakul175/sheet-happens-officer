import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request facts the API wrapper turns into response headers (the Undo toast reads them). */
export type ReqCtx = { undoId?: string; undoLabel?: string; notified?: boolean };
export const reqCtx = new AsyncLocalStorage<ReqCtx>();
