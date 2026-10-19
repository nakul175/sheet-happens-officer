// Move timestamps on rows a story spec created. Local test databases only.
// A remote, staging, preview, or production database makes the test fail. It is never updated.
import { execFileSync } from "node:child_process";
import { BASE_URL, expect } from "../support";

/** DATABASE_URL from the process environment only. The .env file is never read. A remote value is still refused below. */
function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "";
}

const TOKEN = /^[A-Za-z0-9_-]+$/;

/** Connection string for a local test database. Throws for any other database. */
export function localTestDatabase(): string {
  const raw = databaseUrl();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("DATABASE_URL is missing or not a URL. This test will not change a row."); }
  const host = parsed.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`Refusing to change a row: DATABASE_URL host is ${host}.`);
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (/prod|staging|preview/i.test(name)) throw new Error("Refusing to change a row against a production, staging, or preview database.");
  if (name !== "taskboard" && name !== "sho" && name !== "sho_viewport" && !/test/i.test(name)) {
    throw new Error(`Refusing to change a row: database "${name}" is not a local test database.`);
  }
  const app = new URL(BASE_URL).hostname;
  if (app !== "localhost" && app !== "127.0.0.1" && app !== "::1") {
    throw new Error("Refusing to change a row while the app is not on localhost.");
  }
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

/** A failed execFileSync message repeats the command line, which holds the connection string. Only psql's stderr is kept. */
function psql(sql: string) {
  try {
    return execFileSync("psql", [localTestDatabase(), "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`psql failed: ${stderr || "no stderr"}`);
  }
}

function id(value: string) {
  if (!TOKEN.test(value)) throw new Error("Refusing to change a row: the id is not a single token.");
  return value;
}

function stamp(days: number) {
  return `timestamptz '${new Date(Date.now() - days * 86400_000).toISOString()}'`;
}

/** Age one deal this test created: the project, its tasks, its action log and its notes. */
export function ageDeal(projectId: string, days: number) {
  const deal = id(projectId);
  const when = stamp(days);
  expect(psql(`UPDATE "Project" SET "createdAt" = ${when}, "stageChangedAt" = ${when} WHERE id = '${deal}'`)).toContain("UPDATE 1");
  psql(`UPDATE "Task" SET "createdAt" = ${when}, "updatedAt" = ${when} WHERE "projectId" = '${deal}'`);
  psql(`UPDATE "ActionLog" SET "createdAt" = ${when} WHERE "projectId" = '${deal}'`);
  psql(`UPDATE "Note" SET "createdAt" = ${when} WHERE "projectId" = '${deal}'`);
}

/** Age one task this test created, so the review can list it as an old idea. */
export function ageTaskCreated(taskId: string, days: number) {
  expect(psql(`UPDATE "Task" SET "createdAt" = ${stamp(days)} WHERE id = '${id(taskId)}'`)).toContain("UPDATE 1");
}

/** Age one notification this test created, for this recipient only. */
export function ageNotification(noteId: string, recipientId: string, days: number) {
  const out = psql(`UPDATE "Notification" SET "createdAt" = ${stamp(days)} WHERE id = '${id(noteId)}' AND "recipientId" = '${id(recipientId)}'`);
  expect(out).toContain("UPDATE 1");
}

/** POST /api/jobs/<name> on the local server. Refuses a remote host before the request is sent. */
export async function runLocalJob(name: string) {
  const secret = process.env.JOB_SECRET ?? "";
  if (secret.length < 16) throw new Error("Set JOB_SECRET (16 characters or more) to run the scheduled job on the local server.");
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Refusing to run a job: the name is not a single token.");
  localTestDatabase();
  const res = await fetch(new URL(`/api/jobs/${name}`, BASE_URL), { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  const text = await res.text();
  expect(text.includes(secret)).toBe(false);
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as { job?: string; status?: string };
}
