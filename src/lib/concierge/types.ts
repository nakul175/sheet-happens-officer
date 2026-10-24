// Shapes shared with the UI. Binding contract: see the concierge build contract (Message, Card, State).
import type { Disabled } from "@/lib/concierge/limits";

export type Card = {
  id: string;
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "STALE";
  title: string;
  changes: { label: string; before?: string; after?: string }[]; // at most 10 rows
  canConfirm: boolean;
  blockedReason?: string;
  irreversible?: boolean;
  handover?: { taskId: string; taskTitle: string; assigneeId?: string }[];
  handoverOptions?: { id: string; name: string }[];
};

export type Message = {
  id: string;
  role: "USER" | "ASSISTANT";
  createdAt: string;
  kind: "text" | "answer" | "choices" | "card" | "result" | "notice";
  text: string;
  links?: { label: string; href: string }[];
  choices?: { id: string; label: string; detail?: string }[];
  choiceAnswered?: string;
  card?: Card;
  result?: { cardId: string; summary: string[]; undoable: boolean; undoneAt?: string; undoExpired?: boolean; notNotified?: boolean; noticeSent?: boolean };
};

export type State = {
  available: boolean;
  disabled?: Disabled;
  hidden: boolean;
  voiceNoticeAcked: boolean;
  quickActions: { id: "due-week" | "overdue" | "waiting-on-me" | "blocked" | "recently-completed"; label: string }[];
  messages: Message[];
};

/** What is kept in ChatMessage.content (JSON). Fields after `result` never leave the server. */
export type Stored = {
  kind: Message["kind"];
  text: string;
  links?: Message["links"];
  choices?: Message["choices"];
  choiceAnswered?: string;
  card?: Card;
  result?: Message["result"];
  /** Server-only. */
  /** `versions` is each task's updatedAt when the card was built (APL-2667). Server-only, with the rest of proposal. */
  proposal?: { ops: unknown[]; fingerprint: string; versions?: Record<string, string> };
  /** Set on a row written while the CRM was hidden from its owner (APL-2609). Only such rows are shown or replayed then. */
  crmHidden?: true;
  pending?: { request: string; question?: string; kind?: "task" | "project" | "person" | "deal"; optionIds?: string[]; narrowFor?: string };
  internal?: {
    logIds?: string[]; confirmedAt?: string; resultMessageId?: string; cardMessageId?: string;
    /** Card: RUNNING while it is being applied, PARTIAL when it stopped half way. */
    state?: "RUNNING" | "PARTIAL"; runningAt?: string;
    /** Result: an Undo is in progress, and which action rows it has already reversed. */
    undoing?: boolean; undoingAt?: string; undoneIds?: string[];
    /** A user message that only repeats a picked option; never replayed to the model. */
    fromChoice?: boolean;
  };
};
