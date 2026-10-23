// SHO-2840 (Pam #128, AC17 boundary at the wire): the 200-comment cap on the Undo of a comment delete.
// The other vitest cases assert the status on the thrown ApiError; this file proves the HTTP answer and the
// live row count through the running server, so a change in the route wrapper or in `handle` cannot hide it.
// 199 live -> the Undo lands on exactly 200; 200 live -> 409 with { code: "too_many_comments" }; an
// out-of-band 201 live -> 409 as well and never 202. Fills are written straight to the table (the API
// refuses the 201st comment by design, so 201 is only reachable out of band).
import { expect, it } from "vitest";
import { account, project, task } from "./helpers";
import { db } from "./concierge-helpers";

it("qa:TC SHO-2840 wire: Undo of a delete at 199 live lands on 200, at 200 returns 409 too_many_comments, at 201 returns 409 and never 202", async () => {
  const lead = await account("capwire");
  const p = await project(lead, lead, []);
  const fill = (taskId: string, n: number, tag: string) =>
    db.comment.createMany({ data: Array.from({ length: n }, (_, i) => ({ taskId, authorId: lead.id, text: `ZZ-TEST 2840 wire ${tag} ${i}` })) });
  const live = (taskId: string) => db.comment.count({ where: { taskId, removedAt: null } });
  const seed = async (n: number, tag: string) => {
    const t = await task(lead, p.id, { title: `ZZ-TEST 2840 wire ${tag}` });
    await fill(t, n, tag);
    const first = await db.comment.findFirstOrThrow({ where: { taskId: t, removedAt: null } });
    const gone = await lead.c.del(`/api/tasks/${t}/comments/${first.id}`);
    expect(gone.status, JSON.stringify(gone.json)).toBe(204);
    const undoId = gone.headers.get("x-undo-id");
    expect(undoId, "the delete must hand back an undo id").toBeTruthy();
    return { t, undoId: undoId as string };
  };

  // 199 live: one soft-deleted row, so exactly one free slot and the restore is allowed.
  const a = await seed(200, "199");
  expect(await live(a.t)).toBe(199);
  const ok = await lead.c.post(`/api/actions/${a.undoId}/undo`, {});
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(await live(a.t)).toBe(200);

  // Refilled to 200 live: no slot left, so the same Undo is a 409 conflict carrying the cap code and message.
  const b = await seed(200, "200");
  await fill(b.t, 1, "200-refill");
  expect(await live(b.t)).toBe(200);
  const refused = await lead.c.post(`/api/actions/${b.undoId}/undo`, {});
  expect(refused.status).toBe(409);
  expect(refused.json?.code).toBe("too_many_comments");
  expect(refused.json?.error).toBe("A task can have at most 200 comments.");
  expect(await live(b.t)).toBe(200);

  // 201 live (rows written before the cap or by a migration): refused, and the count never becomes 202.
  const c = await seed(200, "201");
  await fill(c.t, 2, "201-past");
  expect(await live(c.t)).toBe(201);
  const past = await lead.c.post(`/api/actions/${c.undoId}/undo`, {});
  expect(past.status).toBe(409);
  expect(past.json?.code).toBe("too_many_comments");
  expect(await live(c.t)).toBe(201);
}, 180_000);
