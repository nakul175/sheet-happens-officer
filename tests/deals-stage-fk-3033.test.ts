// SHO-3033. The comment on the transaction in removeStage (src/lib/deals.ts) explains why the delete cannot clear a
// deal's stage. It says the stageId foreign key is ON DELETE SET NULL, so the updateMany -- not the key -- preserves
// the stage. That sentence was once false ("the foreign key never sets a deal's stage to null"); this pins it to the
// schema and the migration that actually create the key.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCHEMA = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
const DEALS = readFileSync(path.join(ROOT, "src", "lib", "deals.ts"), "utf8");
// The migration that adds the key, so the comment's claim is checked against the SQL that ran.
const MIGRATION = readFileSync(
  path.join(ROOT, "prisma", "migrations", "20261017124803_crm_workstreams_deals", "migration.sql"),
  "utf8",
);

/** The whole `model Project { ... }` block. */
function model(name: string) {
  const start = SCHEMA.indexOf(`model ${name} {`);
  expect(start, `model ${name} is in prisma/schema.prisma`).toBeGreaterThan(-1);
  return SCHEMA.slice(start, SCHEMA.indexOf("\n}", start));
}

describe("qa:TC missing SHO-3033: the removeStage comment matches the stage foreign key", () => {
  it("the stage relation is optional and gives no onDelete, so Prisma defaults to SET NULL", () => {
    const project = model("Project");
    expect(project).toMatch(/^\s*stageId\s+String\?\s*$/m);
    const relation = project.match(/^\s*stage\s+Stage\?\s+@relation\(([^)]*)\)/m);
    expect(relation, "Project.stage is an optional relation").not.toBeNull();
    // Optional relation, no onDelete: Prisma's default is SetNull. An explicit onDelete would change the story.
    expect(relation![1]).not.toMatch(/onDelete/);
  });

  it("the migration creates the key ON DELETE SET NULL", () => {
    const key = MIGRATION.match(/ALTER TABLE "Project" ADD CONSTRAINT "Project_stageId_fkey"[^;]*;/);
    expect(key, "the stage foreign key is created by a migration").not.toBeNull();
    expect(key![0]).toMatch(/ON DELETE SET NULL/);
  });

  it("the comment states SET NULL and names the updateMany, not the key, as what preserves a deal's stage", () => {
    const comment = DEALS.slice(DEALS.indexOf("// Lock the stage row first"), DEALS.indexOf("const locked"));
    // The old, false sentence: the key was said to never clear a stage.
    expect(comment).not.toMatch(/never sets a deal's stage to null/i);
    expect(comment).toMatch(/ON DELETE SET NULL/);
    expect(comment).toMatch(/updateMany/);
  });
});
