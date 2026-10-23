// SHO-3011. The strip-pattern inventory W168 published covered `url.search = ""`, `searchParams.delete("schema")`
// and `.split("?")[0]`. It did not cover the other way this repo drops Prisma's ?schema= before handing a connection
// string to a child process: `.replace(/\?.*$/, "")`. `localSql()` in tests/e2e/helpers/local-clock.ts does exactly
// that and then runs an UNQUALIFIED statement ("UPDATE \"Task\"", "\"ActionLog\"", "\"AuditLog\"" in four story specs)
// through psql, on the server default search_path - public - while the app under test writes the schema
// DATABASE_URL names. Same class as tests/e2e/stories/APL-2506.spec.ts, which W168 fixed by prefixing
// `SET search_path TO "<schema>"; ` - but the shared helper every other story uses was left as it was.
//
// No psql in this harness, so the assertion is on what the helper WOULD execute: a fake `psql` first on PATH records
// its argv. Nothing connects, nothing is written, and the URL below is never dialled.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSql } from "./e2e/helpers/local-clock";

const SCHEMA = "w193";
/** A local URL of the shape the helper accepts (its gate is the database NAME, not the schema). Never dialled. */
const DB_URL = `postgresql://sho:sho@127.0.0.1:55432/taskboard?schema=${SCHEMA}`;

let shimDir: string;
let argvFile: string;
const saved = {
  DATABASE_URL: process.env.DATABASE_URL,
  BASE_URL: process.env.BASE_URL,
  TASKBOARD_URL: process.env.TASKBOARD_URL,
  PATH: process.env.PATH,
};

beforeAll(() => {
  shimDir = mkdtempSync(path.join(tmpdir(), "w193-psql-"));
  argvFile = path.join(shimDir, "argv.json");
  // One argv per line, so the -c statement is readable as the helper passed it.
  const shim = `#!/bin/sh\n: > '${argvFile}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; printf '\\n' >> '${argvFile}'; done\n`;
  writeFileSync(path.join(shimDir, "psql"), shim);
  chmodSync(path.join(shimDir, "psql"), 0o755);
  process.env.PATH = `${shimDir}:${process.env.PATH}`;
  process.env.DATABASE_URL = DB_URL;
  // resolveBaseUrl prefers BASE_URL, and Vitest rewrites the live value in its workers: set both, so the helper's
  // localhost gate reads the local server.
  process.env.BASE_URL = "http://localhost:3336";
  process.env.TASKBOARD_URL = "http://localhost:3336";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("qa:TC missing SHO-3011 AC2: the shared psql helper runs its statement on the schema DATABASE_URL names", () => {
  it("qa:TC missing SHO-3011 AC2: localSql() pins the URL's schema instead of psql's default (public)", () => {
    const ran = localSql(`UPDATE "Task" SET "deletedAt" = NOW() - INTERVAL '31 days' WHERE id = 'abc123'`);
    expect(ran, "the helper declined to run at all; the gate, not the fix, is under test").toBe(true);
    const argv = readFileSync(argvFile, "utf8");
    // psql was handed a connection string without ?schema= (libpq rejects it) - that part is correct and expected.
    expect(argv).not.toContain(`schema=${SCHEMA}`);
    // ...so the schema has to be pinned in the statement itself, the way APL-2506.spec.ts was fixed at :61-66.
    expect(argv, "without SET search_path the unqualified UPDATE runs in public, where the app's row is not").toContain(
      `SET search_path TO "${SCHEMA}"`,
    );
  });
});
