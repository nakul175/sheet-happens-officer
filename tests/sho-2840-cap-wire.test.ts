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
    const t = await task(lead, p.id, { dueDate: "2031-03-20", title: `ZZ-TEST 2840 wire ${tag}` });
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

// A bare `status === 409` cannot tell the cap apart from the undo module's ordinary refusals (an action already
// undone is a 409 with no code, src/lib/undo.ts:412). This pins the refusal to the cap by its code, proves a refused
// Undo is repeatable (it does not burn the action), and walks 201 -> 200 -> 199 live so the boundary is shown from
// above as well.
it("qa:TC SHO-2840 wire: only the cap's 409 carries too_many_comments, and a refused Undo stays refused", async () => {
  const lead = await account("capcode");
  const p = await project(lead, lead, []);
  const fill = (taskId: string, n: number, tag: string) =>
    db.comment.createMany({ data: Array.from({ length: n }, (_, i) => ({ taskId, authorId: lead.id, text: `ZZ-TEST 2840 code ${tag} ${i}` })) });
  const live = (taskId: string) => db.comment.count({ where: { taskId, removedAt: null } });
  const del = async (taskId: string) => {
    const first = await db.comment.findFirstOrThrow({ where: { taskId, removedAt: null } });
    const gone = await lead.c.del(`/api/tasks/${taskId}/comments/${first.id}`);
    expect(gone.status, JSON.stringify(gone.json)).toBe(204);
    return { commentId: first.id, undoId: gone.headers.get("x-undo-id") as string };
  };

  // 200 live, one delete: refused, and the refusal is the cap's, not "already undone".
  const t = await task(lead, p.id, { dueDate: "2031-03-20", title: "ZZ-TEST 2840 code 200" });
  await fill(t, 200, "200");
  const one = await del(t);
  expect(await live(t)).toBe(199);
  expect((await lead.c.post(`/api/tasks/${t}/comments`, { text: "ZZ-TEST 2840 code refill" })).status).toBe(201);
  expect(await live(t)).toBe(200);
  const refused = await lead.c.post(`/api/actions/${one.undoId}/undo`, {});
  expect(refused.status).toBe(409);
  expect(refused.json?.code).toBe("too_many_comments");
  expect(refused.json?.error).toBe("A task can have at most 200 comments.");
  expect(await live(t)).toBe(200);
  // A refused Undo did not consume the action: the second attempt is the same cap refusal, not "already undone".
  const again = await lead.c.post(`/api/actions/${one.undoId}/undo`, {});
  expect(again.status).toBe(409);
  expect(again.json?.code).toBe("too_many_comments");
  expect(await live(t)).toBe(200);
  const log = (await db.actionLog.findMany({ where: { targetId: t, action: "comment.removed" } }))
    .find((l) => (l.afterState as { commentId?: string } | null)?.commentId === one.commentId);
  expect(log?.undoneAt, "a refused Undo must not mark the action undone").toBeNull();

  // One slot freed: the same Undo lands on 200. A further attempt is now the ordinary 409 — no cap code.
  const two = await del(t);
  expect(two.commentId).not.toBe(one.commentId);
  expect(await live(t)).toBe(199);
  const ok = await lead.c.post(`/api/actions/${one.undoId}/undo`, {});
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(await live(t)).toBe(200);
  const replayed = await lead.c.post(`/api/actions/${one.undoId}/undo`, {});
  expect(replayed.status).toBe(409);
  expect(replayed.json?.code, "the already-undone 409 must not look like the cap").toBeUndefined();

  // 201 live, written out of band: refused, and the count never grows. Each slot freed down to 199 lets it through.
  const u = await task(lead, p.id, { dueDate: "2031-03-20", title: "ZZ-TEST 2840 code 201" });
  await fill(u, 200, "201");
  const three = await del(u);
  await fill(u, 2, "201-past");
  expect(await live(u)).toBe(201);
  const over = await lead.c.post(`/api/actions/${three.undoId}/undo`, {});
  expect(over.status).toBe(409);
  expect(over.json?.code).toBe("too_many_comments");
  expect(await live(u)).toBe(201);
  await del(u); // 200 live
  const atCap = await lead.c.post(`/api/actions/${three.undoId}/undo`, {});
  expect(atCap.status).toBe(409);
  expect(atCap.json?.code).toBe("too_many_comments");
  expect(await live(u)).toBe(200);
  await del(u); // 199 live
  const landing = await lead.c.post(`/api/actions/${three.undoId}/undo`, {});
  expect(landing.status, JSON.stringify(landing.json)).toBe(200);
  expect(await live(u)).toBe(200);
}, 180_000);
