// Shared setup for the APL-2505 and APL-2536–APL-2540 story specs.
// Credentials stay in the environment: callers use the admin / member fixtures, which sign in with login().
import { expect, zz, type Api, type Json } from "../support";
import { getTask, ymd, type Who } from "../g2";
import { raw } from "./jim-http";
import type { Page } from "@playwright/test";

export type Later = (fn: () => Promise<unknown>) => void;
export type Act = { id: string; who: string; what: string; undo: "available" | "undone" | "too_old" | "none" };
export type Notice = { id: string; text: string; href: string };

/** The deal panel: the box that holds the Stage group (DealPanel.tsx renders the group as its first child). */
export const dealPanel = (page: Page) => page.getByRole("group", { name: "Stage" }).locator("..");

/** The page, and any box that can scroll sideways (the Accounts table, for example), stays inside the viewport. */
export async function noSideways(page: Page) {
  const extra = await page.evaluate(() => {
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    let box = 0;
    for (const el of document.querySelectorAll("body *")) {
      const ox = getComputedStyle(el).overflowX;
      if (ox !== "auto" && ox !== "scroll") continue;
      box = Math.max(box, el.scrollWidth - el.clientWidth);
    }
    return Math.max(doc, box);
  });
  expect(extra, "the page scrolls sideways").toBeLessThanOrEqual(1);
}

export async function createOrg(who: Who, later: Later, label: string, extra: Record<string, unknown> = {}) {
  const name = zz(label);
  const r = await who.api.post("/api/orgs", { ...extra, name });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.organisation.id as string;
  later(() => who.api.post(`/api/orgs/${id}/archive`, { archive: true }));
  return { id, name };
}

/** Body for POST /api/deals. The caller asserts the status: a refusal must not be archived. */
export function dealBody(o: { name: string; organisationId: string; pipelineId: string; leaderId: string; step?: string; due?: string; deadline?: string }) {
  return {
    name: o.name, organisationId: o.organisationId, pipelineId: o.pipelineId, leaderId: o.leaderId, whyPursue: "ZZ-TEST fit",
    nextStep: { title: o.step ?? zz("step"), dueDate: o.due ?? ymd(4) },
    ...(o.deadline ? { submissionDeadline: o.deadline, submissionDeadlineTime: "17:00", submissionDeadlineZone: "Asia/Kolkata" } : {}),
  };
}

export async function createDeal(who: Who, later: Later, body: Record<string, unknown>) {
  const r = await who.api.post("/api/deals", body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.deal.id as string;
  later(() => who.api.post(`/api/projects/${id}/archive`));
  // A reused pool alias (APL-2748) must not stay Leader of the archived deal: deactivate refuses any Leader, archived
  // or not. Registered after the archive, so it runs before it (an archived project is read-only).
  if (body.leaderId && body.leaderId !== who.user.id) {
    later(() => who.api.post(`/api/projects/${id}/leader`, { newLeaderId: who.user.id, previousRole: "EDITOR" }));
  }
  return { id, name: r.json.deal.name as string };
}

export async function projectOf(who: Who, id: string) {
  const r = await who.api.get(`/api/projects/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.project as Json;
}

/** PATCH a task on the version it is at now, and keep the Undo headers the Activity button would use. */
export async function editTask(who: Who, taskId: string, body: Record<string, unknown>) {
  const seen = (await getTask(who, taskId)).updatedAt as string;
  expect(seen, "the task's current updatedAt").toBeTruthy();
  return raw(who, "PATCH", `/api/tasks/${taskId}`, { ...body, expectedUpdatedAt: seen });
}

export async function activity(who: Who, projectId: string) {
  const r = await who.api.get(`/api/projects/${projectId}/activity`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.items as Act[];
}

export async function notices(who: Who) {
  const r = await who.api.get("/api/notifications?limit=200");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.items as Notice[];
}

/** Super Admin audit rows for one person and event. Callers match their own ZZ-TEST target; the list is newest first and capped. */
export async function audit(who: Who, event: string, personId: string) {
  const r = await who.api.get(`/api/audit?event=${encodeURIComponent(event)}&person=${encodeURIComponent(personId)}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.items as { target: string | null; event: string }[];
}

export async function orgPage(api: Api, id: string) {
  const r = await api.get(`/api/orgs/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.organisation as Json;
}
