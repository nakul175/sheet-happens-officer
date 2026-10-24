import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
async function violations(code: string, filePath = "src/project-lookup-probe.ts") {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === "sho/project-lookup");
}

describe("SHO-2659 project lookup visibility lint", () => {
  for (const method of ["findFirst", "findMany", "findUnique", "count"]) {
    it(`rejects a raw ${method} and names the approved helpers`, async () => {
      const found = await violations(`export const result = db.project.${method}({ where: { id } });`);
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain("visibleProjects, myProjects or projectAccess");
    });
  }
  it("also rejects computed property spelling", async () => {
    expect(await violations('export const result = db["project"]["findMany"]({});')).toHaveLength(1);
  });
  it("accepts a direct read scoped by visibleProjects", async () => {
    expect(await violations('export const result = db.project.findMany({ where: { ...visibleProjects(user), id } });')).toEqual([]);
  });
  it("does not mistake a helper name in a string for a visibility filter", async () => {
    expect(await violations('export const result = db.project.findMany({ where: { name: "visibleProjects(user)" } });')).toHaveLength(1);
  });
  it("requires a non-empty reason immediately before the read", async () => {
    const read = 'export const result = db.project.findMany({});';
    expect(await violations('// project-lookup-ok:\n' + read)).toHaveLength(1);
    expect(await violations('// project-lookup-ok: scheduled Admin job\n' + read)).toEqual([]);
    expect(await violations('// project-lookup-ok: unrelated statement\nconst other = 1;\n' + read)).toHaveLength(1);
  });
  it("permits the approved helper implementation modules", async () => {
    for (const file of ["src/lib/access.ts", "src/lib/concierge/reads.ts"]) {
      expect(await violations('export const result = db.project.findMany({});', file)).toEqual([]);
    }
  });
});
