// APL-2669: the integer version is a compare-and-set. Forty saves of the same version must not all land.
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { account, project, task } from "./helpers";

const CONCURRENT = 40;

describe("task version under concurrent edits (APL-2669)", () => {
  it(`lets one of ${CONCURRENT} saves win and refuses the rest with version_conflict`, async () => {
    const lead = await account("lead");
    const worker = await account("worker");
    const p = await project(lead, lead, [{ who: worker }]);
    const id = await task(lead, p.id, { title: "Original" });
    await db.task.update({ where: { id }, data: { version: 3 } });
    const before = await db.actionLog.count({ where: { targetType: "task", targetId: id, action: "task.updated" } });

    // Warm the route so the burst is not mixed with the first compile.
    const warm = await worker.c.patch(`/api/tasks/${id}`, { title: "Warm", version: "abc" });
    expect(warm.status).toBe(400);

    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) => worker.c.patch(`/api/tasks/${id}`, { title: `N${i}`, version: 3 })),
    );
    const won = results.filter((r) => r.status === 200);
    const lost = results.filter((r) => r.status === 409);
    expect(results.filter((r) => r.status !== 200 && r.status !== 409).map((r) => r.status)).toEqual([]);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(CONCURRENT - 1);
    for (const r of lost) expect(r.json.code).toBe("version_conflict");

    const after = (await worker.c.get(`/api/tasks/${id}`)).json.task as { title: string; version: number };
    expect(after.version).toBe(4);
    expect(after.title).toBe(won[0].json.task.title);
    expect(after.title).toMatch(/^N\d+$/);
    expect(await db.actionLog.count({ where: { targetType: "task", targetId: id, action: "task.updated" } })).toBe(before + 1);
  }, 60_000);
});
