import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { assertLocalTestDatabase } from "./approved-stalled-crm-db-helper";

const fixture = readFileSync(new URL("./stalled-crm-fixture.ts", import.meta.url), "utf8");
const helper = readFileSync(new URL("./approved-stalled-crm-db-helper.ts", import.meta.url), "utf8");
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("SHO-2902 approved stalled-CRM DB helper", () => {
  it("keeps every direct database mutation out of the shared fixture", () => {
    expect(fixture).not.toMatch(/\$executeRaw|\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(fixture).toContain('from "./approved-stalled-crm-db-helper"');
  });

  it("keeps local-database and ZZ-TEST identity guards beside the approved mutations", () => {
    expect(helper).toContain("assertLocalTestDatabase();");
    expect(helper).toContain('startsWith("ZZ-TEST ")');
    expect(helper).toContain('startsWith("nakul17+zz-2741-")');
    expect(helper).toContain("verifyZzPeople");
    expect(helper).toContain("verifyZzProjects");
  });

  it.each([
    undefined,
    "not a URL",
    "postgresql://sho:sho@database.example/sho_test",
  ])("refuses a missing, malformed or non-local database URL: %s", (databaseUrl) => {
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
    expect(() => assertLocalTestDatabase()).toThrow(/local test database|Refusing to run/);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("allows the local test host %s", (host) => {
    process.env.DATABASE_URL = `postgresql://sho:sho@${host}:5432/sho_test`;
    expect(() => assertLocalTestDatabase()).not.toThrow();
  });
});
