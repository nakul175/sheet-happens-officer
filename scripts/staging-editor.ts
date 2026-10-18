// APL-2682. Idempotently ensures the throwaway staging Editor exists.
//
// The person zz-test-editor@example.invalid is an ordinary active, verified member and
// Editor of the "ZZ-TEST QA" project only. The project and its default sections are
// created when they are missing. An existing password is never replaced.
//
// The password is read from STAGING_EDITOR_PASSWORD_FILE (the staging secret file)
// or, if that is unset, from STAGING_EDITOR_PASSWORD. It is never printed.
//
// Refuses production before opening a connection: the database host or name matches
// PROD_DB_HOST / PROD_DB_NAME when those are set, or the host is app.sheethappensofficer.com.
// Requires an explicit staging confirmation: --confirm-staging or SHO_STAGING_CONFIRM=1.
//
//   SHO_STAGING_CONFIRM=1 STAGING_EDITOR_PASSWORD_FILE=/path/to/secret \
//     npx tsx scripts/staging-editor.ts --confirm-staging

import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { passwordField } from "../src/lib/schemas";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";

export const EDITOR_EMAIL = "zz-test-editor@example.invalid";
export const QA_PROJECT_NAME = "ZZ-TEST QA";
// Same three sections createProject writes (src/lib/projects.ts). The last one is Done.
const DEFAULT_SECTIONS = ["To do", "In progress", "Done"];
const PROD_APP_HOST = "app.sheethappensofficer.com";

export class ScriptRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptRefusal";
  }
}

export type DbConnect = (databaseUrl: string) => PrismaClient | Promise<PrismaClient>;

type DatabaseTarget = { host: string; name: string };

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isProdAppHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === PROD_APP_HOST || normalized.endsWith(`.${PROD_APP_HOST}`);
}

function parseTarget(raw: string): DatabaseTarget | null {
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

/** A refusal message, or null when this environment is not production. Never includes the URL. */
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

async function resolveWorkspace(db: PrismaClient, workspaceId: string | undefined) {
  if (workspaceId) {
    const row = await db.workspace.findUnique({ where: { id: workspaceId } });
    if (!row) throw new ScriptRefusal("Refusing to run: STAGING_WORKSPACE_ID does not match a workspace.");
    return row;
  }
  const row = await db.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  if (!row) throw new ScriptRefusal("Refusing to run: no workspace exists.");
  return row;
}

export async function ensureStagingEditor(
  db: PrismaClient,
  opts: { password: string | null; workspaceId?: string },
): Promise<{ userId: string; projectId: string; passwordSet: boolean }> {
  const workspace = await resolveWorkspace(db, opts.workspaceId);
  const already = await db.user.findUnique({ where: { email: EDITOR_EMAIL }, select: { id: true } });
  if (!already && !opts.password) throw new ScriptRefusal("Set STAGING_EDITOR_PASSWORD or STAGING_EDITOR_PASSWORD_FILE.");
  // Hash outside the transaction. The stored hash is written only when the person is created.
  const passwordHash = !already && opts.password ? await hashWithApp(opts.password) : null;

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

    let user = await tx.user.findUnique({ where: { email: EDITOR_EMAIL } });
    let passwordSet = false;
    if (!user) {
      if (!passwordHash) throw new ScriptRefusal("Set STAGING_EDITOR_PASSWORD or STAGING_EDITOR_PASSWORD_FILE.");
      user = await tx.user.create({
        data: {
          workspaceId: workspace.id,
          email: EDITOR_EMAIL,
          name: "ZZ Test Editor",
          passwordHash,
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
      if (user.workspaceId !== workspace.id) data.workspaceId = workspace.id;
      if (Object.keys(data).length) user = await tx.user.update({ where: { id: user.id }, data });
    }

    const memberships = await tx.projectMember.findMany({ where: { userId: user.id } });
    let onProject = false;
    for (const membership of memberships) {
      if (membership.projectId !== project.id) {
        await tx.projectMember.delete({ where: { projectId_userId: { projectId: membership.projectId, userId: user.id } } });
        continue;
      }
      onProject = true;
      if (membership.role !== "EDITOR") {
        await tx.projectMember.update({
          where: { projectId_userId: { projectId: membership.projectId, userId: user.id } },
          data: { role: "EDITOR" },
        });
      }
    }
    if (!onProject) {
      await tx.projectMember.create({ data: { projectId: project.id, userId: user.id, role: "EDITOR" } });
    }
    return { userId: user.id, projectId: project.id, passwordSet };
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
    db = await connect(env.DATABASE_URL ?? "");
    const existing = await db.user.findUnique({ where: { email: EDITOR_EMAIL }, select: { id: true } });
    let password: string | null = null;
    if (!existing) {
      password = checkedPassword(readPassword(env));
      secrets.push(password);
    }
    const result = await ensureStagingEditor(db, {
      password,
      workspaceId: env.STAGING_WORKSPACE_ID?.trim() || undefined,
    });
    console.log(
      [
        "staging editor ready",
        `user: ${result.userId}`,
        `project: ${result.projectId}`,
        "orgRole: MEMBER",
        "projectRole: EDITOR",
        `password: ${result.passwordSet ? "set" : "unchanged"}`,
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
