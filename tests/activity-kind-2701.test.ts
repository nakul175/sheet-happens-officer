// SHO-2701: Activity rows carry a stable event kind, and the screen branches on it instead of the sentence.
// Two halves. The first reads the real endpoint: every row must name its kind, and a known delete must be
// `task.deleted`. The second is pure: the sentence is free to be reworded without moving the branch.
import { describe, expect, it } from "vitest";
import { account, patchTask, project, task } from "./helpers";
import { TASK_DELETED } from "../src/lib/activity-text";
import { showTooOld, showUndo } from "../src/lib/activity-row";

describe("SHO-2701 the activity API names the event kind", () => {
  it("AC1: every row carries a kind, and a known delete is task.deleted whatever the sentence says", async () => {
    const lead = await account("klead");
    const ed = await account("ked");
    const p = await project(lead, lead, [{ who: ed }]);
    const gone = await task(lead, p.id, { dueDate: "2031-03-20", title: "Kind me a delete" });
    const kept = await task(ed, p.id, { dueDate: "2031-03-20", title: "Kind me an update" });
    expect((await lead.c.del(`/api/tasks/${gone}`)).status).toBe(204);
    const upd = await patchTask(ed, kept, { dueDate: "2026-10-14" });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);

    const res = await lead.c.get(`/api/projects/${p.id}/activity`);
    expect(res.status).toBe(200);
    const rows = res.json.items as { what: string; kind?: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // The known event: the kind is the action the row was written with, not the words the screen shows.
    const del = rows.find((r) => /Kind me a delete/.test(r.what) && r.kind === TASK_DELETED);
    expect(del, `a task.deleted row in ${JSON.stringify(rows.map((r) => [r.kind, r.what]))}`).toBeTruthy();
    expect(del!.what).toBe('moved "Kind me a delete" to Trash'); // the wording is still there, unchanged

    // Every row names a dotted lowercase kind, and no kind is its sentence.
    for (const r of rows) {
      expect(r.kind, `kind missing on "${r.what}"`).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]+)*$/);
      expect(r.kind).not.toBe(r.what);
    }
    const update = rows.find((r) => /Kind me an update/.test(r.what))!;
    expect(update.kind).toBe("task.updated");
  });
});

describe("SHO-2701 the branch follows the kind, not the sentence", () => {
  const row = (kind: string | undefined, what: string, undo: "available" | "undone" | "too_old" | "none" = "available") => ({ kind, what, undo });

  it("AC1: a reworded delete still hides Undo from an Editor, and the old words alone do not", () => {
    // Same kind, three sentences: one decision for every wording, so a copy edit cannot move the branch.
    for (const what of [
      'moved "Fix invoice" to Trash',
      'threw "Fix invoice" in the bin',
      'sent "Fix invoice" to the bin for 30 days',
    ]) expect(showUndo(row(TASK_DELETED, what), "EDITOR"), what).toBe(false);
    // A Leader keeps it, also whatever the words.
    expect(showUndo(row(TASK_DELETED, 'threw "Fix invoice" in the bin'), "LEADER")).toBe(true);

    // The exact old delete wording on a row of another kind is not a delete: prose is not the branch.
    expect(showUndo(row("task.updated", 'moved "Fix invoice" to Trash'), "EDITOR")).toBe(true);
    // A row with no kind is never guessed from its text.
    expect(showUndo(row(undefined, 'moved "Fix invoice" to Trash'), "EDITOR")).toBe(true);
  });

  it("AC1: 'Too old to undo' reads the same kind, so a reworded delete past the window stays hidden from an Editor", () => {
    for (const what of ['moved "Fix invoice" to Trash', 'binned "Fix invoice"']) {
      expect(showTooOld(row(TASK_DELETED, what, "too_old"), "EDITOR"), what).toBe(false);
      expect(showTooOld(row(TASK_DELETED, what, "too_old"), "LEADER"), what).toBe(true);
    }
    expect(showTooOld(row("task.updated", 'moved "Fix invoice" to Trash', "too_old"), "EDITOR")).toBe(true);
    expect(showTooOld(row(undefined, 'moved "Fix invoice" to Trash', "too_old"), "EDITOR")).toBe(true);
  });
});
