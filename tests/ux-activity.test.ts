// SHO-US-14.14 readable activity.
import { describe, expect, it } from "vitest";
import { account, project, task, patchTask } from "./helpers";
import { sentence, shortDay, whenText } from "../src/lib/activity-text";

const names = new Map([["u1", "Priya"], ["s1", "To do"], ["s2", "Done"], ["t:t1", "Prepare handover doc"]]);
const row = (action: string, before: unknown, after: unknown, targetId = "t1") => ({ action, beforeState: before, afterState: after, targetId });

describe("sentences", () => {
  const now = new Date("2026-10-18T06:00:00Z");
  it("reads a date change as 'from 10 Oct to 14 Oct'", () => {
    const s = sentence(row("task.updated", { dueDate: "2026-10-09T18:30:00.000Z" }, { dueDate: "2026-10-13T18:30:00.000Z" }), names, now);
    expect(s).toBe('changed due date from 10 Oct to 14 Oct on "Prepare handover doc"');
  });
  it("joins several changes to one task", () => {
    expect(sentence(row("task.updated", { dueDate: "2026-10-09T18:30:00.000Z", priority: "MEDIUM" }, { dueDate: "2026-10-13T18:30:00.000Z", priority: "HIGH" }), names, now))
      .toBe('changed due date from 10 Oct to 14 Oct and priority from Medium to High on "Prepare handover doc"');
  });
  it("uses names, not ids or field names", () => {
    expect(sentence(row("task.deleted", { title: "Prepare handover doc", sectionId: "s1", deletedAt: null }, { deletedAt: "2026-10-18T06:00:00.000Z" }), names, now)).toBe('moved "Prepare handover doc" to Trash');
    expect(sentence(row("task.assigned", { assigneeId: "gone" }, { assigneeId: "u1" }), names, now)).toBe('assigned "Prepare handover doc" to Priya (was someone no longer on the project)');
    expect(sentence(row("task.moved", { sectionId: "s1" }, { sectionId: "s2" }), names, now)).toBe('moved "Prepare handover doc" from To do to Done');
  });
  it("shows India time without ISO", () => {
    expect(shortDay("2026-10-14", now)).toBe("14 Oct");
    expect(shortDay("2025-01-05", now)).toBe("5 Jan 2025");
    expect(whenText(new Date("2026-10-18T10:12:00Z"), now)).toBe("18 Oct, 3:42 pm");
  });
});

describe("activity feed", () => {
  it("has no ids, field names or ISO times, and scopes an Editor to their tasks", async () => {
    const lead = await account("alead");
    const ed = await account("aed");
    const other = await account("aoth");
    const view = await account("aview");
    const p = await project(lead, lead, [{ who: ed }, { who: other }, { who: view, role: "VIEWER" }]);
    const mine = await task(lead, p.id, { title: "Mine to do", assigneeId: ed.id, dueDate: "2026-10-10" });
    const theirs = await task(lead, p.id, { dueDate: "2031-03-20", title: "Theirs alone", assigneeId: other.id });
    expect((await patchTask(ed, mine, { dueDate: "2026-10-14" })).status).toBe(200);
    await lead.c.del(`/api/tasks/${theirs}`);
    const all = (await lead.c.get(`/api/projects/${p.id}/activity`)).json.items as { who: string; what: string; when: string; via: string }[];
    const blob = JSON.stringify(all.map(({ who, what, when, via }) => ({ who, what, when, via }))); // the row id only drives Undo and is never shown
    expect(blob).not.toMatch(/cm[a-z0-9]{20,}/); // no database ids
    expect(blob).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/); // no ISO timestamps
    expect(blob).not.toMatch(/deletedAt|sectionId|assigneeId|dueDate/);
    expect(all.some((r) => /changed due date from 10 Oct to 14 Oct on "Mine to do"/.test(r.what))).toBe(true);
    expect(all.some((r) => r.what === 'moved "Theirs alone" to Trash' && r.who === "Alead")).toBe(true);
    // AC3: the Editor sees only tasks they are on
    const e = (await ed.c.get(`/api/projects/${p.id}/activity`)).json.items as { what: string }[];
    expect(e.length).toBeGreaterThan(0);
    expect(e.every((r) => /Mine to do/.test(r.what))).toBe(true);
    // Editors cannot undo what others did; Viewers have no Activity
    const eRows = (await ed.c.get(`/api/projects/${p.id}/activity`)).json.items as { who: string; undo: string }[];
    expect(eRows.filter((r) => r.who !== "Aed").every((r) => r.undo === "none")).toBe(true);
    expect((await view.c.get(`/api/projects/${p.id}/activity`)).status).toBe(403);
  });
});
