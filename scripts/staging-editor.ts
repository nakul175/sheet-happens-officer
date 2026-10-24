// APL-2682. Idempotently ensures the throwaway staging Editor exists.
//
// The person zz-test-editor@example.invalid is an ordinary active, verified member and
// Editor of the "ZZ-TEST QA" project only. zz-test-leader@example.invalid is a different
// person: an active, verified member and the Leader of that project. A deactivated or
// unverified Leader is repaired. The project and its default sections are created when
// they are missing. An existing password is never replaced.
//
// The password is read from STAGING_EDITOR_PASSWORD_FILE (the staging secret file)
// or, if that is unset, from STAGING_EDITOR_PASSWORD. It is never printed.
//
// Refuses before opening a connection unless the database name is exactly sho_staging.
// The comparison is case-sensitive and applies to every host, including localhost,
// 127.0.0.1 and ::1. SHO_STAGING, Sho_Staging, sho, and every other spelling are refused.
// A tunnel that presents another database as localhost/<prodname> is refused. This does
// not depend on PROD_DB_HOST or PROD_DB_NAME. Those still refuse as well. PROD_DB_NAME is
// compared without regard to case, so SHO_PROD matches sho_prod. The sho_staging allowlist
// stays an exact, case-sensitive match. The host app.sheethappensofficer.com
// is always refused. A URL that sets host or dbname in the query is refused, so those
// parameters cannot replace the host or database in the authority. Only named connection
// settings and one lowercase schema identifier are allowed; protocols, fragments, repeated
// keys and full decoded database path suffixes are refused. After connecting, current_database()
// and current_schema() must match before any mutation. An existing fixture in another
// workspace is refused rather than moved or stripped of that workspace's roles.
//
// Vitest may use the database name sho_test only when NODE_ENV is test and the host is
// loopback: localhost, ::1, or an address in 127.0.0.0/8. CI reaches Postgres at localhost
// (the workflow service is published on localhost, not under a service hostname), so no
// other host is listed. A remote host whose database is sho_test is refused. The exception
// does not skip the production host, PROD_DB_NAME, query-parameter, or confirmation checks.
// Requires an explicit staging confirmation: --confirm-staging or SHO_STAGING_CONFIRM=1.
// STAGING_WORKSPACE_ID is required. An unset id refuses before connecting; there is no
// fallback to the oldest workspace.
//
//   SHO_STAGING_CONFIRM=1 STAGING_WORKSPACE_ID=<id> STAGING_EDITOR_PASSWORD_FILE=/path/to/secret \
//     npx tsx scripts/staging-editor.ts --confirm-staging

import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { passwordField } from "../src/lib/schemas";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";

export const EDITOR_EMAIL = "zz-test-editor@example.invalid";
export const LEADER_EMAIL = "zz-test-leader@example.invalid";
export const QA_PROJECT_NAME = "ZZ-TEST QA";
// Same three sections createProject writes (src/lib/projects.ts). The last one is Done.
const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];
const PROD_APP_HOST = "app.sheethappensofficer.com";
const STAGING_DB_NAME = "sho_staging";
// Exact name the vitest harness uses. Allowed only when NODE_ENV is test and the host is loopback.
const TEST_DB_NAME = "sho_test";
// libpq lets these query keys replace the host and database. Refuse them instead of applying them.
const OVERRIDE_PARAMS = ["host", "hostaddr", "hostname", "dbname", "database"];

export class ScriptRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptRefusal";
  }
}

export type DbConnect = (databaseUrl: string) => PrismaClient | Promise<PrismaClient>;

type DatabaseTarget = { host: string; name: string; schema: string };

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isProdAppHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === PROD_APP_HOST || normalized.endsWith(`.${PROD_APP_HOST}`);
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) && parts[0] === "127";
}

/** WHATWG URL parse. libpq host and dbname query keys are refused, not applied. */
function parseDatabaseUrl(raw: string): DatabaseTarget | { refusal: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { refusal: "Refusing to run: the database URL is not valid." };
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash) {
    return { refusal: "Refusing to run: invalid database URL protocol or fragment." };
  }
  const rawKeys = [...url.searchParams.keys()];
  const keys = rawKeys.map((key) => key.toLowerCase());
  if (keys.some((key) => OVERRIDE_PARAMS.includes(key))) {
    return { refusal: "Refusing to run: the database URL must not set host or dbname in the query." };
  }
  const allowed = new Set(["schema", "sslmode", "connection_limit", "pool_timeout", "connect_timeout"]);
  if (rawKeys.some((key) => !allowed.has(key)) || new Set(rawKeys).size !== rawKeys.length) {
    return { refusal: "Refusing to run: database URL overrides or repeated parameters are not allowed." };
  }
  const schema = url.searchParams.get("schema") ?? "public";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    return { refusal: "Refusing to run: invalid database schema." };
  }
  const host = normalizeHost(url.hostname);
  let name: string;
  try { name = decodeURIComponent(url.pathname.slice(1)); } catch {
    return { refusal: "Refusing to run: the database URL is not valid." };
  }
  if (!host || !name) return { refusal: "Refusing to run: the database URL is not valid." };
  return { host, name, schema };
}

function targetRefusal(target: DatabaseTarget, prodHost: string, prodName: string, allowTestDb: boolean): string | null {
  if (isProdAppHost(target.host) || (prodHost && target.host === prodHost)) {
    return "Refusing to run: the database host is production.";
  }
  // Deny list only. The sho_staging allowlist below stays case-sensitive.
  if (prodName && target.name.toLowerCase() === prodName.toLowerCase()) {
    return "Refusing to run: the database name is production.";
  }
  const testDb = allowTestDb && target.name === TEST_DB_NAME && isLoopback(target.host);
  if (target.name !== STAGING_DB_NAME && !testDb) {
    return "Refusing to run: the database name must be exactly sho_staging.";
  }
  return null;
}

/** A refusal message, or null when this environment is allowed. Never includes the URL. */
export function productionRefusal(env: NodeJS.ProcessEnv): string | null {
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl) return "Refusing to run: DATABASE_URL is not set.";
  const urls = [databaseUrl, env.DIRECT_DATABASE_URL].filter((value): value is string => !!value);
  const prodHost = normalizeHost(env.PROD_DB_HOST ?? "");
  const prodName = (env.PROD_DB_NAME ?? "").trim();
  for (const raw of urls) {
    if (raw.toLowerCase().includes(PROD_APP_HOST)) return "Refusing to run: the database host is production.";
    const target = parseDatabaseUrl(raw);
    if ("refusal" in target) return target.refusal;
    const refusal = targetRefusal(target, prodHost, prodName, env.NODE_ENV === "test");
    if (refusal) return refusal;
  }
  const appUrl = env.APP_URL ?? "";
  if (appUrl) {
    if (appUrl.toLowerCase().includes(PROD_APP_HOST)) return "Refusing to run: the app host is production.";
    try {
      if (isProdAppHost(new URL(appUrl).hostname)) return "Refusing to run: the app host is production.";
    } catch {
      // An unparseable app URL is not a database target.
    }
  }
  return null;
}

function confirmed(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  return argv.includes("--confirm-staging") || env.SHO_STAGING_CONFIRM === "1";
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

function readPassword(env: NodeJS.ProcessEnv): string {
  const file = env.STAGING_EDITOR_PASSWORD_FILE?.trim();
  if (file) {
    try {
      const info = statSync(file);
      if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error("unreadable");
      const password = readFileSync(file, "utf8").trim();
      if (!password) throw new Error("empty");
      return password;
    } catch (err) {
      if (err instanceof Error && err.message === "empty") throw new Error("STAGING_EDITOR_PASSWORD_FILE is empty.");
      throw new Error("Could not read STAGING_EDITOR_PASSWORD_FILE.");
    }
  }
  const fromEnv = env.STAGING_EDITOR_PASSWORD;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  throw new Error("Set STAGING_EDITOR_PASSWORD or STAGING_EDITOR_PASSWORD_FILE.");
}

function checkedPassword(password: string): string {
  const parsed = passwordField.safeParse(password);
  if (!parsed.success) throw new Error("The staging editor password does not meet the account rules.");
  return parsed.data;
}

async function hashWithApp(password: string): Promise<string> {
  // Loaded only after the production guard, so a refused run does not open the app database client.
  const { hashPassword } = await import("../src/lib/auth");
  return hashPassword(password);
}

export function defaultConnect(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl, errorFormat: "minimal" });
}

async function resolveWorkspace(db: PrismaClient, workspaceId: string) {
  const row = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!row) throw new ScriptRefusal("Refusing to run: STAGING_WORKSPACE_ID does not match a workspace.");
  return row;
}

async function ensurePerson(
  tx: Prisma.TransactionClient,
  opts: {
    email: string;
    name: string;
    workspaceId: string;
    projectId: string;
    role: "EDITOR" | "LEADER";
    passwordHash: string | null;
  },
): Promise<{ id: string; passwordSet: boolean }> {
  let user = await tx.user.findUnique({ where: { email: opts.email } });
  let passwordSet = false;
  if (!user) {
    if (!opts.passwordHash) throw new ScriptRefusal("Set STAGING_EDITOR_PASSWORD or STAGING_EDITOR_PASSWORD_FILE.");
    user = await tx.user.create({
      data: {
        workspaceId: opts.workspaceId,
        email: opts.email,
        name: opts.name,
        passwordHash: opts.passwordHash,
        orgRole: "MEMBER",
        emailVerifiedAt: new Date(),
      },
    });
    passwordSet = true;
  } else {
    const data: Prisma.UserUncheckedUpdateInput = {};
    if (user.orgRole !== "MEMBER") data.orgRole = "MEMBER";
    if (!user.emailVerifiedAt) data.emailVerifiedAt = new Date();
    if (user.deactivatedAt) data.deactivatedAt = null;
    if (user.workspaceId !== opts.workspaceId) {
      throw new ScriptRefusal("Refusing to run: an existing fixture belongs to another workspace.");
    }
    if (Object.keys(data).length) user = await tx.user.update({ where: { id: user.id }, data });
  }

  if (opts.role === "LEADER") {
    const other = await tx.projectMember.findFirst({
      where: { projectId: opts.projectId, role: "LEADER", NOT: { userId: user.id } },
    });
    if (other) {
      await tx.projectMember.update({
        where: { projectId_userId: { projectId: opts.projectId, userId: other.userId } },
        data: { role: "EDITOR" },
      });
    }
  }

  const memberships = await tx.projectMember.findMany({ where: { userId: user.id } });
  let onProject = false;
  for (const membership of memberships) {
    if (membership.projectId !== opts.projectId) {
      await tx.projectMember.delete({ where: { projectId_userId: { projectId: membership.projectId, userId: user.id } } });
      continue;
    }
    onProject = true;
    if (membership.role !== opts.role) {
      await tx.projectMember.update({
        where: { projectId_userId: { projectId: membership.projectId, userId: user.id } },
        data: { role: opts.role },
      });
    }
  }
  if (!onProject) {
    await tx.projectMember.create({ data: { projectId: opts.projectId, userId: user.id, role: opts.role } });
  }
  return { id: user.id, passwordSet };
}

export async function ensureStagingEditor(
  db: PrismaClient,
  opts: { password: string | null; workspaceId: string },
): Promise<{ userId: string; leaderId: string; projectId: string; editorPasswordSet: boolean; leaderPasswordSet: boolean }> {
  const workspace = await resolveWorkspace(db, opts.workspaceId);
  const existing = await db.user.findMany({
    where: { email: { in: [EDITOR_EMAIL, LEADER_EMAIL] } },
    select: { email: true, workspaceId: true },
  });
  if (existing.some((row) => row.workspaceId !== opts.workspaceId)) {
    throw new ScriptRefusal("Refusing to run: an existing fixture belongs to another workspace.");
  }
  const have = new Set(existing.map((row) => row.email));
  if ((!have.has(EDITOR_EMAIL) || !have.has(LEADER_EMAIL)) && !opts.password) {
    throw new ScriptRefusal("Set STAGING_EDITOR_PASSWORD or STAGING_EDITOR_PASSWORD_FILE.");
  }
  // Hash outside the transaction. The stored hash is written only when a person is created.
  const passwordHash = opts.password ? await hashWithApp(opts.password) : null;

  return db.$transaction(async (tx) => {
    let project = await tx.project.findFirst({
      where: { workspaceId: workspace.id, name: QA_PROJECT_NAME },
      orderBy: { createdAt: "asc" },
    });
    if (!project) {
      project = await tx.project.create({
        data: { workspaceId: workspace.id, name: QA_PROJECT_NAME, typeId: "wst_project" },
      });
    }
    if ((await tx.section.count({ where: { projectId: project.id } })) === 0) {
      for (const [position, name] of DEFAULT_SECTIONS.entries()) {
        await tx.section.create({
          data: { projectId: project.id, name, position, isDone: position === DEFAULT_SECTIONS.length - 1 },
        });
      }
    }

    const editor = await ensurePerson(tx, {
      email: EDITOR_EMAIL,
      name: "ZZ Test Editor",
      workspaceId: workspace.id,
      projectId: project.id,
      role: "EDITOR",
      passwordHash,
    });
    const leader = await ensurePerson(tx, {
      email: LEADER_EMAIL,
      name: "ZZ Test Leader",
      workspaceId: workspace.id,
      projectId: project.id,
      role: "LEADER",
      passwordHash,
    });
    if (leader.id === editor.id) {
      throw new ScriptRefusal("Refusing to run: the ZZ-TEST Leader must be a different user from the Editor.");
    }
    return {
      userId: editor.id,
      leaderId: leader.id,
      projectId: project.id,
      editorPasswordSet: editor.passwordSet,
      leaderPasswordSet: leader.passwordSet,
    };
  });
}

export async function runStagingEditor(env: NodeJS.ProcessEnv, argv: readonly string[], connect: DbConnect = defaultConnect): Promise<number> {
  const secrets = [env.DATABASE_URL ?? "", env.DIRECT_DATABASE_URL ?? "", env.STAGING_EDITOR_PASSWORD ?? ""];
  let db: PrismaClient | null = null;
  try {
    const refusal = productionRefusal(env);
    if (refusal) throw new ScriptRefusal(refusal);
    if (!confirmed(env, argv)) {
      throw new ScriptRefusal("Refusing to run without staging confirmation (--confirm-staging or SHO_STAGING_CONFIRM=1).");
    }
    const workspaceId = env.STAGING_WORKSPACE_ID?.trim() ?? "";
    if (!workspaceId) throw new ScriptRefusal("Refusing to run: STAGING_WORKSPACE_ID is not set.");
    db = await connect(env.DATABASE_URL ?? "");
    const target = parseDatabaseUrl(env.DATABASE_URL ?? "");
    if ("refusal" in target) throw new ScriptRefusal(target.refusal);
    const actual = await db.$queryRaw<Array<{ database: string; schema: string | null }>>`SELECT current_database() AS database, current_schema() AS schema`;
    if (actual.length !== 1 || actual[0]?.database !== target.name || actual[0]?.schema !== target.schema) {
      throw new ScriptRefusal("Refusing to run: connected database or schema does not match the guarded target.");
    }
    const existing = await db.user.findMany({
      where: { email: { in: [EDITOR_EMAIL, LEADER_EMAIL] } },
      select: { email: true },
    });
    const have = new Set(existing.map((row) => row.email));
    let password: string | null = null;
    if (!have.has(EDITOR_EMAIL) || !have.has(LEADER_EMAIL)) {
      password = checkedPassword(readPassword(env));
      secrets.push(password);
    }
    const result = await ensureStagingEditor(db, { password, workspaceId });
    console.log(
      [
        "staging editor ready",
        `user: ${result.userId}`,
        `leader: ${result.leaderId}`,
        `project: ${result.projectId}`,
        "orgRole: MEMBER",
        "projectRole: EDITOR",
        "leaderRole: LEADER",
        `editorPassword: ${result.editorPasswordSet ? "set" : "unchanged"}`,
        `leaderPassword: ${result.leaderPasswordSet ? "set" : "unchanged"}`,
      ].join("\n"),
    );
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
  runStagingEditor(process.env, process.argv).then((code) => {
    process.exit(code);
  });
}
