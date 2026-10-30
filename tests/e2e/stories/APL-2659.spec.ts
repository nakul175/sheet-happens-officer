import { test } from "./qa";
// [SHO-TECH] Guard against hand-written project lookups that skip the visibility filters (Linear APL-2659, PR #32).
// AC1, AC2 and AC4 are the lint rule sho/no-unguarded-project-lookup: a direct db.project.findMany (and findFirst,
// findUnique, count) under src/, outside src/lib/access.ts, fails lint and names visibleProjects, myProjects
// and projectAccess. The same read passes through visibleProjects, or with // project-lookup-ok: <reason>.
// A quick action on an archived project, or on a deal the CRM hides, must be "Project not found" and must not store the name.
// A project the person can see still answers. Projects, deals and chats are ZZ-TEST and cleaned up.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expect } from "../support";

const RULE = "eslint/no-unguarded-project-lookup.mjs";

const direct = `
export async function list(db: { project: { findMany: (q: unknown) => Promise<unknown[]> } }) {
  return db.project.findMany({ where: { archivedAt: null } });
}
`;

const throughHelper = `
import { visibleProjects } from "@/lib/access";
type User = { id: string; orgRole: "MEMBER" | "ADMIN" | "SUPER_ADMIN" };
export async function list(db: { project: { findMany: (q: unknown) => Promise<unknown[]> } }, user: User) {
  return db.project.findMany({ where: { ...visibleProjects(user) } });
}
`;

async function lint(code: string, filename: string) {
  expect(existsSync(RULE), `${RULE} is the sho/no-unguarded-project-lookup rule`).toBe(true);
  const [{ Linter }, parserMod, ruleMod] = await Promise.all([
    import("eslint"),
    import("@typescript-eslint/parser"),
    import(pathToFileURL(RULE).href),
  ]);
  const linter = new Linter({ configType: "flat" });
  return linter.verify(code, [
    {
      files: ["**/*.ts"],
      languageOptions: { parser: parserMod.default, sourceType: "module", ecmaVersion: "latest" },
      plugins: { sho: { rules: { "no-unguarded-project-lookup": ruleMod.default } } },
      rules: { "sho/no-unguarded-project-lookup": "error" },
    },
  ], { filename }) as { message: string }[];
}

test.describe("SHO-TECH / APL-2659", () => {
  test("AC1: a direct db.project.findMany under src/ fails lint and the message names the helpers", async () => {
    const bad = await lint(direct, "src/lib/example.ts");
    expect(bad).toHaveLength(1);
    expect(bad[0].message).toContain("visibleProjects");
    expect(bad[0].message).toContain("myProjects");
    expect(bad[0].message).toContain("projectAccess");
    expect(bad[0].message).toContain("db.project.findMany");
  });

  test("AC2: // project-lookup-ok: <reason> is the escape hatch, and an empty reason still fails", async () => {
    const allowed = `
      export async function audit(db: { project: { findMany: (q: unknown) => Promise<unknown[]> } }) {
        // project-lookup-ok: super admin audit must label every project named in the log
        return db.project.findMany({ where: { id: { in: ["p1"] } } });
      }
    `;
    expect(await lint(allowed, "src/lib/feed.ts")).toEqual([]);
    const empty = `
      export async function audit(db: { project: { findMany: (q: unknown) => Promise<unknown[]> } }) {
        // project-lookup-ok:
        return db.project.findMany({ where: { id: { in: ["p1"] } } });
      }
    `;
    expect(await lint(empty, "src/lib/feed.ts")).toHaveLength(1);
  });

  test("AC4: the same fixture fails a raw findMany and passes that read through visibleProjects", async () => {
    expect(await lint(direct, "src/lib/example.ts")).toHaveLength(1);
    expect(await lint(throughHelper, "src/lib/example.ts")).toEqual([]);
  });
});
