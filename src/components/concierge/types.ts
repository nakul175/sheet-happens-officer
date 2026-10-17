// Shapes from the concierge build contract (SHO-US-8.x). Do not change names or shapes without telling the lead.
export type Card = {
  id: string;
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "STALE";
  title: string;
  changes: { label: string; before?: string; after?: string }[];
  canConfirm: boolean;
  blockedReason?: string;
  irreversible?: boolean;
  handover?: { taskId: string; taskTitle: string; assigneeId?: string }[];
  handoverOptions?: { id: string; name: string }[];
};

export type ResultInfo = {
  cardId: string;
  summary: string[];
  undoable: boolean;
  undoneAt?: string;
  undoExpired?: boolean;
  notNotified?: boolean;
  noticeSent?: boolean;
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
  result?: ResultInfo;
};

export type Disabled = { code: "NOT_ENABLED" | "MONTH_CAP" | "WEEK_CAP" | "PROVIDER_DOWN"; message: string; resumesAt?: string };
export type QuickActionId = "due-week" | "overdue" | "waiting-on-me" | "blocked" | "recently-completed";

export type State = {
  available: boolean;
  disabled?: Disabled;
  hidden: boolean;
  voiceNoticeAcked: boolean;
  quickActions: { id: QuickActionId; label: string }[];
  messages: Message[];
};

/** Exact wording required by SHO-US-8.8 AC5. */
export const PRIVACY_SENTENCE = "Your chats are not visible anywhere in the app to anyone else, and are deleted from the app after 90 days.";
