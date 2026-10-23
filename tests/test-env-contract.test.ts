// APL-2736 follow-up: the test environment contract must be complete and self-consistent.
//
// Why this file exists: the v4-v10 harness fix cycles failed because the documented `npm test`
// env prefix and the README purpose table drifted apart, and because vitest.config.mts has NO
// setupFiles. That absence is the reason an unset variable surfaced as wholesale import failures
// (a module read process.env.DATABASE_URL at import time and threw) instead of the suite skipping
// the database-backed files. Both facts are easy to regress silently, so they are asserted here.
//
// This file is pure file parsing: no live server, no database, no child process. It is fast and
// hermetic on purpose, so it can run anywhere `npm test` runs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Variables the `npm test` command line must set for the vitest process (README contract). */
const REQUIRED = ["DATABASE_URL", "JOB_SECRET", "TASKBOARD_URL", "EMAIL_OUTBOX_DIR", "SUPER_ADMIN_EMAILS"] as const;

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

/** The dev server the Test section starts, the one `TASKBOARD_URL` points at. */
function devServer(section: string): { env: Record<string, string>; rest: string } {
  const server = commands(section).find((item) => /next dev/.test(item.rest));
  if (!server) throw new Error("Test section has no dev server command");
  return server;
}

const readme = readFileSync("README.md", "utf8");
const section = testSection(readme);

describe("test env contract: README npm test line + vitest config", () => {
  it("the npm test command sets every variable the suite needs", () => {
    const env = npmTestEnv(section);
    // Removing DATABASE_URL or JOB_SECRET from this line is the exact regression that broke the
    // harness: several files open the database and call the job endpoint from the test process.
    for (const name of REQUIRED) {
      expect(env[name], `${name} on the npm test command line`).toBeTruthy();
    }
  });

  it("every variable on the npm test line is documented in the README purpose table", () => {
    const table = purposes(section);
    for (const name of REQUIRED) {
      expect(table[name], `${name} row in the README purpose table`).toBeTruthy();
    }
  });

  it("the purpose table documents no variable the npm test line does not set", () => {
    // The other direction: a row for a variable nobody exports is stale documentation.
    const env = npmTestEnv(section);
    for (const name of Object.keys(purposes(section))) {
      expect(env[name], `${name} is in the purpose table but not on the npm test line`).toBeTruthy();
    }
  });

  it("vitest.config.mts still has no setupFiles", () => {
    // Deliberate: with no setupFiles there is no shared place to fail fast on a missing variable,
    // so an unset DATABASE_URL/JOB_SECRET throws at import time and takes whole files down instead
    // of letting the DB-backed ones skip. If someone adds setupFiles, this contract must be
    // re-documented (README ## Test) and this assertion updated in the same change.
    const config = readFileSync("vitest.config.mts", "utf8");
    expect(config).not.toMatch(/\bsetupFiles\b/);
  });

  it("TASKBOARD_URL points the suite at the server the README starts", () => {
    const env = npmTestEnv(section);
    const server = commands(section).find((item) => /next dev/.test(item.rest));
    expect(server, "Test section starts a dev server").toBeTruthy();
    const port = server!.env.APP_URL?.match(/:(\d+)\b/)?.[1];
    expect(port, "APP_URL port in the server command").toBeTruthy();
    expect(env.TASKBOARD_URL).toBe(server!.env.APP_URL);
  });
});

// APL-2652 follow-up. tests/return-to.test.ts reads `process.env.SERVER_LOG ?? "server.log"` and requires a
// `[return-path] …` line for each v16 probe. src/proxy.ts writes those lines only when the SERVER has
// RETURN_PATH_LOG=1. Documenting the variable (as the prose above the table does) is not enough: the dev-server
// line the README publishes never set it, so the probe had nothing to read and the check could only pass in CI.
describe("return-path probe: the documented dev server can write what the test reads", () => {
  it("the dev server the README starts sets RETURN_PATH_LOG=1", () => {
    expect(devServer(section).env.RETURN_PATH_LOG, "RETURN_PATH_LOG=1 on the dev server line").toBe("1");
  });

  it("the dev server writes the log the probe reads (server.log)", () => {
    // Unset SERVER_LOG means the test reads ./server.log, so the documented server has to write that file.
    expect(devServer(section).rest, "the dev server line redirects to server.log").toMatch(/>\s*server\.log\b/);
  });

  it("npm run dev sets it too, so a plain dev server answers the same probe", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev, "RETURN_PATH_LOG=1 in the dev script").toMatch(/(^|\s)RETURN_PATH_LOG=1\s+next dev/);
  });

  it("the proxy still gates the line on RETURN_PATH_LOG=1 and the test still reads server.log", () => {
    // The other end of the contract. Without these two the assertions above would prove a variable nobody uses.
    const proxy = readFileSync("src/proxy.ts", "utf8");
    expect(proxy, "proxy gated on RETURN_PATH_LOG === \"1\"").toContain('process.env.RETURN_PATH_LOG === "1"');
    expect(proxy, "proxy writes the [return-path] line").toContain("[return-path]");
    expect(readFileSync("tests/return-to.test.ts", "utf8"), "the test reads SERVER_LOG, else server.log")
      .toContain('process.env.SERVER_LOG ?? "server.log"');
    // ...and only counts what the running server appended while it ran, so a log left by an earlier run cannot let a
    // server with RETURN_PATH_LOG unset pass (SHO-3024).
    expect(readFileSync("tests/return-to.test.ts", "utf8"), "the probe counts only bytes appended during the test")
      .toContain("logSizeAtStart");
  });

  it("CI starts the server under test the same way", () => {
    expect(readFileSync(".github/workflows/ci.yml", "utf8"), "CI sets RETURN_PATH_LOG=1 for next start")
      .toMatch(/RETURN_PATH_LOG=1\s+npx next start/);
  });
});
