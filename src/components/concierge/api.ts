import { api, type Res } from "../api";
import type { Card, Disabled, Message, QuickActionId, State } from "./types";

/** Typed client for the concierge routes in the contract. Never throws (see `api`). */
export const conciergeApi = {
  state: () => api<State>("GET", "/api/concierge/state"),
  setPrefs: (p: { hidden?: boolean; voiceNoticeAcked?: true }) =>
    api<{ hidden: boolean; voiceNoticeAcked: boolean }>("PATCH", "/api/concierge/preferences", p),
  send: (text: string) => api<{ messages: Message[]; disabled?: Disabled }>("POST", "/api/concierge/messages", { text }),
  clear: () => api<{ ok: true }>("DELETE", "/api/concierge/messages"),
  quick: (id: QuickActionId) => api<{ messages: Message[] }>("POST", `/api/concierge/quick/${encodeURIComponent(id)}`, {}),
  improve: (text: string) => api<{ improved: string }>("POST", "/api/concierge/improve", { text }),
  choose: (messageId: string, choiceId: string) =>
    api<{ messages: Message[] }>("POST", `/api/concierge/choices/${encodeURIComponent(messageId)}`, { choiceId }),
  confirm: (cardId: string, handover?: { taskId: string; assigneeId: string }[]) =>
    api<{ messages: Message[]; card: Card }>("POST", `/api/concierge/cards/${encodeURIComponent(cardId)}/confirm`, handover ? { handover } : {}),
  cancel: (cardId: string) => api<{ card: Card }>("POST", `/api/concierge/cards/${encodeURIComponent(cardId)}/cancel`, {}),
  undo: (cardId: string, anyway = false) =>
    api<{ messages: Message[]; needsConfirm?: string; conflicts?: { field: string; before: string; after: string; now: string }[]; changedBy?: string[] }>("POST", `/api/concierge/cards/${encodeURIComponent(cardId)}/undo`, anyway ? { anyway: true } : {}),
};

export type { Res };
