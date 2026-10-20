// APL-2590 AC23. qa:TC-APL2590-7662ffd7@v2. The comments-basic seed runs only for an
// allow-listed test or staging database, and it refuses a production target.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db";
import { guard, seedCommentsBasic, STAGING_DB_HOSTS } from "../../scripts/seed-apl2590-fixtures";

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
    expect(guard(env({ SEED_TARGET: "staging", DATABASE_URL: stagingUrl }), ["staging.internal"])).toBe("staging"); // host and DB name both listed (D2)

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

  // APL-2590 QA D2 (Pam, #49 @3337a90): the staging guard checked only the DB name, so any host with /sho_staging passed.
  it("qa:TC missing D2: the seed needs both an allowlisted host and DB name, and refuses URL overrides", () => {
    const refused = (url: string, target = "staging") => {
      let message = "";
      try { guard(env({ SEED_TARGET: target, DATABASE_URL: url })); } catch (e) { message = (e as Error).message; }
      expect(message, url.replace(/\/\/[^@]*@/, "//***@")).toMatch(/Refusing/);
      expect(message).not.toMatch(/taskboard:taskboard/);
    };
    // Pam's step: an arbitrary host with the staging DB name.
    refused("postgresql://taskboard:taskboard@attacker.example.com:5432/sho_staging");
    refused("postgresql://taskboard:taskboard@staging.internal:5432/sho_staging");
    refused("postgresql://taskboard:taskboard@localhost:5432/sho_staging");
    // Query overrides that move the connection after the host and name are read.
    refused("postgresql://taskboard:taskboard@localhost:5432/sho_test?host=db.example.com", "test");
    refused("postgresql://taskboard:taskboard@localhost:5432/sho_test?hostaddr=10.0.0.9", "test");
    refused("postgresql://taskboard:taskboard@localhost:5432/sho_test?dbname=defaultdb", "test");
    refused("postgresql://taskboard:taskboard@%2Fvar%2Frun%2Fpostgresql/sho_test", "test");
    // Staging passes only when this exact host and this exact DB name are both on the list.
    const listed = { SEED_TARGET: "staging", DATABASE_URL: "postgresql://taskboard:taskboard@staging-db.zz-test.local:5432/sho_staging" };
    expect(guard(env(listed), ["staging-db.zz-test.local"])).toBe("staging");
    expect(() => guard(env({ ...listed, DATABASE_URL: listed.DATABASE_URL.replace("/sho_staging", "/sho_test") }), ["staging-db.zz-test.local"])).toThrow(/Refusing/);
    expect(() => guard(env({ ...listed, DATABASE_URL: listed.DATABASE_URL.replace("staging-db.zz-test.local", "other.zz-test.local") }), ["staging-db.zz-test.local"])).toThrow(/Refusing/);
    expect(() => guard(env(listed))).toThrow(/Refusing/); // staging-db.zz-test.local is not on the built-in list
    expect(guard(env())).toBe("test");
  });

  // pr8 seed host (Dwight 13:46, 20 Oct): the built-in list holds exactly the pr8/staging host, and only with sho_staging.
  it("qa:TC missing D-pr8: the built-in staging list accepts only the pr8 host with sho_staging", () => {
    const PR8 = "private-sho-db-do-user-45345612-0.k.db.ondigitalocean.com";
    expect(STAGING_DB_HOSTS).toEqual([PR8]);
    const at = (host: string, db: string) => env({ SEED_TARGET: "staging", DATABASE_URL: `postgresql://${host}/${db}` });
    expect(guard(at(PR8, "sho_staging"))).toBe("staging");
    expect(() => guard(at(PR8, "defaultdb"))).toThrow(/Production-like target. Refusing/);
    expect(() => guard(at(PR8, "sho_test"))).toThrow(/not an allowed staging DB/);
    for (const other of ["other-sho-db-do-user-45345612-0.k.db.ondigitalocean.com", "staging.internal", "localhost"])
      expect(() => guard(at(other, "sho_staging")), other).toThrow(/is not an allowed staging DB host/);
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
