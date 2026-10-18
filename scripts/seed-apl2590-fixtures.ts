// APL-2590 AC23: fixture "comments-basic v1.2" for SHO-US-19.1 (comments with @mentions).
// Idempotent (upserts on fixed ids / unique emails). Touches only ZZ-TEST rows. Never prints a secret.
//
// Run:  SEED_TARGET=test|staging SHO_QA_PASS=<shared nakul17+ password> DATABASE_URL=... npx tsx scripts/seed-apl2590-fixtures.ts
// Refuses: any target not explicitly test/staging, NODE_ENV=production, prod hosts, prod-like DB names, and DBs whose name is not allow-listed.
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "../src/generated/prisma/client";

const PROD_HOSTS = ["139.59.45.166", "sho.139-59-45-166.sslip.io", "168.144.144.69", "app.sheethappensofficer.com"];
const ALLOWED_DB: Record<string, string[]> = { test: ["sho_test"], staging: ["sho_staging"] };

export function guard(env: Record<string, string | undefined> = process.env): string {
  if (env.NODE_ENV === "production") throw new Error("NODE_ENV=production. Refusing.");
  const target = env.SEED_TARGET ?? "";
  if (!(target in ALLOWED_DB)) throw new Error("Set SEED_TARGET=test or staging. Refusing.");
  const raw = env.DATABASE_URL ?? "";
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("DATABASE_URL missing or invalid. Refusing."); }
  const host = u.hostname.toLowerCase();
  const dbName = u.pathname.replace(/^\//, "").toLowerCase();
  if (PROD_HOSTS.includes(host) || /prod/.test(host) || /prod|defaultdb/.test(dbName) || /prod/.test(u.username))
    throw new Error("Production-like target. Refusing.");
  if (!ALLOWED_DB[target].includes(dbName)) throw new Error(`DB "${dbName}" is not an allowed ${target} DB. Refusing.`);
  if (target === "test" && !["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Test target must be local. Refusing.");
  return target;
}

function hash(pw: string) {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

const P = "zz_apl2590_";
const email = (role: string) => `nakul17+apl2590-${role}@gmail.com`;
type Role = "lead" | "admin" | "worker" | "writer" | "viewer" | "outsider" | "inactive";
const USERS: { role: Role; orgRole: "MEMBER" | "ADMIN"; ops?: "LEADER" | "EDITOR" | "VIEWER"; inactive?: boolean }[] = [
  { role: "lead", orgRole: "MEMBER", ops: "LEADER" },
  { role: "admin", orgRole: "ADMIN", ops: "EDITOR" },
  { role: "worker", orgRole: "MEMBER", ops: "EDITOR" },
  { role: "writer", orgRole: "MEMBER", ops: "EDITOR" },
  { role: "viewer", orgRole: "MEMBER", ops: "VIEWER" },
  { role: "outsider", orgRole: "MEMBER" },
  { role: "inactive", orgRole: "MEMBER", ops: "EDITOR", inactive: true },
];

export async function seedCommentsBasic(db: PrismaClient, opts: { password: string; workspaceId?: string }) {
  const pw = opts.password;
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error("Set SHO_QA_PASS (8+ chars, letter + number).");
  const ws = opts.workspaceId
    ? await db.workspace.findUniqueOrThrow({ where: { id: opts.workspaceId } })
    : await db.workspace.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const ph = hash(pw);
  const now = new Date();
  const ids: Record<string, string> = {};
  for (const u of USERS) {
    const data = { name: `ZZ-TEST ${u.role}`, passwordHash: ph, emailVerifiedAt: now, orgRole: u.orgRole,
      deactivatedAt: u.inactive ? now : null, tempPasswordAt: null };
    const row = await db.user.upsert({ where: { email: email(u.role) }, update: data,
      create: { id: P + u.role, workspaceId: ws.id, email: email(u.role), ...data } });
    if (!row.name.startsWith("ZZ-TEST")) throw new Error("non ZZ-TEST user row");
    ids[u.role] = row.id;
  }
  async function project(key: string, name: string, archived: boolean) {
    const id = P + key;
    await db.project.upsert({ where: { id }, update: { name, archivedAt: archived ? now : null },
      create: { id, workspaceId: ws.id, name, archivedAt: archived ? now : null } });
    const sec = { todo: id + "_todo", done: id + "_done" };
    await db.section.upsert({ where: { id: sec.todo }, update: {}, create: { id: sec.todo, projectId: id, name: "ZZ-TEST To do", position: 0 } });
    await db.section.upsert({ where: { id: sec.done }, update: {}, create: { id: sec.done, projectId: id, name: "ZZ-TEST Done", position: 1, isDone: true } });
    return { id, todo: sec.todo };
  }
  const ops = await project("ops", "ZZ-TEST Ops", false);
  const old = await project("old", "ZZ-TEST Old", true);
  for (const u of USERS) if (u.ops) await db.projectMember.upsert({
    where: { projectId_userId: { projectId: ops.id, userId: ids[u.role] } }, update: { role: u.ops },
    create: { projectId: ops.id, userId: ids[u.role], role: u.ops } });
  await db.projectMember.deleteMany({ where: { projectId: ops.id, userId: ids.outsider } });
  await db.projectMember.upsert({ where: { projectId_userId: { projectId: old.id, userId: ids.lead } }, update: { role: "LEADER" },
    create: { projectId: old.id, userId: ids.lead, role: "LEADER" } });
  async function task(key: string, title: string, p: { id: string; todo: string }, parentId: string | null, pos: number) {
    const id = P + key;
    const base = { title, sectionId: p.todo, parentId, assigneeId: ids.worker, deletedAt: null, deletedById: null, completedAt: null };
    await db.task.upsert({ where: { id }, update: base,
      create: { id, workspaceId: ws.id, projectId: p.id, createdById: ids.lead, position: pos, ...base } });
    return id;
  }
  const t1 = await task("t1", "ZZ-TEST T1", ops, null, 1);
  await task("t1_1", "ZZ-TEST T1.1", ops, t1, 2);
  // T9 in Old: assigned to lead (Leader of Old).
  await task("t9", "ZZ-TEST T9", old, null, 1);
  await db.task.update({ where: { id: P + "t9" }, data: { assigneeId: ids.lead } });

  const users = await db.user.findMany({ where: { email: { startsWith: "nakul17+apl2590-" } }, select: { id: true, email: true, name: true, orgRole: true, deactivatedAt: true }, orderBy: { email: "asc" } });
  const projects = await db.project.findMany({ where: { id: { in: [ops.id, old.id] } }, select: { id: true, name: true, archivedAt: true, members: { select: { userId: true, role: true } } } });
  const tasks = await db.task.findMany({ where: { id: { startsWith: P } }, select: { id: true, title: true, projectId: true, parentId: true, assigneeId: true } });
  return {
    workspaceId: ws.id,
    users: users.map((u) => ({ ...u, active: !u.deactivatedAt, deactivatedAt: undefined })),
    projects,
    tasks,
  };
}

async function main() {
  const target = guard();
  const pw = process.env.SHO_QA_PASS ?? "";
  const db = new PrismaClient();
  try {
    const summary = await seedCommentsBasic(db, { password: pw, workspaceId: process.env.SEED_WORKSPACE_ID });
    console.log(JSON.stringify({ target, ...summary }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("seed-apl2590-fixtures.ts") || entry.endsWith("seed-apl2590-fixtures.js")) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
