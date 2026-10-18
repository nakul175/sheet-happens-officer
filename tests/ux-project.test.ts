// SHO-US-14.17 create a project and add people in one step.
import { describe, expect, it } from "vitest";
import { account, superAdmin } from "./helpers";

describe("create a project with people", () => {
  it("adds three people at once, Editor unless Viewer is chosen", async () => {
    const lead = await account("clead");
    const a = await account("ca"), b = await account("cb"), c = await account("cc");
    const r = await lead.c.post("/api/projects", { name: "Kickoff", leaderId: lead.id, members: [{ userId: a.id }, { userId: b.id, role: "VIEWER" }, { userId: c.id, role: "EDITOR" }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const p = (await lead.c.get(`/api/projects/${r.json.project.id}`)).json.project;
    const role = (id: string) => p.members.find((m: { userId: string }) => m.userId === id)?.role;
    expect(role(lead.id)).toBe("LEADER");
    expect(role(a.id)).toBe("EDITOR");
    expect(role(b.id)).toBe("VIEWER");
    expect(role(c.id)).toBe("EDITOR");
    const n = (await a.c.get("/api/notifications")).json.items.find((i: { text: string }) => /added you to "Kickoff"/.test(i.text));
    expect(n).toBeTruthy();
  });
  it("refuses a deactivated person and ignores the Leader and creator in the list", async () => {
    const sa = await superAdmin();
    const lead = await account("clead2");
    const gone = await account("cgone");
    const ok = await account("cok");
    expect((await sa.c.post(`/api/team/${gone.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    const bad = await lead.c.post("/api/projects", { name: "X", leaderId: lead.id, members: [{ userId: gone.id }] });
    expect(bad.status).toBe(400);
    const fine = await lead.c.post("/api/projects", { name: "Y", leaderId: ok.id, members: [{ userId: ok.id }, { userId: lead.id, role: "VIEWER" }] });
    expect(fine.status).toBe(201);
    const p = (await ok.c.get(`/api/projects/${fine.json.project.id}`)).json.project;
    expect(p.members.map((m: { role: string }) => m.role).sort()).toEqual(["EDITOR", "LEADER"]); // creator keeps the Editor seat
  });
});
