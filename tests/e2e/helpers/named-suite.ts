// Runs a named vitest list from a story spec and refuses a skipped, .only or quarantined test.
// The child uses a validated loopback server/database. Provider and sign-in secrets are not copied.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const MARKER = /\b(?:it|test|describe)\.(?:skip|only|fixme|todo)\b|\b(?:xit|xdescribe|xtest)\s*\(|\bquarantine\b/;

export type SuiteReport = {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: { name: string; assertionResults: { status: string; fullName: string }[] }[];
};

type SuiteTarget = { databaseUrl?: string; baseUrl?: string; outboxDir?: string };

export function namedSuiteEnv(targets: SuiteTarget = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/PASS|SECRET|TOKEN|KEY|COOKIE|DATABASE_URL/i.test(key)) delete env[key];
  }
  const db = targets.databaseUrl ?? process.env.SHO_NAMED_SUITE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (db) {
    let host = "";
    try {
      const url = new URL(db);
      if (url.protocol === "postgresql:" || url.protocol === "postgres:") host = url.hostname;
    } catch { host = ""; }
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error("Refusing to run the named suite against a non-local database.");
    env.DATABASE_URL = db;
  }
  let target: URL;
  try { target = new URL(targets.baseUrl ?? process.env.SHO_NAMED_SUITE_BASE_URL ?? "http://127.0.0.1:3100"); }
  catch { throw new Error("Refusing a named-suite server URL that is not a loopback origin."); }
  if (!["http:", "https:"].includes(target.protocol) || !["127.0.0.1", "localhost"].includes(target.hostname) || target.username || target.password || target.pathname !== "/" || target.search || target.hash)
    throw new Error("Refusing a named-suite server URL that is not a loopback origin.");
  env.TASKBOARD_URL = target.origin;
  env.APP_URL = target.origin;
  env.BASE_URL = target.origin;
  env.SHO_E2E_START_BASE_URL = target.origin;
  const outbox = targets.outboxDir ?? process.env.SHO_NAMED_SUITE_EMAIL_OUTBOX_DIR;
  if (outbox) env.EMAIL_OUTBOX_DIR = outbox;
  return env;
}

/** `npx vitest run` on `files`. `config` selects a vitest config (the viewport suite is excluded from the default one). */
export async function runVitest(files: string[], config?: string, targets?: SuiteTarget): Promise<SuiteReport> {
  for (const file of files) {
    expect(existsSync(file), `${file} is one of the named spec files`).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(MARKER.test(text), `${file} has a skip, .only, fixme or quarantine marker`).toBe(false);
  }
  const outputFile = path.join(mkdtempSync(path.join(tmpdir(), "sho-vitest-")), "report.json");
  const args = ["vitest", "run", "--reporter=json", "--outputFile", outputFile];
  if (config) args.push("-c", config);
  args.push(...files);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("npx", args, { env: namedSuiteEnv(targets), cwd: process.cwd(), timeout: 12 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
  writeFileSync(path.join(path.dirname(outputFile), "stdout.log"), result.stdout, { mode: 0o600 });
  writeFileSync(path.join(path.dirname(outputFile), "stderr.log"), result.stderr, { mode: 0o600 });
  let report: SuiteReport | null = null;
  try { report = JSON.parse(readFileSync(outputFile, "utf8")) as SuiteReport; } catch { /* vitest wrote no report */ }
  if (report) await test.info().attach("named-vitest-report", { path: outputFile, contentType: "application/json" });
  const tail = (result.stderr || result.stdout).slice(-2_000);
  expect(report, tail || `vitest exited ${result.code}`).toBeTruthy();
  const skipped = report!.testResults.flatMap((file) => file.assertionResults.filter((row) => row.status !== "passed").map((row) => `${file.name} ${row.fullName} (${row.status})`));
  expect(skipped, "every test passed").toEqual([]);
  expect(report!.numPendingTests, "none skipped").toBe(0);
  expect(report!.numTodoTests, "none todo").toBe(0);
  expect(report!.numFailedTests).toBe(0);
  expect(report!.numTotalTests).toBeGreaterThan(0);
  expect(report!.success).toBe(true);
  expect(result.code, tail).toBe(0);
  return report!;
}
