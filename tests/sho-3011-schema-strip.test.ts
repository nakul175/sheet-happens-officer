// SHO-3011. The strip-pattern inventory W168 published covered `url.search = ""`, `searchParams.delete("schema")`
// and `.split("?")[0]`. It did not cover the other way this repo drops Prisma's ?schema= before handing a connection
// string to a child process: `.replace(/\?.*$/, "")`. `localSql()` in tests/e2e/helpers/local-clock.ts does exactly
// that and then runs an UNQUALIFIED statement ("UPDATE \"Task\"", "\"ActionLog\"", "\"AuditLog\"" in four story specs)
// through psql, on the server default search_path - public - while the app under test writes the schema
// DATABASE_URL names. Same class as tests/e2e/stories/APL-2506.spec.ts, which W168 fixed by prefixing
// `SET search_path TO "<schema>"; ` - but the shared helper every other story uses was left as it was.
//
// No psql in this harness, so the assertion is on what the helper WOULD execute: a fake `psql` first on PATH records
// its argv and answers the helper's `SELECT current_schema()` from SHO_FAKE_SCHEMA. Nothing connects, nothing is
// written, and the URL below is never dialled. Four checks, because the pin alone is not the contract: the schema is
// pinned in-statement, a URL that names no schema is refused by name (psql never started), an explicit
// `{ schema: "public" }` is honoured, and a server that says the statement ran elsewhere turns into an error.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSql } from "./e2e/helpers/local-clock";

const SCHEMA = "w193";

let shimDir: string;
let argvFile: string;
const saved = {
  DATABASE_URL: process.env.DATABASE_URL,
  BASE_URL: process.env.BASE_URL,
  TASKBOARD_URL: process.env.TASKBOARD_URL,
  PATH: process.env.PATH,
  SHO_FAKE_SCHEMA: process.env.SHO_FAKE_SCHEMA,
};

/** DATABASE_URL of the shape the helper accepts (its gate is the database NAME, not the schema). Never dialled. */
function dbUrl(schema?: string) {
  return `postgresql://sho:sho@127.0.0.1:55432/taskboard${schema ? `?schema=${schema}` : ""}`;
}

beforeAll(() => {
  shimDir = mkdtempSync(path.join(tmpdir(), "w193-psql-"));
  argvFile = path.join(shimDir, "argv.json");
  // One argv per line, so the -c statement is readable as the helper passed it. The last line is the schema the helper
  // asked the server for (SHO-3011: `SELECT current_schema()`), answered from SHO_FAKE_SCHEMA.
  const shim = `#!/bin/sh\n: > '${argvFile}'\nfor a in "$@"; do printf '%s\\n\\n' "$a" >> '${argvFile}'; done\ncase "$*" in\n  *current_schema*) printf '%s\\n' "\${SHO_FAKE_SCHEMA:-${SCHEMA}}" ;;\n  *) printf 'SET\\nUPDATE 1\\n' ;;\nesac\n`;
  writeFileSync(path.join(shimDir, "psql"), shim);
  chmodSync(path.join(shimDir, "psql"), 0o755);
  process.env.PATH = `${shimDir}:${process.env.PATH}`;
  process.env.DATABASE_URL = dbUrl(SCHEMA);
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
  const AGE = `UPDATE "Task" SET "deletedAt" = NOW() - INTERVAL '31 days' WHERE id = 'abc123'`;

  it("qa:TC missing SHO-3011 AC2: localSql() pins the URL's schema instead of psql's default (public)", () => {
    const ran = localSql(AGE);
    expect(ran, "the helper declined to run at all; the gate, not the fix, is under test").toBe(true);
    const argv = readFileSync(argvFile, "utf8");
    // psql was handed a connection string without ?schema= (libpq rejects it) - that part is correct and expected.
    expect(argv).not.toContain(`schema=${SCHEMA}`);
    // ...so the schema has to be pinned in the statement itself, the way APL-2506.spec.ts was fixed at :61-66.
    expect(argv, "without SET search_path the unqualified UPDATE runs in public, where the app's row is not").toContain(
      `SET search_path TO "${SCHEMA}"`,
    );
    // And the helper asks the server where the statement actually ran, rather than assuming the pin took.
    expect(argv, "the helper never asked the server which schema it ran in").toContain("SELECT current_schema()");
  });

  it("qa:TC missing SHO-3011 AC2: a URL with no ?schema= is refused by name, and psql is never started", () => {
    const before = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = dbUrl(); // a bare local taskboard URL
      writeFileSync(argvFile, ""); // so the record below is this test's, not the previous test's
      expect(() => localSql(AGE), "a bare URL used to run the statement on psql's default schema (public)")
        .toThrow(/SHO-3011: DATABASE_URL names no \?schema=/);
      expect(readFileSync(argvFile, "utf8"), "psql ran even though the helper could not say which schema it meant").toBe("");
    } finally {
      process.env.DATABASE_URL = before;
    }
  });

  it("qa:TC missing SHO-3011 AC2: a caller that really means public says so, and the statement is pinned to it", () => {
    const before = process.env.DATABASE_URL;
    const beforeSchema = process.env.SHO_FAKE_SCHEMA;
    try {
      process.env.DATABASE_URL = dbUrl();
      process.env.SHO_FAKE_SCHEMA = "public";
      expect(localSql(AGE, { schema: "public" }), "an explicit public is not a silent default").toBe(true);
      expect(readFileSync(argvFile, "utf8")).toContain('SET search_path TO "public"');
    } finally {
      process.env.DATABASE_URL = before;
      if (beforeSchema === undefined) delete process.env.SHO_FAKE_SCHEMA;
      else process.env.SHO_FAKE_SCHEMA = beforeSchema;
    }
  });

  it("qa:TC missing SHO-3011 AC2: a statement that ran in another schema fails loudly instead of reporting success", () => {
    const before = process.env.SHO_FAKE_SCHEMA;
    try {
      // The pin is sent, but this server answers with a different schema: the helper must not claim the write landed.
      process.env.SHO_FAKE_SCHEMA = "public";
      expect(() => localSql(AGE), "the helper reported success for a statement that ran in public")
        .toThrow(/ran in schema "public", not "w193"/);
    } finally {
      if (before === undefined) delete process.env.SHO_FAKE_SCHEMA;
      else process.env.SHO_FAKE_SCHEMA = before;
    }
  });
});
