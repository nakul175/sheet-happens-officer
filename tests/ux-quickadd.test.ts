// SHO-US-14.5 quick add targets and date words.
import { describe, expect, it } from "vitest";
import { account, project, task } from "./helpers";
import { dateLabel, wordsToDate } from "../src/lib/datewords";

describe("date words (AC3)", () => {
  // Wednesday 21 October 2026, noon India time
  const now = new Date("2026-10-21T06:30:00Z");
  it("resolves words to the next date", () => {
    expect(wordsToDate("tomorrow", now)).toBe("2026-10-22");
    expect(wordsToDate("fri", now)).toBe("2026-10-23");
    expect(wordsToDate("Mon", now)).toBe("2026-10-26");
    expect(wordsToDate("next tue", now)).toBe("2026-10-27");
    expect(wordsToDate("wed", now)).toBe("2026-10-28");
    expect(wordsToDate("in 3 days", now)).toBe("2026-10-24");
    expect(wordsToDate("2026-11-02", now)).toBe("2026-11-02");
    expect(wordsToDate("", now)).toBeNull();
    expect(wordsToDate("soonish", now)).toBeNull();
    expect(dateLabel("2026-10-23")).toBe("Fri 23 Oct");
  });
});

describe("quick add targets", () => {
  it("lists only projects where I can write, and remembers the last used", async () => {
    const lead = await account("qlead");
    const ed = await account("qed");
    const vw = await account("qview");
    const a = await project(lead, lead, [{ who: ed }, { who: vw, role: "VIEWER" }]);
    const b = await project(lead, lead, [{ who: ed }]);
    const e1 = (await ed.c.get("/api/quick-add")).json;
    expect(e1.projects.map((p: { id: string }) => p.id).sort()).toEqual([a.id, b.id].sort());
    await task(ed, b.id, { title: "recent" });
    expect((await ed.c.get("/api/quick-add")).json.lastProjectId).toBe(b.id);
    await task(ed, a.id, { title: "newer" });
    expect((await ed.c.get("/api/quick-add")).json.lastProjectId).toBe(a.id);
    // AC4: a person who is only a Viewer gets nothing
    const v = (await vw.c.get("/api/quick-add")).json;
    expect(v.projects).toEqual([]);
    expect(v.lastProjectId).toBeNull();
    // archived projects drop out
    expect((await lead.c.post(`/api/projects/${b.id}/archive`)).status).toBeLessThan(300);
    expect((await ed.c.get("/api/quick-add")).json.projects.map((p: { id: string }) => p.id)).toEqual([a.id]);
  });
  it("assigns the task to the person and gives an undo id", async () => {
    const ed = await account("qed2");
    const p = await project(ed, ed);
    const r = await ed.c.post(`/api/projects/${p.id}/tasks`, { title: "From anywhere", dueDate: "2026-10-30" });
    expect(r.status).toBe(201);
    expect(r.headers.get("x-undo-id")).toBeTruthy();
    const t = await ed.c.get(`/api/tasks/${r.json.task.id}`);
    expect(t.json.task?.assignee?.id ?? t.json.assignee?.id).toBe(ed.id);
  });
});
