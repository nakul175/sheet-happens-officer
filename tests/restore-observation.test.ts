import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { observeRestoreCounts } = require("../deploy/restore-observation.cjs") as {
  observeRestoreCounts: (client: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<{ out: Record<string, number>; newestUser: Date | null }>;
};

it("counts tables inside one repeatable-read, read-only transaction", async () => {
  const calls: string[] = [];
  const date = new Date("2026-11-20T00:00:00.000Z");
  const client = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.includes("from pg_tables")) return { rows: [{ tablename: "Task" }, { tablename: "User" }] };
    if (sql === 'select count(*) n from "Task"') return { rows: [{ n: "2" }] };
    if (sql === 'select count(*) n from "User"') return { rows: [{ n: "1" }] };
    if (sql.startsWith('select max(')) return { rows: [{ m: date }] };
    return { rows: [] };
  } };
  expect(await observeRestoreCounts(client)).toEqual({ out: { Task: 2, User: 1 }, newestUser: date });
  expect(calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect(calls.at(-1)).toBe("COMMIT");
  expect(calls).not.toContain("ROLLBACK");
});

it("rolls back on an observation error and does not return partial counts", async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.includes("from pg_tables")) return { rows: [{ tablename: "User" }] };
    if (sql.startsWith("select count")) throw new Error("synthetic query failure");
    return { rows: [] };
  } };
  await expect(observeRestoreCounts(client)).rejects.toThrow("synthetic query failure");
  expect(calls.at(-1)).toBe("ROLLBACK");
  expect(calls).not.toContain("COMMIT");
});

it("ships the observation helper with the manual restore workflow", () => {
  const workflow = readFileSync(".github/workflows/restore-check.yml", "utf8");
  expect(workflow).toContain("deploy/restore-observation.cjs");
  expect(workflow).toContain("cp /tmp/restore-check.cjs /tmp/restore-assessment.cjs /tmp/restore-connection.cjs /tmp/restore-target.cjs /tmp/restore-observation.cjs");
});
