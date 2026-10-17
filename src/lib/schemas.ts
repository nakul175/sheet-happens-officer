import { z } from "zod";

// Domain rule: exactly aplyd.com, checked on the server (SHO-US-1.1 AC2).
export const ALLOWED_DOMAIN = "aplyd.com";
export const DOMAIN_MESSAGE = "Use your @aplyd.com email address.";
export const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .refine((e) => e.slice(e.lastIndexOf("@") + 1) === ALLOWED_DOMAIN, { message: DOMAIN_MESSAGE });

// Max 128 so a huge password cannot be used to burn CPU in the hash.
export const passwordField = z
  .string()
  .min(8, PASSWORD_MESSAGE)
  .max(128, PASSWORD_MESSAGE)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), { message: PASSWORD_MESSAGE });

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
export const taskUpdate = z.object({
  title: title.optional(),
  description: z.string().trim().max(20000).nullish(),
  dueDate: dueDate.nullish(),
  priority: taskPriority.optional(),
  blocked: z.boolean().optional(),
  blockedReason: z.string().trim().max(300).nullish(),
  // The updatedAt the person saw when they opened the task; a different value means someone else saved first.
  expectedUpdatedAt: z.string().optional(),
});
export const taskAssign = z.object({ assigneeId: z.string().min(1) });
export const taskCollaborator = z.object({ userId: z.string().min(1) });
export const taskApprover = z.object({ approverId: z.string().min(1).nullable() });
export const taskComplete = z.object({ completeAll: z.boolean().optional() });
export const taskReopen = z.object({ sectionId: z.string().min(1).optional() });
export const taskMove = z.object({ sectionId: z.string().min(1), completeAll: z.boolean().optional() });
export const taskRestore = z.object({ confirmParent: z.boolean().optional() });

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
