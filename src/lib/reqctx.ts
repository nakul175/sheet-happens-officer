import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request facts the API wrapper turns into response headers (the Undo toast reads them).
 * `muteNotify` holds back per-task notices while a bulk action runs; the bulk action then sends one summary notice per person.
 */
export type ReqCtx = { undoId?: string; undoLabel?: string; notified?: boolean; logIds?: string[]; muteNotify?: boolean };
export const reqCtx = new AsyncLocalStorage<ReqCtx>();
