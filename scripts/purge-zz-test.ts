// APL-2625 option 1. One-off purge of leftover ZZ-TEST people on staging.
//
// This script is not part of a release and is not on a schedule. It refuses to run
// from /opt/sho. It is dry-run unless --apply is passed.
//
// It runs only when SHO_ALLOW_TEST_PURGE=1 and --workspace is exactly STAGING_WORKSPACE_ID.
// It refuses production before opening a connection (PROD_DB_HOST, PROD_DB_NAME, or
// app.sheethappensofficer.com). It deletes only deactivated people whose email matches
// zz-test-*@example.invalid, who are older than 24 hours, and who have no audit-log rows.
// Output is counts, ids, and those zz-test emails. No passwords or connection strings.
//
//   SHO_ALLOW_TEST_PURGE=1 STAGING_WORKSPACE_ID=<id> \
//     npx tsx scripts/purge-zz-test.ts --workspace <id>
//   SHO_ALLOW_TEST_PURGE=1 STAGING_WORKSPACE_ID=<id> \
//     npx tsx scripts/purge-zz-test.ts --workspace <id> --apply

import { fileURLToPath, pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";

const PROD_APP_HOST = "app.sheethappensofficer.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^zz-test-[^@]+@example\.invalid$/;
const COUNT_TABLES = [
  "User",
  "Session",
  "AuthToken",
  "ProjectMember",
  "TaskCollaborator",
  "Notification",
  "ChatMessage",
  "SavedView",
  "ModelUsage",
  "ActionLog",
  "Task",
  "ContactKnownBy",
  "LoginAttempt",
] as const;

type CountTable = (typeof COUNT_TABLES)[number];
type Db = PrismaClient | Prisma.TransactionClient;
type TaskRef = { id: string; parentId: string | null; assigneeId: string; createdById: string };
type Person = { id: string; email: string };
type Plan = { people: Person[]; taskIds: string[]; counts: Record<CountTable, number> };

class ScriptRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptRefusal";
  }
}

export type DbConnect = (databaseUrl: string) => PrismaClient | Promise<PrismaClient>;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isProdAppHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === PROD_APP_HOST || normalized.endsWith(`.${PROD_APP_HOST}`);
}

function parseTarget(raw: string): { host: string; name: string } | null {
  try {
    const url = new URL(raw);
    const host = normalizeHost(url.hostname);
    if (!host) return null;
    const name = decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] ?? "");
    return { host, name };
  } catch {
    return null;
  }
}

/** Refusal text, or null when this environment is not production. The URL is never included. */
export function productionRefusal(env: NodeJS.ProcessEnv): string | null {
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) return "Refusing to run: DATABASE_URL is not set.";
  const urls = [databaseUrl, env.DIRECT_DATABASE_URL].filter((value): value is string => !!value);
  const prodHost = normalizeHost(env.PROD_DB_HOST ?? "");
  const prodName = (env.PROD_DB_NAME ?? "").trim();
  for (const raw of urls) {
    if (raw.toLowerCase().includes(PROD_APP_HOST)) return "Refusing to run: the database host is production.";
    const target = parseTarget(raw);
    if (!target) return "Refusing to run: the database URL is not valid.";
    if (isProdAppHost(target.host) || (prodHost && target.host === prodHost)) {
      return "Refusing to run: the database host is production.";
    }
    if (prodName && target.name === prodName) return "Refusing to run: the database name is production.";
  }
  const appUrl = env.APP_URL ?? "";
  if (appUrl) {
    if (appUrl.toLowerCase().includes(PROD_APP_HOST)) return "Refusing to run: the app host is production.";
    const app = parseTarget(appUrl);
    if (app && isProdAppHost(app.host)) return "Refusing to run: the app host is production.";
  }
  return null;
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]");
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  out = out.split(PROD_APP_HOST).join("[redacted]");
  if (/postgres(?:ql)?:\/\//i.test(out)) return "The script failed.";
  return out;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = argv.indexOf(name);
  const next = index >= 0 ? argv[index + 1] : undefined;
  if (next && !next.startsWith("-")) return next;
  return undefined;
}

function assertNotDeployed() {
  const here = fileURLToPath(import.meta.url);
  if (here.startsWith("/opt/sho/") || process.cwd().startsWith("/opt/sho/")) {
    throw new ScriptRefusal("Refusing to run: this script is not deployed.");
  }
}

export function defaultConnect(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl, errorFormat: "minimal" });
}

async function auditHits(db: Db, ids: string[]): Promise<Set<string>> {
  const hits = new Set<string>();
  if (!ids.length) return hits;
  const idSet = new Set(ids);
  const rows = await db.auditLog.findMany({
    where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    select: { actorId: true, targetId: true },
  });
  for (const row of rows) {
    if (row.actorId && idSet.has(row.actorId)) hits.add(row.actorId);
    if (row.targetId && idSet.has(row.targetId)) hits.add(row.targetId);
  }
  return hits;
}

async function tasksTouching(db: Db, userIds: string[]): Promise<TaskRef[]> {
  const byId = new Map<string, TaskRef>();
  if (!userIds.length) return [];
  const select = { id: true, parentId: true, assigneeId: true, createdById: true } as const;
  const roots = await db.task.findMany({
    where: { OR: [{ assigneeId: { in: userIds } }, { createdById: { in: userIds } }] },
    select,
  });
  const pending: string[] = [];
  for (const row of roots) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
      pending.push(row.id);
    }
  }
  while (pending.length) {
    const parents = pending.splice(0, pending.length);
    const children = await db.task.findMany({ where: { parentId: { in: parents } }, select });
    for (const child of children) {
      if (!byId.has(child.id)) {
        byId.set(child.id, child);
        pending.push(child.id);
      }
    }
  }
  return [...byId.values()];
}

function treeRefs(taskId: string, byId: Map<string, TaskRef>, children: Map<string, string[]>): string[] {
  const refs: string[] = [];
  const stack = [taskId];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const row = byId.get(current);
    if (row) refs.push(row.assigneeId, row.createdById);
    for (const child of children.get(current) ?? []) stack.push(child);
  }
  return refs;
}

// A person who shares a task with someone outside the purge set is kept. Tasks whose
// whole tree belongs to the purge set are deleted so the user row can go.
function settle(eligibleIds: string[], tasks: TaskRef[]): { purgeIds: string[]; deleteTaskIds: string[] } {
  const purge = new Set(eligibleIds);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const list = children.get(task.parentId) ?? [];
    list.push(task.id);
    children.set(task.parentId, list);
  }
  for (;;) {
    const blocked = new Set<string>();
    for (const task of tasks) {
      const refs = treeRefs(task.id, byId, children);
      const touchesPurge = refs.some((id) => purge.has(id));
      const touchesOutside = refs.some((id) => !purge.has(id));
      if (touchesPurge && touchesOutside) {
        for (const id of refs) if (purge.has(id)) blocked.add(id);
      }
    }
    if (blocked.size === 0) break;
    for (const id of blocked) purge.delete(id);
  }
  const deleteTaskIds = tasks
    .filter((task) => {
      const refs = treeRefs(task.id, byId, children);
      return refs.length > 0 && refs.every((id) => purge.has(id));
    })
    .map((task) => task.id);
  return { purgeIds: [...purge], deleteTaskIds };
}

async function countsFor(db: Db, ids: string[], emails: string[], taskIds: string[]): Promise<Record<CountTable, number>> {
  const empty = Object.fromEntries(COUNT_TABLES.map((table) => [table, 0])) as Record<CountTable, number>;
  if (!ids.length) return empty;
  const [sessions, tokens, members, collaborators, notifications, chats, views, usage, actions, knownBy, attempts] = await Promise.all([
    db.session.count({ where: { userId: { in: ids } } }),
    db.authToken.count({ where: { userId: { in: ids } } }),
    db.projectMember.count({ where: { userId: { in: ids } } }),
    db.taskCollaborator.count({ where: { userId: { in: ids } } }),
    db.notification.count({ where: { recipientId: { in: ids } } }),
    db.chatMessage.count({ where: { userId: { in: ids } } }),
    db.savedView.count({ where: { userId: { in: ids } } }),
    db.modelUsage.count({ where: { userId: { in: ids } } }),
    db.actionLog.count({ where: { actorId: { in: ids } } }),
    db.contactKnownBy.count({ where: { userId: { in: ids } } }),
    db.loginAttempt.count({ where: { email: { in: emails } } }),
  ]);
  return {
    User: ids.length,
    Session: sessions,
    AuthToken: tokens,
    ProjectMember: members,
    TaskCollaborator: collaborators,
    Notification: notifications,
    ChatMessage: chats,
    SavedView: views,
    ModelUsage: usage,
    ActionLog: actions,
    Task: taskIds.length,
    ContactKnownBy: knownBy,
    LoginAttempt: attempts,
  };
}

async function buildPlan(db: Db, workspaceId: string): Promise<Plan> {
  const cutoff = new Date(Date.now() - DAY_MS);
  const rows = await db.user.findMany({
    where: { workspaceId, deactivatedAt: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true, email: true },
  });
  const matched = rows.filter((row) => EMAIL_RE.test(row.email));
  const audited = await auditHits(db, matched.map((row) => row.id));
  const eligible = matched.filter((row) => !audited.has(row.id));
  const tasks = await tasksTouching(db, eligible.map((row) => row.id));
  const settled = settle(eligible.map((row) => row.id), tasks);
  const purge = new Set(settled.purgeIds);
  const people = eligible.filter((row) => purge.has(row.id)).sort((a, b) => a.id.localeCompare(b.id));
  const counts = await countsFor(db, people.map((person) => person.id), people.map((person) => person.email), settled.deleteTaskIds);
  return { people, taskIds: settled.deleteTaskIds, counts };
}

async function applyDeletes(db: Db, plan: Plan) {
  const ids = plan.people.map((person) => person.id);
  const emails = plan.people.map((person) => person.email);
  if (!ids.length) return;
  if (plan.taskIds.length) await db.task.deleteMany({ where: { id: { in: plan.taskIds } } });
  await db.actionLog.deleteMany({ where: { actorId: { in: ids } } });
  await db.modelUsage.deleteMany({ where: { userId: { in: ids } } });
  await db.contactKnownBy.deleteMany({ where: { userId: { in: ids } } });
  await db.loginAttempt.deleteMany({ where: { email: { in: emails } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

function formatPlan(workspaceId: string, apply: boolean, plan: Plan): string {
  const lines = [`mode: ${apply ? "apply" : "dry-run"}`, `workspace: ${workspaceId}`];
  for (const table of COUNT_TABLES) lines.push(`${table}: ${plan.counts[table]}`);
  for (const person of plan.people) {
    lines.push(`id: ${person.id}`);
    lines.push(`email: ${person.email}`);
  }
  return lines.join("\n");
}

export async function runPurge(env: NodeJS.ProcessEnv, argv: readonly string[], connect: DbConnect = defaultConnect): Promise<number> {
  const secrets = [env.DATABASE_URL ?? "", env.DIRECT_DATABASE_URL ?? ""];
  let db: PrismaClient | null = null;
  try {
    assertNotDeployed();
    if (env.SHO_ALLOW_TEST_PURGE !== "1") throw new ScriptRefusal("Refusing to run without SHO_ALLOW_TEST_PURGE=1.");
    const refusal = productionRefusal(env);
    if (refusal) throw new ScriptRefusal(refusal);
    const workspaceId = flagValue(argv, "--workspace")?.trim() ?? "";
    const configured = env.STAGING_WORKSPACE_ID?.trim() ?? "";
    if (!workspaceId || !configured || workspaceId !== configured) {
      throw new ScriptRefusal("Refusing to run: --workspace does not match the configured staging workspace.");
    }
    db = await connect(env.DATABASE_URL ?? "");
    const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!workspace) throw new ScriptRefusal("Refusing to run: the staging workspace was not found.");
    const apply = argv.includes("--apply");
    if (!apply) {
      console.log(formatPlan(workspaceId, false, await buildPlan(db, workspaceId)));
      return 0;
    }
    const deleted = await db.$transaction(async (tx) => {
      const plan = await buildPlan(tx, workspaceId);
      await applyDeletes(tx, plan);
      return plan;
    });
    console.log(formatPlan(workspaceId, true, deleted));
    return 0;
  } catch (err) {
    const message = err instanceof ScriptRefusal ? err.message : scrub(err instanceof Error ? err.message : "The script failed.", secrets);
    console.error(message);
    return 1;
  } finally {
    await db?.$disconnect();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runPurge(process.env, process.argv).then((code) => {
    process.exit(code);
  });
}
