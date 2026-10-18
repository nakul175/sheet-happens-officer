// Shapes for the concierge evaluation set. Grading reads these; nothing here calls a model.

export const CATEGORIES = [
  "reads",
  "task-writes",
  "crm-reads",
  "ambiguity",
  "permission-refusals",
  "found-nothing",
  "prompt-injection",
  "relative-dates",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type OrgRole = "MEMBER" | "ADMIN" | "SUPER_ADMIN";
export type ProjectRole = "EDITOR" | "VIEWER";
export type CrmMode = "all" | "admins" | "off";

export type PersonSpec = { key: string; name: string; orgRole?: OrgRole };
export type OrgSpec = { key: string; name: string };
export type ProjectSpec = {
  key: string;
  name: string;
  leader: string;
  kind?: "project" | "deal";
  /** Organisation key. Required when kind is "deal". */
  org?: string;
  members?: { key: string; role: ProjectRole }[];
};
export type TaskSpec = {
  key: string;
  project: string;
  title: string;
  assignee: string;
  /** A YYYY-MM-DD date, or overdue / soon / later / today / tomorrow / none. */
  due?: string;
  description?: string;
  blocked?: boolean;
  blockedReason?: string;
  done?: boolean;
  /** Person key. Set equal to the assignee to seed a task that is waiting on them. */
  approver?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
};
export type NoteSpec = { key: string; org: string; deal?: string; text: string };

export type FixtureSpec = {
  actor: string;
  people: PersonSpec[];
  orgs?: OrgSpec[];
  projects: ProjectSpec[];
  tasks?: TaskSpec[];
  notes?: NoteSpec[];
};

export type World = {
  actor: { id: string; name: string; orgRole: OrgRole };
  people: Record<string, { id: string; name: string; email: string }>;
  projects: Record<string, { id: string; name: string }>;
  tasks: Record<string, { id: string; title: string }>;
  notes: Record<string, { id: string; text: string }>;
};

export type ToolExpect = {
  name: string;
  /** Each listed key must equal the tool input. Extra input keys are ignored. */
  input?: Record<string, string | number | boolean>;
};

export type OpExpect = {
  k: string;
  match?: Record<string, string | number | boolean | null>;
};

export type ReplyKind = "text" | "answer" | "choices" | "card" | "notice";

/** What a correct concierge turn looks like. Free text is links and string checks only. */
export type Expectation = {
  tools?: ToolExpect[];
  /** At least one of these must have been called. */
  toolsAny?: ToolExpect[];
  forbidTools?: string[];
  /** At least one read tool (my_tasks, find_tasks, list_projects, project_tasks, find_people). */
  read?: boolean;
  kind?: ReplyKind | ReplyKind[];
  ops?: OpExpect[];
  forbidOps?: string[];
  canConfirm?: boolean;
  /** A card, if the model proposes one, must not be confirmable. No card is also fine. */
  blockedOrNoCard?: boolean;
  foundNothing?: boolean;
  choices?: boolean;
  links?: { href: string; labelIncludes?: string }[];
  requireText?: string[];
  forbidText?: string[];
};

export type Prompt = {
  id: string;
  category: Category;
  text: string;
  crm?: CrmMode;
  fixture: FixtureSpec;
  expect: (world: World) => Expectation;
};

export type ToolCall = { name: string; input: Record<string, unknown> };
export type ObservedOp = { k: string } & Record<string, unknown>;

export type Observation = {
  toolCalls: ToolCall[];
  kind: string;
  text: string;
  links: { label: string; href: string }[];
  choices: { id: string; label: string }[];
  canConfirm?: boolean;
  blockedReason?: string;
  cardText: string[];
  ops: ObservedOp[];
  mutated: boolean;
};

export type Grade = { pass: boolean; reasons: string[] };
export type Status = "pass" | "fail" | "flaky";
