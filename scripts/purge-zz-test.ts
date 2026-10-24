// APL-2625 option 1. One-off purge of leftover ZZ-TEST people on staging.
//
// This script is not part of a release and is not on a schedule. It refuses to run
// when the working directory or the script path is /opt/sho or anything under it,
// after symlinks are resolved. It is dry-run unless --apply is passed.
// The URL and current_database() must both be exactly sho_staging (including dry-run).
// --apply also requires --confirm=sho_staging equal to current_database().
// A missing or empty --confirm refuses before a connection is opened.
//
// It runs only when SHO_ALLOW_TEST_PURGE=1 and --workspace is exactly STAGING_WORKSPACE_ID.
// PROD_DB_HOST and PROD_DB_NAME must both be set. It refuses production before opening a
// connection (those values, or app.sheethappensofficer.com). PROD_DB_NAME is compared
// without regard to case, so SHO_PROD matches sho_prod. It deletes only deactivated
// people whose name starts ZZ-TEST and whose email matches zz-test-*@example.invalid, who are older than 24 hours, and
// who have no audit-log rows. It refuses instead of changing a row that is not one of
// those people: a SET NULL foreign key, or a task delete that would cascade such a row.
// Output is counts, ids, and those zz-test emails. No passwords or connection strings.
//
//   SHO_ALLOW_TEST_PURGE=1 STAGING_WORKSPACE_ID=<id> PROD_DB_HOST=<host> PROD_DB_NAME=<name> \
//     npx tsx scripts/purge-zz-test.ts --workspace <id>
//   SHO_ALLOW_TEST_PURGE=1 STAGING_WORKSPACE_ID=<id> PROD_DB_HOST=<host> PROD_DB_NAME=<name> \
//     npx tsx scripts/purge-zz-test.ts --workspace <id> --apply --confirm=<database name>

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";

const PROD_APP_HOST = "app.sheethappensofficer.com";
const DEPLOY_ROOT = "/opt/sho";
const STAGING_DATABASE = "sho_staging";
const DAY_MS = 24 * 60 * 60 * 1000;
const MODIFY_RELATIONS = [
  "Task.approverId",
  "Task.previousAssigneeId",
  "Task.deletedById",
  "Task.assigneeId",
  "Task.createdById",
  "Notification.actorId",
  "ActionLog.undoneById",
  "AuditLog.actorId",
  "Comment.authorId",
  "Organisation.createdById",
  "Contact.createdById",
  "Note.authorId",
] as const;
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
type ModifyRelation = (typeof MODIFY_RELATIONS)[number];
type Safety = {
  relations: Record<ModifyRelation, number>;
  cascade: {
    task: number;
    collaborator: number;
    collaboratorOutside: number;
    descendantOutside: number;
    assigneeOutside: number;
    createdByOutside: number;
    taskLink: number;
    comment: number;
  };
};

export type PurgeLocations = { cwd?: string; scriptPath?: string };

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
    const name = decodeURIComponent(url.pathname.slice(1));
    return { host, name };
  } catch {
    return null;
  }
}

/** Refusal text, or null when this environment is not production. The URL is never included. */
export function productionRefusal(env: NodeJS.ProcessEnv): string | null {
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) return "Refusing to run: DATABASE_URL is not set.";
  const prodHostRaw = env.PROD_DB_HOST ?? "";
  const prodNameRaw = env.PROD_DB_NAME ?? "";
  if (!prodHostRaw.trim() || !prodNameRaw.trim()) {
    return "Refusing to run: PROD_DB_HOST and PROD_DB_NAME must be set.";
  }
  const urls = [databaseUrl, env.DIRECT_DATABASE_URL].filter((value): value is string => !!value);
  const prodHost = normalizeHost(prodHostRaw);
  const prodName = prodNameRaw.trim();
  for (const raw of urls) {
    if (raw.toLowerCase().includes(PROD_APP_HOST)) return "Refusing to run: the database host is production.";
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return "Refusing to run: invalid database protocol.";
    // No libpq host/dbname/options override may bypass the pathname/host guards.
    const allowed = new Set(["schema", "sslmode", "connection_limit", "pool_timeout", "connect_timeout"]);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key))) return "Refusing to run: database URL overrides are not allowed.";
    const target = parseTarget(raw);
    if (!target) return "Refusing to run: the database URL is not valid.";
    if (isProdAppHost(target.host) || (prodHost && target.host === prodHost)) {
      return "Refusing to run: the database host is production.";
    }
    if (prodName && target.name.toLowerCase() === prodName.toLowerCase()) {
      return "Refusing to run: the database name is production.";
    }
    if (target.name !== STAGING_DATABASE) return 'Refusing to run: database must be exactly "sho_staging".';
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

/** Resolve a path, following symlinks even when the final target does not exist. */
export function canonicalPath(input: string): string {
  const seen = new Set<string>();
  return walkPath(path.resolve(input), seen);
}

function walkPath(absolute: string, seen: Set<string>): string {
  if (seen.has(absolute)) return absolute;
  seen.add(absolute);
  try {
    return realpathSync(absolute);
  } catch {
    // The leaf may be missing. Follow any symlink that does exist.
  }
  const parts = absolute.split("/").filter(Boolean);
  let acc = "/";
  for (const part of parts) {
    const next = path.join(acc, part);
    let linked = false;
    try {
      if (lstatSync(next).isSymbolicLink()) {
        const target = readlinkSync(next);
        acc = walkPath(path.resolve(path.dirname(next), target), seen);
        linked = true;
      }
    } catch {
      acc = next;
      continue;
    }
    if (!linked) acc = next;
  }
  return acc;
}

export function isDeployedLocation(input: string): boolean {
  const resolved = canonicalPath(input);
  return resolved === DEPLOY_ROOT || resolved.startsWith(`${DEPLOY_ROOT}/`);
}

function assertNotDeployed(locations?: PurgeLocations) {
  const cwd = locations?.cwd ?? process.cwd();
  const scriptPath = locations?.scriptPath ?? fileURLToPath(import.meta.url);
  if (isDeployedLocation(cwd) || isDeployedLocation(scriptPath)) {
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
  const actions = await db.actionLog.findMany({ where: { actorId: { in: ids } }, select: { actorId: true } });
  for (const row of actions) hits.add(row.actorId);
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

function emptyRelations(): Record<ModifyRelation, number> {
  return Object.fromEntries(MODIFY_RELATIONS.map((name) => [name, 0])) as Record<ModifyRelation, number>;
}

function emptyCascade(): Safety["cascade"] {
  return {
    task: 0,
    collaborator: 0,
    collaboratorOutside: 0,
    descendantOutside: 0,
    assigneeOutside: 0,
    createdByOutside: 0,
    taskLink: 0,
    comment: 0,
  };
}

async function cascadeTaskIds(db: Db, roots: string[]): Promise<{ all: string[]; outside: string[] }> {
  const all = [...roots];
  const outside: string[] = [];
  if (!roots.length) return { all, outside };
  const seen = new Set(roots);
  let frontier = roots;
  while (frontier.length) {
    const children = await db.task.findMany({ where: { parentId: { in: frontier } }, select: { id: true } });
    frontier = [];
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      all.push(child.id);
      outside.push(child.id);
      frontier.push(child.id);
    }
  }
  return { all, outside };
}

async function safetyReport(db: Db, plan: Plan): Promise<Safety> {
  const relations = emptyRelations();
  const cascade = emptyCascade();
  const purgeIds = plan.people.map((person) => person.id);
  if (!purgeIds.length) return { relations, cascade };
  const { all, outside } = await cascadeTaskIds(db, plan.taskIds);
  const surviving = all.length ? { id: { notIn: all } } : {};
  const [approver, previous, deletedBy, assignee, createdBy, actor, undoneBy, auditActor, collaborators, collaboratorsOutside, assigneeOutside, createdByOutside, taskLinks] =
    await Promise.all([
      db.task.count({ where: { ...surviving, approverId: { in: purgeIds } } }),
      db.task.count({ where: { ...surviving, previousAssigneeId: { in: purgeIds } } }),
      db.task.count({ where: { ...surviving, deletedById: { in: purgeIds } } }),
      db.task.count({ where: { ...surviving, assigneeId: { in: purgeIds } } }),
      db.task.count({ where: { ...surviving, createdById: { in: purgeIds } } }),
      db.notification.count({ where: { actorId: { in: purgeIds }, NOT: { recipientId: { in: purgeIds } } } }),
      db.actionLog.count({ where: { undoneById: { in: purgeIds }, NOT: { actorId: { in: purgeIds } } } }),
      db.auditLog.count({ where: { actorId: { in: purgeIds } } }),
      all.length ? db.taskCollaborator.count({ where: { taskId: { in: all } } }) : Promise.resolve(0),
      all.length ? db.taskCollaborator.count({ where: { taskId: { in: all }, NOT: { userId: { in: purgeIds } } } }) : Promise.resolve(0),
      plan.taskIds.length ? db.task.count({ where: { id: { in: plan.taskIds }, NOT: { assigneeId: { in: purgeIds } } } }) : Promise.resolve(0),
      plan.taskIds.length ? db.task.count({ where: { id: { in: plan.taskIds }, NOT: { createdById: { in: purgeIds } } } }) : Promise.resolve(0),
      all.length ? db.taskLink.count({ where: { taskId: { in: all } } }) : Promise.resolve(0),
    ]);
  relations["Task.approverId"] = approver;
  relations["Task.previousAssigneeId"] = previous;
  relations["Task.deletedById"] = deletedBy;
  relations["Task.assigneeId"] = assignee;
  relations["Task.createdById"] = createdBy;
  relations["Notification.actorId"] = actor;
  relations["ActionLog.undoneById"] = undoneBy;
  relations["AuditLog.actorId"] = auditActor;
  relations["Comment.authorId"] = await db.comment.count({ where: { authorId: { in: purgeIds } } });
  relations["Organisation.createdById"] = await db.organisation.count({ where: { createdById: { in: purgeIds } } });
  relations["Contact.createdById"] = await db.contact.count({ where: { createdById: { in: purgeIds } } });
  relations["Note.authorId"] = await db.note.count({ where: { authorId: { in: purgeIds } } });
  if (all.length && await db.task.count({ where: { id: { in: all }, NOT: { title: { startsWith: "ZZ-TEST" } } } })) {
    throw new ScriptRefusal("Refusing to run: affected tasks are not marked ZZ-TEST.");
  }
  cascade.task = all.length;
  cascade.collaborator = collaborators;
  cascade.collaboratorOutside = collaboratorsOutside;
  cascade.descendantOutside = outside.length;
  cascade.assigneeOutside = assigneeOutside;
  cascade.createdByOutside = createdByOutside;
  cascade.taskLink = taskLinks;
  cascade.comment = all.length ? await db.comment.count({ where: { taskId: { in: all } } }) : 0;
  return { relations, cascade };
}

function formatSafety(safety: Safety): string {
  const lines = MODIFY_RELATIONS.map((name) => `${name}: ${safety.relations[name]}`);
  lines.push(
    `cascade Task: ${safety.cascade.task}`,
    `cascade TaskCollaborator: ${safety.cascade.collaborator}`,
    `cascade TaskCollaborator.outside: ${safety.cascade.collaboratorOutside}`,
    `cascade Task.descendantOutside: ${safety.cascade.descendantOutside}`,
    `cascade Task.assigneeOutside: ${safety.cascade.assigneeOutside}`,
    `cascade Task.createdByOutside: ${safety.cascade.createdByOutside}`,
    `cascade TaskLink: ${safety.cascade.taskLink}`,
    `cascade Comment: ${safety.cascade.comment}`,
  );
  return lines.join("\n");
}

function blockMessage(safety: Safety): string | null {
  const cascadeHit =
    safety.cascade.collaboratorOutside > 0 ||
    safety.cascade.descendantOutside > 0 ||
    safety.cascade.assigneeOutside > 0 ||
    safety.cascade.createdByOutside > 0 ||
    safety.cascade.taskLink > 0 || safety.cascade.comment > 0;
  const modifyHit = MODIFY_RELATIONS.some((name) => safety.relations[name] > 0);
  if (!modifyHit && !cascadeHit) return null;
  return `Refusing to run: purge would change rows that are not ZZ-TEST.\n${formatSafety(safety)}`;
}

async function currentDatabase(db: PrismaClient): Promise<string> {
  const rows = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  return rows[0]?.name ?? "";
}

async function buildPlan(db: Db, workspaceId: string): Promise<Plan> {
  const cutoff = new Date(Date.now() - DAY_MS);
  const rows = await db.user.findMany({
    where: { workspaceId, deactivatedAt: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true, email: true, name: true },
  });
  const matched = rows.filter((row) => row.name.startsWith("ZZ-TEST") && EMAIL_RE.test(row.email));
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
  // Action-log actors are excluded; never delete their audit trail.
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

async function refuseIfUnsafe(db: Db, workspaceId: string, apply: boolean): Promise<Plan> {
  const plan = await buildPlan(db, workspaceId);
  const safety = await safetyReport(db, plan);
  const blocked = blockMessage(safety);
  if (blocked) throw new ScriptRefusal(blocked);
  console.log(`${formatPlan(workspaceId, apply, plan)}\n${formatSafety(safety)}`);
  return plan;
}

export async function runPurge(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  connect: DbConnect = defaultConnect,
  locations?: PurgeLocations,
): Promise<number> {
  const secrets = [env.DATABASE_URL ?? "", env.DIRECT_DATABASE_URL ?? ""];
  let db: PrismaClient | null = null;
  try {
    assertNotDeployed(locations);
    if (env.SHO_ALLOW_TEST_PURGE !== "1") throw new ScriptRefusal("Refusing to run without SHO_ALLOW_TEST_PURGE=1.");
    const refusal = productionRefusal(env);
    if (refusal) throw new ScriptRefusal(refusal);
    const workspaceId = flagValue(argv, "--workspace")?.trim() ?? "";
    const configured = env.STAGING_WORKSPACE_ID?.trim() ?? "";
    if (!workspaceId || !configured || workspaceId !== configured) {
      throw new ScriptRefusal("Refusing to run: --workspace does not match the configured staging workspace.");
    }
    const apply = argv.includes("--apply");
    const confirm = flagValue(argv, "--confirm")?.trim() ?? "";
    if (apply && !confirm) {
      throw new ScriptRefusal("Refusing to run: --confirm must match the current database.");
    }
    db = await connect(env.DATABASE_URL ?? "");
    const current = await currentDatabase(db);
    if (current !== STAGING_DATABASE) throw new ScriptRefusal('Refusing to run: current_database() must be exactly "sho_staging".');
    const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!workspace) throw new ScriptRefusal("Refusing to run: the staging workspace was not found.");
    if (!apply) {
      await refuseIfUnsafe(db, workspaceId, false);
      return 0;
    }
    if (confirm !== current) {
      throw new ScriptRefusal("Refusing to run: --confirm must match the current database.");
    }
    await db.$transaction(async (tx) => {
      const plan = await buildPlan(tx, workspaceId);
      const safety = await safetyReport(tx, plan);
      const blocked = blockMessage(safety);
      if (blocked) throw new ScriptRefusal(blocked);
      await applyDeletes(tx, plan);
      console.log(`${formatPlan(workspaceId, true, plan)}\n${formatSafety(safety)}`);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return 0;
  } catch (err) {
    const message = err instanceof ScriptRefusal ? err.message : scrub("The script failed; no changes were committed.", secrets);
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
