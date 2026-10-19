// Deal-board helpers shared by the APL-2542 specs (APL-2542.spec.ts and APL-2542-totals.spec.ts).
import { expect, zz, type Api } from "../support";
import { ymd, type Who } from "../g2";
import type { Page } from "@playwright/test";

export type Later = (fn: () => Promise<unknown>) => void;
export type Stage = { id: string; name: string; category: string; needsReason: boolean; requiredFields: string[] };
export type Pipe = { id: string; key: string; name: string; stages: Stage[] };
export type Deal = {
  id: string; name: string; archived: boolean; value: number | null; currency: string | null;
  stage: { id: string; name: string; category: string } | null; submissionDeadline: string | null;
  nextStep: { id: string; title: string } | null;
};

export async function pipelines(api: Api) {
  const r = await api.get("/api/deals/pipelines");
  expect(r.status).toBe(200);
  const list = r.json.pipelines as Pipe[];
  return { pro: list.find((p) => p.key === "DEAL_PROACTIVE")!, bid: list.find((p) => p.key === "DEAL_BID")! };
}

export async function makeDeal(admin: Who, later: Later, o: {
  label: string; leaderId?: string; pipe?: Pipe; due?: string; step?: string; deadline?: string;
  value?: number; currency?: "INR" | "USD" | "EUR";
}) {
  const org = await admin.api.post("/api/orgs", { name: zz(`org ${o.label}`) });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${orgId}/archive`, { archive: true }));
  const pipes = await pipelines(admin.api);
  const pipe = o.pipe ?? pipes.pro;
  const step = o.step ?? zz(`step ${o.label}`);
  const name = zz(`deal ${o.label}`);
  const body: Record<string, unknown> = {
    name, organisationId: orgId, pipelineId: pipe.id, leaderId: o.leaderId ?? admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: step, dueDate: o.due ?? ymd(5) },
  };
  if (pipe.key === "DEAL_BID") body.submissionDeadline = o.deadline ?? ymd(14);
  if (o.value !== undefined) { body.value = o.value; body.currency = o.currency; }
  const d = await admin.api.post("/api/deals", body);
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  const id = d.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return { id, name, step, pipe };
}

export const dealsOf = async (api: Api, pipeId: string, extra = "") =>
  (await api.get(`/api/deals?pipelineId=${pipeId}${extra}`)).json.deals as Deal[];

/** The board reads text/deal from the drop. A real drag is simulated with one DataTransfer, which is what the card writes in dragstart. */
export async function dropDeal(page: Page, dealName: string, column: string) {
  // The card is found by its "Move <deal>" menu button and the column by its region name. No class selectors.
  const move = page.getByRole("button", { name: `Move ${dealName}`, exact: true });
  const region = page.getByRole("region", { name: column, exact: true });
  await move.scrollIntoViewIfNeeded();
  await region.scrollIntoViewIfNeeded();
  const [trigger, col] = [await move.elementHandle(), await region.elementHandle()];
  if (!trigger || !col) throw new Error(`missing ${trigger ? "column" : "card"} for ${dealName} -> ${column}`);
  await page.evaluate(([trigger, col]) => {
    const card = trigger.closest("[draggable='true']");
    if (!card) throw new Error("the Move button is not inside a draggable deal card");
    const dataTransfer = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    col.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    col.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, [trigger, col] as const);
}
