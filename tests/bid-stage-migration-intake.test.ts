import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const first = readFileSync("prisma/migrations/20261024110000_stage_delivery_category/migration.sql", "utf8");
const mapping = readFileSync("prisma/migrations/20261024110100_bid_stage_mapping/migration.sql", "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");
describe("Bid intake migration safety contracts (database execution belongs to local integration)", () => {
  it("commits the DELIVERY enum separately before the mapping can use it", () => {
    expect(first).toContain('ALTER TYPE "StageCategory" ADD VALUE \'DELIVERY\'');
    expect(first).not.toMatch(/INSERT|UPDATE|BEGIN;/);
    expect(schema).toMatch(/enum StageCategory \{\s+DELIVERY/);
    expect(schema).toMatch(/isRetired\s+Boolean\s+@default\(false\)/);
  });
  it("checks customization and reference consistency before changing rows or schema", () => {
    const mutation = mapping.indexOf('ALTER TABLE "Stage"');
    for (const message of ["expected seeded pl_bid", "custom, missing or unexpected", "validation rules have changed", "reserved stage ID", "pipeline/stage references are inconsistent"]) {
      expect(mapping.indexOf(message)).toBeGreaterThan(0);
      expect(mapping.indexOf(message)).toBeLessThan(mutation);
    }
    expect(mapping).toContain('LOCK TABLE "Pipeline", "Stage", "Project" IN SHARE ROW EXCLUSIVE MODE');
    expect(mapping).toContain('BEGIN;'); expect(mapping).toContain('COMMIT;');
  });
  it("retains historical Awaiting IDs and changes only stageId on all Awaiting projects", () => {
    expect(mapping).toContain('UPDATE "Stage" SET "isRetired"=true WHERE "id"=\'st_bid_awaiting\'');
    expect(mapping).toContain('UPDATE "Project" SET "stageId"=\'st_bid_submitted\' WHERE "pipelineId"=\'pl_bid\' AND "stageId"=\'st_bid_awaiting\'');
    expect(mapping).not.toMatch(/DELETE\s+FROM|UPDATE\s+"(?:ActionLog|UndoToken|Pipeline)"/);
    expect(mapping).not.toMatch(/SET\s+"(?:stageChangedAt|stageReason|updatedAt)"/);
    expect(mapping).toContain("SELECT unnest(old_ids) EXCEPT SELECT \"id\" FROM \"Stage\"");
  });
  it("creates separate No-Go, On Hold and Delivery without reinterpreting neutral or Won data", () => {
    expect(mapping).toContain("('st_bid_nogo','pl_bid','No-Go',3,'LOST',true,'{}')");
    expect(mapping).toContain("('st_bid_onhold','pl_bid','On Hold',7,'PAUSED',true,'{}')");
    expect(mapping).toContain("('st_bid_ongoing','pl_bid','Ongoing Projects',8,'DELIVERY',false,'{}')");
    expect(mapping).toContain('SET "name"=\'Under Evaluation\' WHERE "id"=\'st_bid_gonogo\'');
    expect(mapping).not.toContain('SET "stageId"=\'st_bid_ongoing\'');
  });
  it("asserts full expected project snapshots and unrelated pipelines/stages unchanged", () => {
    expect(mapping).toContain("jsonb_build_object('stageId',CASE WHEN p.\"stageId\"='st_bid_awaiting' THEN 'st_bid_submitted' ELSE p.\"stageId\" END)");
    for (const snapshot of ["other_stages", "other_pipelines", "other_projects", "bid_projects"]) expect(mapping).toContain(`${snapshot} IS DISTINCT FROM`);
    expect(mapping).toContain('project_count<>(SELECT count(*) FROM "Project")');
    expect(mapping).not.toMatch(/WHERE[^;]*"archivedAt"/);
  });
});
