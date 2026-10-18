// The APL-2659 db helper must not write unless DATABASE_URL is local or a staging/slot test database.
import { describe, expect, it } from "vitest";
import { assertDatabaseUrl } from "./apl-2659-db";

const secret = "super-secret-db-password";

describe("APL-2659 db helper database guard", () => {
  it("accepts localhost and 127.0.0.1", () => {
    expect(() => assertDatabaseUrl("postgresql://sho:sho@localhost:5432/taskboard")).not.toThrow();
    expect(() => assertDatabaseUrl("postgresql://sho:sho@127.0.0.1:5432/sho_viewport?schema=public")).not.toThrow();
    expect(() => assertDatabaseUrl("postgres://sho:sho@LOCALHOST/taskboard")).not.toThrow();
  });

  it("accepts a staging or preview-slot test database name on a remote host", () => {
    for (const name of ["sho_test", "sho_staging", "staging", "pr1", "pr8", "sho_pr3", "SHO_PR8"]) {
      expect(() => assertDatabaseUrl(`postgresql://sho:${secret}@db.internal:5432/${name}`), name).not.toThrow();
    }
  });

  it("refuses a missing URL, a non-postgres URL, and a remote database that is not a staging or slot test database", () => {
    const cases = [
      undefined,
      "",
      "not a url",
      "http://localhost:5432/taskboard",
      `postgresql://sho:${secret}@db.example.com:5432/taskboard`,
      `postgresql://sho:${secret}@db.example.com:5432/sho`,
      `postgresql://sho:${secret}@db.example.com:5432/postgres`,
      `postgresql://sho:${secret}@staging.sheethappensofficer.com:5432/sho`,
      `postgresql://sho:${secret}@pr3.staging.sheethappensofficer.com:5432/production`,
    ];
    for (const raw of cases) {
      let message = "";
      try {
        assertDatabaseUrl(raw);
      } catch (e) {
        message = e instanceof Error ? e.message : "";
      }
      expect(message.length, String(raw)).toBeGreaterThan(0);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("postgresql://");
      expect(message).not.toContain("postgres://");
    }
  });
});
