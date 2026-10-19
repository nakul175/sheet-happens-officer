import { z } from "zod";

// Domain rule for self-signup: exactly these two, checked on the server (SHO-US-1.1 AC2, SHO-US-15.1).
// A Super Admin adding a person is not bound by it (SHO-US-15.2, decision D1).
export const ALLOWED_DOMAINS: readonly string[] = ["aplyd.com", "athenainfonomics.com"];
export const DOMAIN_MESSAGE = "Use your @aplyd.com or @athenainfonomics.com email address.";
export const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .refine((e) => ALLOWED_DOMAINS.includes(e.slice(e.lastIndexOf("@") + 1)), { message: DOMAIN_MESSAGE });

// Max 128 so a huge password cannot be used to burn CPU in the hash.
// abort: Zod runs later checks after a failure. Without it, a too-short or too-long
// password that also misses a letter or number adds PASSWORD_MESSAGE twice.
export const passwordField = z
  .string()
  .min(8, { error: PASSWORD_MESSAGE, abort: true })
  .max(128, { error: PASSWORD_MESSAGE, abort: true })
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), { error: PASSWORD_MESSAGE });

// SHO-US-15.2. Any valid email: the Super Admin decides who is let in.
export const addPersonInput = z.object({
  firstName: z.string().trim().min(1, "Enter a first name.").max(50),
  lastName: z.string().trim().min(1, "Enter a last name.").max(50),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address.")),
  role: z.enum(["MEMBER", "ADMIN"]),
});

export const signUpInput = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailField,
  password: passwordField,
});

// Sign-in does not apply the domain rule: a wrong-domain email must look like any other failure.
export const signInInput = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(128),
});

export const tokenInput = z.object({ token: z.string().min(20).max(200) });

export const resendInput = z.object({ email: emailField });

export const resetInput = z
  .object({ token: z.string().min(20).max(200), password: passwordField, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match.", path: ["confirm"] });

// ---- projects, members, sections ----
export const projectCreate = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullish(),
  leaderId: z.string().min(1, "Choose a Leader."),
  // SHO-US-14.17: people added in the same step. Editor unless Viewer is chosen.
  members: z.array(z.object({ userId: z.string().min(1), role: z.enum(["EDITOR", "VIEWER"]).default("EDITOR") })).max(50).optional(),
});
export const projectUpdate = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullish(),
});
export const memberAdd = z.object({ userId: z.string().min(1), role: z.enum(["EDITOR", "VIEWER"]).default("EDITOR") });
export const memberRole = z.object({ role: z.enum(["EDITOR", "VIEWER"]), handoverTo: z.string().min(1).nullish() });
export const leaderChange = z.object({
  newLeaderId: z.string().min(1),
  previousRole: z.enum(["EDITOR", "VIEWER", "REMOVE"]).default("EDITOR"),
  handoverTo: z.string().min(1).nullish(),
});
export const sectionAdd = z.object({ name: z.string().trim().min(1).max(60) });
export const sectionUpdate = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  move: z.enum(["left", "right"]).optional(),
  isDone: z.boolean().optional(),
});

// ---- tasks ----
export const taskPriority = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.");
const title = z.string().trim().min(1, "Give the task a title.").max(500);

export const taskCreate = z.object({
  title,
  description: z.string().trim().max(20000).nullish(),
  dueDate: dueDate.nullish(),
  priority: taskPriority.optional(),
  sectionId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
  approverId: z.string().min(1).optional(),
  collaboratorIds: z.array(z.string().min(1)).max(50).optional(),
});
// The updatedAt the person saw when they opened the task; a different value means someone else saved first.
// Required (SHO-BUG-13, APL-2668). The route checks it after access and before this schema (APL-2670):
// absent and null are version_required, and "" or any non-ISO value is invalid_version. The field stays
// loose so those answers are not Zod's issues list. No integer version column.
const taskVersion = z.unknown().optional();
export const taskUpdate = z.object({
  title: title.optional(),
  description: z.string().trim().max(20000).nullish(),
  dueDate: dueDate.nullish(),
  priority: taskPriority.optional(),
  blocked: z.boolean().optional(),
  blockedReason: z.string().trim().max(300).nullish(),
  expectedUpdatedAt: taskVersion,
});
export const taskAssign = z.object({ assigneeId: z.string().min(1), expectedUpdatedAt: taskVersion });
export const taskCollaborator = z.object({ userId: z.string().min(1) });
export const taskApprover = z.object({ approverId: z.string().min(1).nullable(), expectedUpdatedAt: taskVersion });
export const taskComplete = z.object({ completeAll: z.boolean().optional(), expectedUpdatedAt: taskVersion });
export const taskReopen = z.object({ sectionId: z.string().min(1).optional() });
export const taskMove = z.object({ sectionId: z.string().min(1), completeAll: z.boolean().optional(), expectedUpdatedAt: taskVersion });
export const taskRestore = z.object({ confirmParent: z.boolean().optional() });

// ---- CRM: organisations and deals (SHO-E10 to SHO-E13) ----
const optText = (max: number) => z.string().trim().max(max).nullish();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31.");
export const orgLevel = z.enum(["GROUP", "LEGAL_ENTITY", "BUYING_OFFICE"]);
export const orgCreate = z.object({
  name: z.string().trim().min(1, "Give the organisation a name.").max(200),
  kind: optText(60), country: optText(80), level: orgLevel.nullish(), parentId: z.string().min(1).nullish(), force: z.boolean().optional(),
});
export const orgUpdate = z.object({
  name: z.string().trim().min(1).max(200).optional(), kind: optText(60), country: optText(80), level: orgLevel.nullish(), parentId: z.string().min(1).nullish(),
});
export const orgArchive = z.object({ archive: z.boolean() });
export const currencyField = z.enum(["INR", "USD", "EUR"]);
export const dealDetails = z.object({
  whyPursue: z.string().trim().min(1).max(1000).optional(),
  need: optText(2000), serviceLine: optText(200),
  value: z.number().positive().max(1e13).nullish(), currency: currencyField.nullish(),
  probability: z.number().int().min(0).max(100).nullish(),
  expectedClose: isoDay.nullish(), introducedBy: optText(200), submissionDeadline: isoDay.nullish(),
});
export const dealCreate = dealDetails.extend({
  name: z.string().trim().min(1, "Give the deal a name.").max(200),
  organisationId: z.string().min(1, "Choose an organisation."),
  pipelineId: z.string().min(1, "Choose a pipeline."),
  leaderId: z.string().min(1, "Choose a Leader."),
  whyPursue: z.string().trim().min(1, "Say in one line why to pursue this.").max(1000),
  nextStep: z.object({ title: z.string().trim().min(1, "Add a first next step.").max(500), dueDate: isoDay }),
  force: z.boolean().optional(),
});
export const dealStage = z.object({ stageId: z.string().min(1), reason: z.string().trim().max(1000).nullish(), fields: dealDetails.optional() });
export const dealParty = z.object({ organisationId: z.string().min(1, "Choose an organisation."), role: z.enum(["FUNDER", "IMPLEMENTING_OFFICE", "PARTNER", "OTHER", "BUYER"]) });
export const taskIdea = z.object({ isIdea: z.boolean() });
export const taskConvert = dealDetails.extend({
  organisationId: z.string().optional(), pipelineId: z.string().optional(), name: z.string().trim().max(200).optional(),
  leaderId: z.string().optional(), whyPursue: z.string().trim().max(1000).optional(), dueDate: isoDay.nullish(), force: z.boolean().optional(),
});
const optStr = (n: number) => z.string().trim().max(n).nullish();
export const contactCreate = z.object({
  name: z.string().trim().min(1, "Give the contact a name.").max(200), role: optStr(200), email: z.string().trim().email("Use a valid email.").max(200).nullish().or(z.literal("")),
  phone: optStr(60), knownBy: z.array(z.string().min(1)).max(50).optional(),
});
export const contactUpdate = contactCreate.partial();
export const noteCreate = z.object({
  kind: z.enum(["MEETING", "CALL", "INTRODUCTION", "OTHER"]), date: isoDay, text: z.string().trim().min(1, "Write what happened.").max(10000),
  projectId: z.string().min(1).nullish(), contactIds: z.array(z.string().min(1)).max(50).optional(),
});
export const taskLinkCreate = z.object({ organisationId: z.string().min(1).nullish(), contactId: z.string().min(1).nullish() });

// ---- concierge ----
export const conciergeText = z.object({ text: z.string().min(1).max(2000) });
export const conciergePrefs = z.object({ hidden: z.boolean().optional(), voiceNoticeAcked: z.literal(true).optional() });
export const conciergeChoice = z.object({ choiceId: z.string().min(1).max(100) });
export const conciergeConfirm = z.object({
  handover: z.array(z.object({ taskId: z.string().min(1), assigneeId: z.string().min(1) })).max(500).optional(),
  // Required (true) for a card marked irreversible: the person has seen "This can't be undone".
  acknowledge: z.boolean().optional(),
});
export const conciergeUndo = z.object({ anyway: z.boolean().optional() });
