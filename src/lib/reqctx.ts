import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request facts the API wrapper turns into response headers (the Undo toast reads them).
 * The concierge also runs a confirmed card inside its own context: `channel` marks every action row
 * as made through the concierge, and `logIds` collects them so one Undo can reverse the whole card.
 */
export type ReqCtx = { undoId?: string; undoLabel?: string; notified?: boolean; channel?: "SCREEN" | "CONCIERGE"; logIds?: string[] };
export const reqCtx = new AsyncLocalStorage<ReqCtx>();
