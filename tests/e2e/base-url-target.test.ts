// APL-2879 D1 (Pam's FAIL at 2fd0fc3): with only TASKBOARD_URL set, or no target at all, the story harness pointed at
// staging, whose database is shared with production. The target must be BASE_URL, then TASKBOARD_URL, then STAGING_URL,
// else http://localhost:3100. Nothing here opens a page or sends a request; the config is only loaded and read.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_DEFAULT, resolveBaseUrl } from "./base-url";
import { localDatabaseUrl } from "./helpers/local-clock";

const root = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const STAGING = "https://staging.sheethappensofficer.com";
const LOCAL_DB = "postgresql://u:p@localhost:5432/taskboard?schema=public";

/**
 * Pam's probe: playwright.config.ts's baseURL, read in a fresh process with only `env` set (no .env, no inherited target).
 * The child loads the real config through tsx and prints use.baseURL. No browser starts and no request is made.
 */
function configBaseUrl(env: Record<string, string>) {
  const read = 'import("./playwright.config.ts").then((m) => { const c = m.default?.default ?? m.default; process.stdout.write(String(c.use.baseURL)); })';
  return execFileSync(process.execPath, ["--import", "tsx", "-e", read], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
}

describe("qa:TC missing APL-2879 the story target is never staging by default", () => {
  it("qa:TC missing playwright.config.ts: only TASKBOARD_URL=http://localhost:3100 set gives a localhost baseURL", () => {
    expect(configBaseUrl({ TASKBOARD_URL: "http://localhost:3100" })).toBe("http://localhost:3100");
  }, 30_000);

  it("qa:TC missing playwright.config.ts: no target variable set gives http://localhost:3100", () => {
    expect(configBaseUrl({})).toBe(LOCAL_DEFAULT);
    expect(LOCAL_DEFAULT).toBe("http://localhost:3100");
  }, 30_000);

  it("qa:TC missing resolveBaseUrl: BASE_URL, then TASKBOARD_URL, then STAGING_URL, else localhost", () => {
    expect(resolveBaseUrl({})).toBe("http://localhost:3100");
    expect(resolveBaseUrl({ TASKBOARD_URL: "http://127.0.0.1:3100/" })).toBe("http://127.0.0.1:3100");
    expect(resolveBaseUrl({ TASKBOARD_URL: "http://localhost:3100", STAGING_URL: STAGING })).toBe("http://localhost:3100");
    expect(resolveBaseUrl({ BASE_URL: STAGING, TASKBOARD_URL: "http://localhost:3100" })).toBe(STAGING);
    expect(resolveBaseUrl({ STAGING_URL: STAGING })).toBe(STAGING);
  });

  it("qa:TC missing local-clock.ts: reads TASKBOARD_URL and defaults to localhost the same way", () => {
    expect(localDatabaseUrl({ TASKBOARD_URL: "http://localhost:3100", DATABASE_URL: LOCAL_DB })).toBe(LOCAL_DB);
    expect(localDatabaseUrl({ DATABASE_URL: LOCAL_DB })).toBe(LOCAL_DB);
    expect(localDatabaseUrl({ BASE_URL: STAGING, TASKBOARD_URL: "http://localhost:3100", DATABASE_URL: LOCAL_DB })).toBeNull();
    expect(localDatabaseUrl({ STAGING_URL: STAGING, DATABASE_URL: LOCAL_DB })).toBeNull();
  });
});
