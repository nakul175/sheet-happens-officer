// SHO-BUG-7 Removing a member through the concierge sends one notice per task instead of the screen's single handover notice  (Linear APL-2614)
// No numbered ACs in the issue; follows its "Expected" and "Test" paragraphs.
import { test, expect, zz, RUN } from "../support";

test("Reference (screen path): removing a member who holds 3 tasks sends the leaver no per-task notices and logs the removal once", async ({ admin, member, later }) => {
  const pr = await admin.api.post("/api/projects", { name: zz("handover"), leaderId: admin.user.id });
  expect(pr.status).toBe(201);
  const pid = pr.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  for (const n of ["one", "two", "three"]) {
    expect((await admin.api.post(`/api/projects/${pid}/tasks`, { title: zz(`held ${n}`), assigneeId: member.user.id })).status).toBe(201);
  }
  expect((await admin.api.del(`/api/projects/${pid}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBe(204);
  const after = (await member.api.get("/api/notifications")).json.items as { text: string }[];
  const mine = after.filter((n) => /took "ZZ-TEST[^"]* held/.test(n.text) && n.text.includes(RUN));
  expect(mine, "no 'took <task> off you' notice per task").toHaveLength(0);
  expect(after.filter((n) => /removed you from/.test(n.text) && n.text.includes(zz("handover"))), "exactly one removal notice").toHaveLength(1);
  const act = (await admin.api.get(`/api/projects/${pid}/activity`)).json.items as { what: string; kind: string }[];
  // SHO-2701: both counts are on the kind. The one removal is still asserted to read as a removal.
  const removals = act.filter((a) => a.kind === "member.removed");
  expect(removals).toHaveLength(1);
  expect(removals[0].what).toMatch(/^removed /);
  expect(act.filter((a) => a.kind === "task.assigned"), "no per-task reassignment rows on the screen path").toHaveLength(0);
});

test.skip("Concierge path: a confirmed 'remove member' card writes the same notices and log row as the screen", () => {
  // Reason: the concierge needs a model key and MODEL_DATA_APPROVED=on on the server, and a confirmed card cannot be driven without a model reply.
  // The server-side check is tests/concierge-fixes.test.ts (vitest, fake model). The test above is the end state the concierge path must match.
});
