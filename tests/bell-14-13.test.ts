// SHO-US-14.13: notification triage (list filter, mark unread, paging). Opening the bell is a client matter: nothing here marks read.
import { describe, expect, it } from "vitest";
import { account, project, task } from "./helpers";

describe("notification triage (14.13)", () => {
  it("keeps unread until read, filters unread, marks unread again and raises the badge", async () => {
    const lead = await account("lead");
    const ed = await account("ed");
    const p = await project(lead, lead, [{ who: ed }]);
    for (let i = 0; i < 5; i++) await task(lead, p.id, { dueDate: "2031-03-20", assigneeId: ed.id, title: `Job ${i}` });
    const before = (await ed.c.get("/api/notifications")).json;
    const mine = before.items.filter((n: { text: string }) => /Job/.test(n.text));
    expect(mine.length).toBe(5);
    expect(before.unread).toBeGreaterThanOrEqual(5);
    // reading the list changes nothing
    expect((await ed.c.get("/api/notifications")).json.unread).toBe(before.unread);

    expect((await ed.c.post(`/api/notifications/${mine[0].id}/read`)).status).toBe(204);
    const afterRead = (await ed.c.get("/api/notifications")).json;
    expect(afterRead.unread).toBe(before.unread - 1);

    const unreadOnly = (await ed.c.get("/api/notifications?filter=unread")).json;
    expect(unreadOnly.items.every((n: { read: boolean }) => !n.read)).toBe(true);
    expect(unreadOnly.items.some((n: { id: string }) => n.id === mine[0].id)).toBe(false);

    expect((await ed.c.post(`/api/notifications/${mine[0].id}/unread`)).status).toBe(204);
    const back = (await ed.c.get("/api/notifications")).json;
    expect(back.unread).toBe(before.unread);
    expect((await ed.c.get("/api/notifications?filter=unread")).json.items.some((n: { id: string }) => n.id === mine[0].id)).toBe(true);

    // someone else's notice cannot be changed
    expect((await lead.c.post(`/api/notifications/${mine[1].id}/read`)).status).toBe(204);
    expect((await ed.c.get("/api/notifications")).json.unread).toBe(before.unread);

    await ed.c.post("/api/notifications/read-all");
    const empty = (await ed.c.get("/api/notifications?filter=unread")).json;
    expect(empty.items).toEqual([]);
    expect(empty.unread).toBe(0);
  });

  it("returns 50 at a time and loads older ones on request, with no gaps or repeats", async () => {
    const lead = await account("lead");
    const ed = await account("ed");
    const p = await project(lead, lead, [{ who: ed }]);
    for (let b = 0; b < 3; b++) await Promise.all(Array.from({ length: 20 }, (_, i) => task(lead, p.id, { dueDate: "2031-03-20", assigneeId: ed.id, title: `Bulk ${b}-${i}` })));
    const first = (await ed.c.get("/api/notifications")).json;
    expect(first.items.length).toBe(50);
    expect(first.next).toBeTruthy();
    const second = (await ed.c.get(`/api/notifications?before=${encodeURIComponent(first.next)}`)).json;
    expect(second.items.length).toBeGreaterThanOrEqual(10);
    const ids = [...first.items, ...second.items].map((n: { id: string }) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.next).toBe(null);
    expect(ids.length).toBe(first.unread);
  }, 90000);
});
