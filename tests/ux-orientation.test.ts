// SHO-US-14.4 first-run orientation: Leaders list, request to be added, Team roles, dismiss.
import { describe, expect, it } from "vitest";
import { Client, PW, account, project } from "./helpers";

describe("orientation", () => {
  it("lists Leaders by name only and lets a newcomer ask one, once a day", async () => {
    const lead = await account("olead");
    const newbie = await account("onew");
    const p = await project(lead, lead);
    const r = (await newbie.c.get("/api/leaders")).json;
    expect(r.kind).toBe("LEADER");
    expect(r.people.find((x: { id: string }) => x.id === lead.id)).toEqual({ id: lead.id, name: "Olead" });
    expect(JSON.stringify(r)).not.toContain(p.id); // no project ids or names leak
    const q1 = await newbie.c.post(`/api/leaders/${lead.id}/request`);
    expect(q1.status).toBe(200);
    expect(q1.json.already).toBe(false);
    expect((await newbie.c.post(`/api/leaders/${lead.id}/request`)).json.already).toBe(true);
    const n = (await lead.c.get("/api/notifications")).json.items.find((i: { text: string }) => /asked to be added/.test(i.text));
    expect(n.text).toMatch(/Onew asked to be added/);
    // someone who is not a Leader cannot be asked
    expect((await newbie.c.post(`/api/leaders/${newbie.id}/request`)).status).toBe(404);
  });

  it("shows each person's role and the projects they lead that the viewer can see", async () => {
    const lead = await account("tlead");
    const outsider = await account("tout");
    const insider = await account("tin");
    const p = await project(lead, lead, [{ who: insider }]);
    const seen = (await insider.c.get("/api/team")).json.people as { id: string; orgRole: string; leads: { id: string }[] }[];
    expect(seen.find((x) => x.id === lead.id)).toMatchObject({ orgRole: "MEMBER", leads: [{ id: p.id }] });
    const out = (await outsider.c.get("/api/team")).json.people as { id: string; leads: unknown[] }[];
    expect(out.find((x) => x.id === lead.id)!.leads).toEqual([]);
  });

  it("remembers the dismissed guide on the person, not the device", async () => {
    const a = await account("guide");
    expect((await a.c.get("/api/auth/me")).json.user.startGuide).toBe(true); // first visit
    expect((await a.c.post("/api/profile/start-guide")).status).toBe(200);
    // a second sign-in (another device) still sees it dismissed: the flag is on the account
    const other = new Client();
    expect((await other.post("/api/auth/signin", { email: a.email, password: PW })).status).toBe(200);
    expect((await other.get("/api/auth/me")).json.user.startGuide).toBe(false);
  });
});
