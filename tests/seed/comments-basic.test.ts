// APL-2590 AC23. qa:TC-APL2590-7662ffd7@v2. The comments-basic seed runs only for an
// allow-listed test or staging database, and it refuses a production target.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db";
import { guard, seedCommentsBasic } from "../../scripts/seed-apl2590-fixtures";

const SCRIPT = path.join(process.cwd(), "scripts/seed-apl2590-fixtures.ts");
const PASS = "seed-pass-9";
const testUrl = "postgresql://taskboard:taskboard@localhost:5432/sho_test?schema=public";
const stagingUrl = "postgresql://taskboard:taskboard@staging.internal:5432/sho_staging";

function env(over: Record<string, string | undefined> = {}) {
  return { NODE_ENV: "test", SEED_TARGET: "test", DATABASE_URL: testUrl, ...over };
}

describe("comments-basic seed", () => {
  it("qa:TC-APL2590-7662ffd7@v2: the comments-basic seed refuses anything but an allowlisted test or staging database", () => {
    expect(guard(env())).toBe("test");
    expect(guard(env({ SEED_TARGET: "staging", DATABASE_URL: stagingUrl }))).toBe("staging");

    const refuse = (over: Record<string, string | undefined>, pattern: RegExp) => {
      let message = "";
      try { guard(env(over)); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(pattern);
      expect(message).not.toMatch(/seed-pass|taskboard:taskboard|SHO_QA_PASS=/);
    };

    refuse({ SEED_TARGET: undefined }, /SEED_TARGET=test or staging/);
    refuse({ SEED_TARGET: "prod" }, /SEED_TARGET=test or staging/);
    refuse({ SEED_TARGET: "production" }, /SEED_TARGET=test or staging/);
    refuse({ NODE_ENV: "production" }, /NODE_ENV=production/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@139.59.45.166:5432/sho_test" }, /Production-like/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@sho.139-59-45-166.sslip.io:5432/sho_test" }, /Production-like/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@168.144.144.69:5432/sho_test" }, /Production-like/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@app.sheethappensofficer.com:5432/sho_test" }, /Production-like/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@db.prod.internal:5432/sho_test" }, /Production-like/);
    refuse({ DATABASE_URL: "postgresql://prod:taskboard@localhost:5432/sho_test" }, /Production-like/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@localhost:5432/defaultdb" }, /Production-like/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@localhost:5432/sho_prod" }, /Production-like/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@localhost:5432/taskboard" }, /not an allowed test DB/);
    refuse({ DATABASE_URL: "postgresql://taskboard:taskboard@example.com:5432/sho_test" }, /Test target must be local/);
    refuse({ DATABASE_URL: "not a url" }, /DATABASE_URL missing or invalid/);

    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/console\.(log|info|debug|error)\([^)]*SHO_QA_PASS/);
    expect(src).not.toMatch(/console\.(log|info|debug)\([^)]*\bpassword\b/);
  });

  it("qa:TC-APL2590-7662ffd7@v2: comments-basic creates the ZZ-TEST Ops fixture and can be run again", async () => {
    if (!(await db.workspace.findFirst())) await db.workspace.create({ data: { name: "ZZ-TEST workspace" } });
    const once = await seedCommentsBasic(db, { password: PASS });
    const twice = await seedCommentsBasic(db, { password: PASS });
    expect(twice.users.map((u) => u.email).sort()).toEqual(once.users.map((u) => u.email).sort());
    expect(once.users.every((u) => u.email.startsWith("nakul17+apl2590-") && u.name.startsWith("ZZ-TEST"))).toBe(true);
    const admin = once.users.find((u) => u.email.endsWith("admin@gmail.com"));
    const inactive = once.users.find((u) => u.email.endsWith("inactive@gmail.com"));
    const outsider = once.users.find((u) => u.email.endsWith("outsider@gmail.com"));
    expect(admin).toMatchObject({ orgRole: "ADMIN", active: true, name: "ZZ-TEST admin" });
    expect(inactive).toMatchObject({ active: false, name: "ZZ-TEST inactive" });
    const ops = once.projects.find((p) => p.name === "ZZ-TEST Ops");
    const old = once.projects.find((p) => p.name === "ZZ-TEST Old");
    expect(ops?.archivedAt).toBeNull();
    expect(old?.archivedAt).toBeTruthy();
    expect(ops?.members.some((m) => m.userId === outsider?.id)).toBe(false);
    expect(old?.members.map((m) => m.userId)).toEqual([once.users.find((u) => u.name === "ZZ-TEST lead")?.id]);
    const titles = once.tasks.map((t) => t.title).sort();
    expect(titles).toEqual(["ZZ-TEST T1", "ZZ-TEST T1.1", "ZZ-TEST T9"]);
    const t1 = once.tasks.find((t) => t.title === "ZZ-TEST T1")!;
    const child = once.tasks.find((t) => t.title === "ZZ-TEST T1.1")!;
    const t9 = once.tasks.find((t) => t.title === "ZZ-TEST T9")!;
    expect(child.parentId).toBe(t1.id);
    expect(t1.assigneeId).toBe(once.users.find((u) => u.name === "ZZ-TEST worker")?.id);
    expect(t9.assigneeId).toBe(once.users.find((u) => u.name === "ZZ-TEST lead")?.id);
    expect(t9.projectId).toBe(old?.id);
    expect(JSON.stringify(once)).not.toContain(PASS);
    expect(JSON.stringify(twice)).not.toContain(PASS);
  });

  afterAll(async () => {
    const ids = ["zz_apl2590_t1", "zz_apl2590_t1_1", "zz_apl2590_t9"];
    await db.comment.deleteMany({ where: { taskId: { in: ids } } });
    await db.task.deleteMany({ where: { id: { in: ids } } });
    await db.project.deleteMany({ where: { id: { in: ["zz_apl2590_ops", "zz_apl2590_old"] } } });
    await db.user.deleteMany({ where: { email: { startsWith: "nakul17+apl2590-" } } });
  });
});
