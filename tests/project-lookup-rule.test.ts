import { describe, expect, it } from "vitest";
import { ESLint, Linter } from "eslint";
import projectLookup from "../eslint/no-unguarded-project-lookup.mjs";

const name = "sho/no-unguarded-project-lookup";
function lint(code: string, filename = "src/lib/lookup.ts") {
  return new Linter().verify(code, [{
    files: ["**/*.{ts,tsx}"],
    plugins: { sho: { rules: { "no-unguarded-project-lookup": projectLookup } } },
    rules: { [name]: "error" },
  }], { filename });
}

describe("project visibility lookup guard", () => {
  it.each(["findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow", "count"])("rejects raw %s reads, including transaction and bracket syntax", method => {
    for (const call of [`db.project.${method}({})`, `tx.project.${method}({})`, `db['project']['${method}']({})`]) {
      const messages = lint(call);
      expect(messages).toHaveLength(1);
      expect(messages[0].ruleId).toBe(name);
      expect(messages[0].message).toContain(`db.project.${method}`);
      for (const helper of ["visibleProjects", "myProjects", "projectAccess"]) expect(messages[0].message).toContain(helper);
    }
  });

  it.each(["visibleProjects", "myProjects", "projectAccess"])("accepts an actual %s call in the query", helper => {
    expect(lint(`db.project.findMany({where: {...${helper}(user)}})`)).toEqual([]);
  });

  it.each([
    "db.project.findMany({where: visibleProjects})",
    "db.project.findMany({where: {visibleProjects: true}})",
    "db.project.findMany({where: {name: 'visibleProjects'}})",
    "db.project.findMany({where: other(visibleProjects)})",
  ])("does not treat helper names or references as authorization: %s", code => {
    expect(lint(code)).toHaveLength(1);
  });

  it.each([
    "// project-lookup-ok: Super Admin audit labels referenced records\ndb.project.findMany({})",
    "db.project.count({}) // project-lookup-ok: authorized pipeline administration",
    "db.project.findUnique({ /* project-lookup-ok: caller authorizes projectAccess */ where: {id} })",
  ])("accepts a nearby explained bypass", code => {
    expect(lint(code)).toEqual([]);
  });

  it.each([
    "// project-lookup-ok:\ndb.project.findMany({})",
    "// project-lookup-ok:   \ndb.project.findMany({})",
    "// project-lookup-ok: unrelated earlier query\nconst unrelated = 1;\ndb.project.findMany({})",
  ])("rejects an empty or unrelated bypass", code => {
    expect(lint(code)).toHaveLength(1);
  });

  it.each(["src/lib/access.ts", "C:\\sho\\src\\lib\\access.ts", "tests/lookup.ts"])("exempts only helper implementation or non-source paths: %s", filename => {
    expect(lint("db.project.findMany({})", filename)).toEqual([]);
  });

  it("does not exempt a similarly named source module", () => {
    expect(lint("db.project.findMany({})", "src/lib/other-access.ts")).toHaveLength(1);
  });

  it("does not interfere with project writes or other delegates", () => {
    expect(lint("db.project.update({}); db.project.create({}); db.task.findMany({});")).toEqual([]);
  });

  it("enforces the guard through the repository ESLint config", async () => {
    const eslint = new ESLint();
    const [bad] = await eslint.lintText("export const read = (db) => db.project.findMany({});", { filePath: "src/lib/guard-fixture.ts" });
    expect(bad.messages.filter(message => message.ruleId === name)).toHaveLength(1);
    const [good] = await eslint.lintText("export const read = (db, user) => db.project.findMany({where: visibleProjects(user)});", { filePath: "src/lib/guard-fixture.ts" });
    expect(good.messages.filter(message => message.ruleId === name)).toEqual([]);
  });
});
