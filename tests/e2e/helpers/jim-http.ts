// Helpers for the APL-2624, 2640, 2646, 2647, 2648 and 2649 story specs and the jim-gate probes. Credentials come from the environment through ../support.
import { expect, zz, type Json } from "../support";
import type { Who } from "../g2";

/** A call made on the person's own signed-in session that keeps the response headers (the shared `api()` drops them). */
export async function raw(who: Who, method: string, path: string, data?: unknown) {
  const r = await who.page.context().request.fetch(path, {
    method, data: data === undefined ? undefined : data, headers: { "content-type": "application/json" },
  });
  let json: Json = {};
  try { json = await r.json(); } catch { /* not JSON, e.g. 204 */ }
  return { status: r.status(), headers: r.headers(), json };
}

/** Delete a task and return the Undo headers the page would act on (x-undo-id, x-undo-label, x-undo-notified). */
export async function deleteTask(who: Who, taskId: string) {
  const r = await raw(who, "DELETE", `/api/tasks/${taskId}`);
  return { status: r.status, undoId: r.headers["x-undo-id"] ?? null, undoLabel: r.headers["x-undo-label"] ?? null, notified: r.headers["x-undo-notified"] ?? null };
}

/** PATCH a task on the version it is at now. Works before and after SHO-BUG-13 (APL-2648), which makes the version required. */
export async function patchCurrent(who: Who, taskId: string, body: Record<string, unknown>) {
  const seen = (await who.api.get(`/api/tasks/${taskId}`)).json.task?.updatedAt as string;
  expect(seen, "the task's current updatedAt").toBeTruthy();
  return who.api.patch(`/api/tasks/${taskId}`, { ...body, expectedUpdatedAt: seen });
}

/** The Undo toast raised by UndoHost after a change (role="status" with an Undo button, or a status note). */
export const undoToast = (who: Who) => who.page.getByRole("status").filter({ has: who.page.getByRole("button", { name: "Undo", exact: true }) });

/**
 * A ZZ-TEST deal (a project with deal data) led by `leader`, with `members` as Editors. The deal and its organisation are archived afterwards.
 * Same API calls the SHO-BUG-11 server test makes.
 */
export async function newDeal(leader: Who, later: (fn: () => Promise<unknown>) => void, label: string, members: Who[] = []) {
  const pipes = (await leader.api.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pipe = pipes.find((p) => p.key === "DEAL_PROACTIVE") ?? pipes[0];
  expect(pipe, "a deal pipeline").toBeTruthy();
  const org = await leader.api.post("/api/orgs", { name: zz(`${label} org`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => leader.api.post(`/api/orgs/${orgId}/archive`));
  const name = zz(`${label} deal`);
  const ymd = new Date(Date.now() + 5.5 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10);
  const d = await leader.api.post("/api/deals", { name, organisationId: orgId, pipelineId: pipe.id, leaderId: leader.user.id, whyPursue: "ZZ-TEST", nextStep: { title: zz("first step"), dueDate: ymd } });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => leader.api.post(`/api/projects/${id}/archive`));
  for (const m of members) {
    const a = await leader.api.post(`/api/projects/${id}/members`, { userId: m.user.id, role: "EDITOR" });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
  }
  return { id, name };
}

/** A "skip" annotation with a reason, for the Playwright report. The harness itself never skips a test. */
export const why = (description: string) => ({ annotation: { type: "skip", description } });
