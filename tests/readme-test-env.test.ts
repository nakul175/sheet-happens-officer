// APL-2654: the README Test section must tell a developer which env vars the vitest process needs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MISSING_ENV = /Environment variable not found/;
const PLACEHOLDER_SECRET = /replace-with|placeholder|changeme|example-token/i;

function testSection(readme: string): string {
  const start = readme.indexOf("\n## Test\n");
  if (start < 0) throw new Error("README has no Test section");
  const rest = readme.slice(start + 1);
  const next = rest.slice("## Test\n".length).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next + "## Test\n".length);
}

function bashBlock(section: string): string {
  const block = section.match(/```bash\n([\s\S]*?)```/);
  if (!block) throw new Error("Test section has no bash block");
  return block[1];
}

/** Leading KEY=value pairs, then the command. Quotes are kept out of the value. */
function splitEnv(command: string): { env: Record<string, string>; rest: string } {
  const env: Record<string, string> = {};
  let rest = command.trim();
  for (;;) {
    const match = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))\s*/);
    if (!match) break;
    env[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    rest = rest.slice(match[0].length);
  }
  return { env, rest };
}

function commands(section: string): { env: Record<string, string>; rest: string }[] {
  return bashBlock(section)
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s*&\s*$/, ""))
    .filter(Boolean)
    .map(splitEnv);
}

function purposes(section: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of section.split("\n")) {
    const row = line.match(/^\|\s*`([A-Z0-9_]+)`\s*\|\s*(.*?)\s*\|\s*$/);
    if (row) found[row[1]] = row[2];
  }
  return found;
}

function npmTestEnv(section: string): Record<string, string> {
  const command = commands(section).find((item) => item.rest === "npm test");
  if (!command) throw new Error('Test section has no "npm test" command');
  return command.env;
}

/** Start the same client the suite imports, with only the env the README's npm test line sets. */
function startSuite(env: Record<string, string>): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "sho-readme-"));
  const file = join(dir, "probe.mts");
  const client = join(process.cwd(), "src/generated/prisma/client.ts");
  writeFileSync(
    file,
    `import { PrismaClient } from ${JSON.stringify(client)};
const db = new PrismaClient();
let missingEnv = false;
try {
  await db.$connect();
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (${MISSING_ENV.toString()}.test(message)) {
    console.error(message);
    missingEnv = true;
  }
} finally {
  await db.$disconnect().catch(() => undefined);
}
if (missingEnv || !process.env.DATABASE_URL || !process.env.JOB_SECRET) {
  if (!missingEnv) console.error("missing-env error");
  process.exit(2);
}
let host = "";
try { host = new URL(process.env.DATABASE_URL).hostname; } catch { host = ""; }
console.log("using-host=" + host);
console.log("suite-started");
`,
  );
  try {
    // npm test sets NODE_ENV=test itself; the README does not have to list it.
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      NODE_ENV: "test",
    };
    for (const [key, value] of Object.entries(env)) childEnv[key] = value;
    const result = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), [file], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: "utf8",
      timeout: 20000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function connectionProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not a connection string";
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return "not a postgres placeholder";
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return `host ${url.hostname} is not local`;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!/^(USER|user)$/.test(user) || !/^(PASSWORD|password)$/.test(password)) return "credentials are not placeholders";
  return null;
}

function looksLikeRealSecret(value: string): boolean {
  if (PLACEHOLDER_SECRET.test(value)) return false;
  if (/^[A-Fa-f0-9]{16,}$/.test(value)) return true;
  return value.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
}

/** Problems a reviewer would raise against the published Test section. Empty means placeholders only. */
function reviewProblems(section: string): string[] {
  const problems: string[] = [];
  for (const pattern of [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{16,}/,
    /\bsk_live_[A-Za-z0-9]+/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  ]) {
    if (pattern.test(section)) problems.push(`secret pattern ${pattern}`);
  }
  for (const raw of section.match(/postgres(?:ql)?:\/\/[^\s`'"]+/g) ?? []) {
    const problem = connectionProblem(raw);
    if (problem) problems.push(`connection string: ${problem}`);
  }
  for (const command of commands(section)) {
    for (const [key, value] of Object.entries(command.env)) {
      if (key === "DATABASE_URL") {
        const problem = connectionProblem(value);
        if (problem) problems.push(`${key}: ${problem}`);
        continue;
      }
      if (key === "JOB_SECRET") {
        if (!PLACEHOLDER_SECRET.test(value) || value.length < 16 || looksLikeRealSecret(value)) problems.push(`${key} is not a placeholder`);
        continue;
      }
      if (looksLikeRealSecret(value)) problems.push(`${key} looks like a real secret`);
    }
  }
  return problems;
}

describe("README tells a developer which env vars the test process needs", () => {
  const readme = readFileSync("README.md", "utf8");
  const section = testSection(readme);

  it("Following the README runs the tests", () => {
    const purpose = purposes(section);
    for (const name of ["DATABASE_URL", "JOB_SECRET"] as const) {
      expect(purpose[name], `${name} purpose`).toBeTruthy();
      expect(purpose[name].split("\n")).toHaveLength(1);
      expect(purpose[name]).not.toMatch(/<br\s*\/?>/i);
    }

    const env = npmTestEnv(section);
    expect(env.DATABASE_URL).toBeTruthy();
    expect(env.JOB_SECRET).toBeTruthy();

    const started = startSuite(env);
    expect(started.output).not.toMatch(MISSING_ENV);
    expect(started.output).not.toMatch(/missing-env error/);
    expect(started.output).toContain("using-host=localhost");
    expect(started.output).toContain("suite-started");
    expect(started.status).toBe(0);

    const withoutDatabase = { ...env };
    delete withoutDatabase.DATABASE_URL;
    const missed = startSuite(withoutDatabase);
    expect(missed.output).toMatch(MISSING_ENV);
    expect(missed.status).not.toBe(0);
  });

  it("No secret values are published", () => {
    expect(reviewProblems(section)).toEqual([]);
    expect(reviewProblems(readme)).toEqual([]);
  });
});
