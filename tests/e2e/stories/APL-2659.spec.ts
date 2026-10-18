// [SHO-TECH] Guard against hand-written project lookups that skip the visibility filters (Linear APL-2659).
// AC1, AC2 and AC4 are the lint rule: a direct db.project.findMany (and findFirst, findUnique, count) under src/,
// outside the helper modules, fails unless the previous line is `// project-lookup-ok: <reason>`.
// The message names visibleProjects, myProjects and projectAccess. AC5 is a quick action on a project the person can see.
// A quick action on an archived project, or on a deal the CRM hides, must be "Project not found" and must not store the name.
// Projects, deals and chats are ZZ-TEST and cleaned up.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test, expect, login } from "../support";
import { newProject } from "../g2";
import { chatMessages, cleanChat, newDeal, quickAction } from "../helpers/jim-http";
import { crmModeLive } from "../helpers/jim-gate";

const CALL = /db\.project\.(findMany|findFirst|findUnique|count)\b/;
const ALLOW = /project-lookup-ok:\s+\S/;
const HELPERS = "visibleProjects, myProjects and projectAccess";
const APPROVED = new Set(["src/lib/access.ts", "src/lib/concierge/reads.ts"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "generated") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Lines that call db.project directly and do not carry `// project-lookup-ok: <reason>`. */
function unguarded(file: string, source = readFileSync(file, "utf8")): string[] {
  const lines = source.split("\n");
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (!CALL.test(line)) return;
    const prev = lines[i - 1] ?? "";
    if (ALLOW.test(line) || ALLOW.test(prev)) return;
    if (/visibleProjects|myProjects|projectAccess/.test(line) || /visibleProjects|myProjects|projectAccess/.test(prev)) return;
    hits.push(`${file}:${i + 1}: use ${HELPERS}, or a project-lookup-ok reason`);
  });
  return hits;
}

function scopeOfQuickAnswer() {
  const reads = readFileSync("src/lib/concierge/reads.ts", "utf8");
  const fn = reads.slice(reads.indexOf("export async function quickAnswer"), reads.indexOf("export async function taskById"));
  return fn.slice(fn.indexOf("const scope"), fn.indexOf("if (projectId"));
}

test.describe("SHO-TECH / APL-2659", () => {
  test("AC1: a direct db.project.findMany under src/ fails the guard and the message names the helpers", () => {
    const sample = "export const rows = await db.project.findMany({ where: { archivedAt: null } });\n";
    const found = unguarded("src/sample.ts", sample);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(HELPERS);
    const eslint = readFileSync("eslint.config.mjs", "utf8");
    expect(eslint + HELPERS).toContain("visibleProjects");
    // APL-2722: eslint.config.mjs has no project-lookup rule, and the direct lookups have no allow reason.
    expect(eslint, "npm run lint rejects a direct db.project lookup and names the helpers").toContain("project-lookup-ok");
  });

  test("AC2: project-lookup-ok with a reason is the escape hatch, and an empty reason still fails", () => {
    const bare = "// project-lookup-ok:\nconst rows = await db.project.findMany({});\n";
    const named = "// project-lookup-ok: the nightly job reads every project\nconst rows = await db.project.findMany({});\n";
    expect(unguarded("src/sample.ts", bare)).toHaveLength(1);
    expect(unguarded("src/sample.ts", named)).toEqual([]);
    const outside = walk("src").filter((file) => !APPROVED.has(file)).flatMap((file) => unguarded(file));
    expect(outside, "every direct lookup outside the helper modules has a reason").toEqual([]);
  });

  test("AC4: the same fixture fails a raw findMany and passes that read through visibleProjects", () => {
    const raw = "const rows = await db.project.findMany({ where: { id } });\n";
    const helped = "const rows = await db.project.findMany({ where: { ...visibleProjects(user), id } });\n";
    expect(unguarded("src/sample.ts", raw)).toHaveLength(1);
    expect(unguarded("src/sample.ts", helped)).toEqual([]);
    // APL-2723: quickAnswer loads the scoped project by membership only, so an archived or hidden name still comes back.
    expect(scopeOfQuickAnswer(), "quickAnswer scopes through visibleProjects").toContain("visibleProjects(user)");
  });

  test("a quick action on an archived project the person belongs to is Project not found, and the name is not stored", async ({ admin, later }) => {
    expect(scopeOfQuickAnswer(), "the scope uses visibleProjects, which leaves archived projects out").toContain("visibleProjects(user)");
    await cleanChat(admin, later);
    const p = await newProject(admin, later, { label: "lookup archived" });
    expect((await admin.api.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
    const r = await quickAction(admin, "due-week", p.id);
    const body = r.body;
    const pass = login("ADMIN").password;
    expect(r.status, body).toBe(404);
    expect(r.json.error).toBe("Project not found");
    expect(body.includes(p.name)).toBe(false);
    expect(body.includes(pass)).toBe(false);
    expect(JSON.stringify(await chatMessages(admin)).includes(p.name)).toBe(false);
  });

  test("a quick action on a deal the CRM hides from a Member is Project not found, and the name is not stored", async ({ admin, member, later }) => {
    expect(scopeOfQuickAnswer(), "the scope uses visibleProjects, which applies CRM_VISIBLE").toContain("visibleProjects(user)");
    const mode = await crmModeLive(admin, member);
    if (mode !== "admins") {
      test.info().annotations.push({ type: "CRM_VISIBLE", description: `${mode}: a Member is not hidden from deals, so the live call is the archived-project check.` });
      return;
    }
    await cleanChat(member, later);
    const deal = await newDeal(admin, later, "lookup hidden", [member]);
    const r = await quickAction(member, "due-week", deal.id);
    const body = r.body;
    const pass = login("MEMBER").password;
    expect(r.status, body).toBe(404);
    expect(r.json.error).toBe("Project not found");
    expect(body.includes(deal.name)).toBe(false);
    expect(body.includes(pass)).toBe(false);
    expect(JSON.stringify(await chatMessages(member)).includes(deal.name)).toBe(false);
  });

  test("AC5: a project the person can see still answers a quick action and names it", async ({ admin, later }) => {
    await cleanChat(admin, later);
    const p = await newProject(admin, later, { label: "lookup visible" });
    const r = await quickAction(admin, "due-week", p.id);
    const body = r.body;
    const pass = login("ADMIN").password;
    expect(r.status, body).toBe(200);
    expect(r.json.messages?.[0]?.text).toBe(`Due this week in ${p.name}`);
    expect(body.includes(pass)).toBe(false);
  });
});
