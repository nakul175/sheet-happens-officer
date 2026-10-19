// APL-2659: a hand-written db.project read outside the visibility helpers fails lint.
// The same read passes when it goes through visibleProjects, or carries // project-lookup-ok: <reason>.
import path from "node:path";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";
import rule from "../eslint/no-unguarded-project-lookup.mjs";

const linter = new Linter({ configType: "flat" });

function lint(code: string, filename: string) {
  return linter.verify(code, [
    {
      files: ["**/*.ts"],
      languageOptions: { parser: tsParser, sourceType: "module", ecmaVersion: "latest" },
      plugins: { sho: { rules: { "no-unguarded-project-lookup": rule } } },
      rules: { "sho/no-unguarded-project-lookup": "error" },
    },
  ], { filename });
}

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

describe("project lookup guard (APL-2659)", () => {
  it("fails a direct db.project.findMany and passes the same read through visibleProjects", () => {
    const bad = lint(direct, "src/lib/example.ts");
    expect(bad).toHaveLength(1);
    expect(bad[0].message).toContain("visibleProjects");
    expect(bad[0].message).toContain("myProjects");
    expect(bad[0].message).toContain("projectAccess");
    expect(bad[0].message).toContain("db.project.findMany");

    expect(lint(throughHelper, "src/lib/example.ts")).toEqual([]);
  });

  it("fails findFirst, findUnique and count with the same message", () => {
    const code = `
      type Q = (q: unknown) => Promise<unknown>;
      export async function reads(db: { project: { findFirst: Q; findUnique: Q; count: Q } }) {
        return Promise.all([
          db.project.findFirst({ where: { id: "x" } }),
          db.project.findUnique({ where: { id: "x" } }),
          db.project.count({ where: { id: "x" } }),
        ]);
      }
    `;
    const messages = lint(code, "src/lib/example.ts").map((m) => m.message);
    expect(messages).toHaveLength(3);
    expect(messages.some((m) => m.includes("findFirst"))).toBe(true);
    expect(messages.some((m) => m.includes("findUnique"))).toBe(true);
    expect(messages.some((m) => m.includes("count"))).toBe(true);
    for (const m of messages) expect(m).toContain("visibleProjects");
  });

  it("accepts an allow-comment with a reason and rejects an empty one", () => {
    const allowed = `
      export async function audit(db: { project: { findMany: (q: unknown) => Promise<unknown[]> } }) {
        // project-lookup-ok: super admin audit must label every project named in the log
        return db.project.findMany({ where: { id: { in: ["p1"] } } });
      }
    `;
    expect(lint(allowed, "src/lib/feed.ts")).toEqual([]);

    const empty = `
      export async function audit(db: { project: { findMany: (q: unknown) => Promise<unknown[]> } }) {
        // project-lookup-ok:
        return db.project.findMany({ where: { id: { in: ["p1"] } } });
      }
    `;
    expect(lint(empty, "src/lib/feed.ts")).toHaveLength(1);
  });

  it("does not flag the helper module, where projectAccess loads the row and applies the filters", () => {
    const code = `
      export async function projectAccess(db: { project: { findUnique: (q: unknown) => Promise<unknown> } }, id: string) {
        return db.project.findUnique({ where: { id } });
      }
    `;
    expect(lint(code, "src/lib/access.ts")).toEqual([]);
    expect(lint(code, path.join(process.cwd(), "src/lib/access.ts"))).toEqual([]);
  });
});
