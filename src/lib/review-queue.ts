/** Read-only presentation of existing /api/review eligibility groups. */
export type DealRow = { id: string; name: string; stage: string | null; pipeline: string | null; organisation: { id: string; name: string } | null; leader: { name: string } | null; nextStep: { title: string; dueDate: string | null } | null; lastActivity?: string };
export type Idea = { id: string; title: string; dueDate: string | null; createdAt: string; assignee: { id: string; name: string }; project: { id: string; name: string }; canEdit: boolean };
export type Counts = { id: string; name: string; stages: { id: string; name: string; count: number; sums: { currency: string; total: number }[]; withoutValue: number }[] }[];
export type ReviewData = { needsNextStep: DealRow[]; overdueNextStep: DealRow[]; stalled: DealRow[]; ideas: Idea[]; counts: Counts; otherCounts: Counts; unclassifiedCounts: Counts; timeline: string; openCommercialCount: number; headlineRule: string };
export type ReviewCategory = "all" | "missing" | "overdue" | "inactive" | "ideas";
export type QueueRow = { key: string; name: string; reasons: Exclude<ReviewCategory, "all">[]; deal?: DealRow; idea?: Idea };
const rank = { overdue: 0, missing: 1, inactive: 2, ideas: 3 };
export function reviewQueue(data: Pick<ReviewData, "needsNextStep" | "overdueNextStep" | "stalled" | "ideas">) {
  const rows = new Map<string, QueueRow>();
  for (const [reason, deals] of [["overdue", data.overdueNextStep], ["missing", data.needsNextStep], ["inactive", data.stalled]] as const) {
    for (const deal of deals) {
      const key = `opportunity:${deal.id}`, prior = rows.get(key);
      if (prior) { if (!prior.reasons.includes(reason)) prior.reasons.push(reason); prior.deal = { ...prior.deal!, ...deal, nextStep: prior.deal?.nextStep ?? deal.nextStep, lastActivity: deal.lastActivity ?? prior.deal?.lastActivity }; }
      else rows.set(key, { key, name: deal.name, deal, reasons: [reason] });
    }
  }
  for (const idea of data.ideas) rows.set(`idea:${idea.id}`, { key: `idea:${idea.id}`, name: idea.title, idea, reasons: ["ideas"] });
  const date = (r: QueueRow) => r.deal?.nextStep?.dueDate ?? r.idea?.createdAt ?? r.deal?.lastActivity ?? "\uffff";
  const result = [...rows.values()].sort((a, b) => Math.min(...a.reasons.map(r => rank[r])) - Math.min(...b.reasons.map(r => rank[r])) || date(a).localeCompare(date(b)) || a.name.localeCompare(b.name, "en") || a.key.localeCompare(b.key));
  return { rows: result, counts: { all: result.length, missing: result.filter(r => r.reasons.includes("missing")).length, overdue: result.filter(r => r.reasons.includes("overdue")).length, inactive: result.filter(r => r.reasons.includes("inactive")).length, ideas: result.filter(r => r.reasons.includes("ideas")).length } };
}
