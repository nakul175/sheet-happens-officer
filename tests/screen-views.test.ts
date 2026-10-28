// SHO-2594: real DB visibility, concurrent limits and owner rules. No record data is stored in views.
import { expect, it } from "vitest";
import { account, cleanupZz, project, superAdmin } from "./helpers";
it("SHO-2594 shares filters per viewer, enforces owner rules and atomic private limits", async () => {
  const owner = await account("zzviewowner"), member = await account("zzviewmember"), outsider = await account("zzviewoutside");
  const ids: string[] = [], projects: string[] = [];
  const input = (name: string, scope = "PRIVATE", projectId: string | null = null) => ({ screen: "DEALS", name, scope, projectId, state: { atRisk: true, organisationId: "filter-only" } });
  try {
    const p = await project(owner, owner, [{ who: member, role: "VIEWER" }], "ZZ-TEST shared saved view"); projects.push(p.id);
    for (const scope of ["PRIVATE", "WORKSPACE", "PROJECT"]) {
      const r = await owner.c.post("/api/screen-views", input(`Scope ${scope}`, scope, scope === "PROJECT" ? p.id : null));
      expect(r.status).toBe(201); ids.push(r.json.view.id);
      expect(r.json.view.owner.id).toBe(owner.id);
      expect(r.json.view.href).toContain("organisationId=filter-only");
    }
    const list = async (who: typeof owner) => (await who.c.get("/api/screen-views?screen=DEALS")).json.views as { id: string; canEdit: boolean }[];
    expect((await list(member)).filter(v => ids.includes(v.id)).map(v => v.id).sort()).toEqual(ids.slice(1).sort());
    expect((await list(outsider)).filter(v => ids.includes(v.id)).map(v => v.id)).toEqual([ids[1]]);
    expect((await member.c.patch(`/api/screen-views/${ids[1]}`, input("Take over", "WORKSPACE"))).status).toBe(403);
    expect((await outsider.c.patch(`/api/screen-views/${ids[2]}`, input("Hidden", "WORKSPACE"))).status).toBe(404);
    expect((await owner.c.del(`/api/screen-views/${ids[1]}`)).status).toBe(409);
    const sa = await superAdmin();
    const edited = await sa.c.patch(`/api/screen-views/${ids[1]}`, input("Admin edit", "WORKSPACE"));
    expect(edited.status).toBe(200); expect(edited.json.view.owner.id).toBe(owner.id);
    expect((await owner.c.del(`/api/projects/${p.id}/members/${member.id}`)).status).toBe(204);
    expect((await list(member)).some(v => v.id === ids[2])).toBe(false);
    // One private view already exists. Parallel writes must admit exactly nine more.
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => owner.c.post("/api/screen-views", input(`Concurrent ${i}`))));
    for (const r of results) if (r.status === 201) ids.push(r.json.view.id);
    expect(results.filter(r => r.status === 201)).toHaveLength(9);
    expect(results.filter(r => r.status === 409)).toHaveLength(3);
    const otherScreen = await owner.c.post("/api/screen-views", { ...input("Other screen"), screen: "ACCOUNTS" });
    expect(otherScreen.status).toBe(201); ids.push(otherScreen.json.view.id);
    expect((await outsider.c.get("/api/deals")).json.deals.filter((d: { id: string }) => d.id === p.id)).toEqual([]);
  } finally {
    for (const id of ids) expect((await owner.c.del(`/api/screen-views/${id}?confirmShared=true`)).status).toBe(204);
    await cleanupZz(projects, [owner, member, outsider]);
  }
});
