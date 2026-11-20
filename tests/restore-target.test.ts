import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertIsolatedRestoreTarget } = require("../deploy/restore-target.cjs") as {
  assertIsolatedRestoreTarget: (production: string, restored: string) => void;
};

const production = "postgresql://app:synthetic@prod.example.test:25060/defaultdb?sslmode=verify-full";

it("refuses a restore URL on the production host before a connection is made", () => {
  for (const restored of [
    production,
    "postgresql://other:synthetic@prod.example.test:25060/anotherdb?sslmode=verify-full",
    "postgresql://other:synthetic@PROD.EXAMPLE.TEST:25061/restoredb?sslmode=verify-full",
  ]) {
    expect(() => assertIsolatedRestoreTarget(production, restored)).toThrowError(/RESTORE_TARGET_HOST_MATCHES_PRODUCTION/);
  }
});

it("accepts a distinct restore host and rejects malformed URLs without exposing credentials", () => {
  expect(() => assertIsolatedRestoreTarget(production, "postgresql://app:synthetic@restore.example.test:25060/defaultdb?sslmode=verify-full")).not.toThrow();
  for (const restored of ["not-a-url", "postgresql://app:synthetic@restore.example.test/"]) {
    try { assertIsolatedRestoreTarget(production, restored); }
    catch (error) {
      expect((error as Error).message).toBe("RESTORE_URL_INVALID");
      expect((error as Error).message).not.toContain("synthetic");
      continue;
    }
    throw new Error("malformed restore URL was accepted");
  }
});

it("ships the identity guard with the manual restore workflow", () => {
  const workflow = readFileSync(".github/workflows/restore-check.yml", "utf8");
  expect(workflow).toContain("deploy/restore-target.cjs");
  expect(workflow).toContain('"deploy@$HOST:$remote_dir/"');
});
