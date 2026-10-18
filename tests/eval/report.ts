// The job summary and the artifact. Pass rate counts only prompts that passed both runs.
import { CATEGORIES, type Category, type Status } from "./types";

export const OVERALL_MIN = 0.95;
export const CATEGORY_MIN = 0.9;

export type PromptRow = { id: string; category: Category; status: Status; reasons: string[] };

export type CategoryScore = {
  category: Category;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  rate: number;
};

export type Gate = {
  ok: boolean;
  overall: { total: number; passed: number; failed: number; flaky: number; rate: number };
  categories: CategoryScore[];
  flaky: { id: string; category: Category }[];
  reasons: string[];
};

const rate = (passed: number, total: number) => (total === 0 ? 0 : passed / total);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function evaluateGate(rows: PromptRow[]): Gate {
  const categories: CategoryScore[] = CATEGORIES.map((category) => {
    const mine = rows.filter((r) => r.category === category);
    const passed = mine.filter((r) => r.status === "pass").length;
    const failed = mine.filter((r) => r.status === "fail").length;
    const flaky = mine.filter((r) => r.status === "flaky").length;
    return { category, total: mine.length, passed, failed, flaky, rate: rate(passed, mine.length) };
  });
  const passed = rows.filter((r) => r.status === "pass").length;
  const failed = rows.filter((r) => r.status === "fail").length;
  const flaky = rows.filter((r) => r.status === "flaky").length;
  const overall = { total: rows.length, passed, failed, flaky, rate: rate(passed, rows.length) };
  const reasons: string[] = [];
  if (overall.total === 0) reasons.push("no prompts ran");
  if (overall.rate < OVERALL_MIN) reasons.push(`overall ${pct(overall.rate)} is below ${pct(OVERALL_MIN)}`);
  for (const c of categories) {
    if (c.total === 0) reasons.push(`${c.category} has no prompts`);
    else if (c.rate < CATEGORY_MIN) reasons.push(`${c.category} ${pct(c.rate)} is below ${pct(CATEGORY_MIN)}`);
  }
  return {
    ok: reasons.length === 0,
    overall,
    categories,
    flaky: rows.filter((r) => r.status === "flaky").map((r) => ({ id: r.id, category: r.category })),
    reasons,
  };
}

const cell = (n: number) => String(n);

/** Markdown table for the job summary and the artifact. */
export function renderSummary(o: {
  model: string;
  gate: Gate;
  spentUsd: number;
  estimatedUsd: number;
  stopped?: string;
}): string {
  const head = `| Category | Passed | Flaky | Failed | Total | Rate |\n| --- | ---: | ---: | ---: | ---: | ---: |`;
  const lines = o.gate.categories.map((c) =>
    `| ${c.category} | ${cell(c.passed)} | ${cell(c.flaky)} | ${cell(c.failed)} | ${cell(c.total)} | ${pct(c.rate)} |`);
  const g = o.gate.overall;
  lines.push(`| **Overall** | ${cell(g.passed)} | ${cell(g.flaky)} | ${cell(g.failed)} | ${cell(g.total)} | ${pct(g.rate)} |`);
  const flaky = o.gate.flaky.length ? o.gate.flaky.map((f) => `- ${f.id} (${f.category})`).join("\n") : "None.";
  const why = o.gate.reasons.length ? o.gate.reasons.map((r) => `- ${r}`).join("\n") : "None.";
  return [
    `## Concierge eval — ${o.model}`,
    "",
    head,
    ...lines,
    "",
    `Gate: ${pct(OVERALL_MIN)} overall and ${pct(CATEGORY_MIN)} in every category. Result: ${o.gate.ok ? "pass" : "fail"}.`,
    "",
    "Flaky prompts (one pass and one fail; not counted as a pass):",
    flaky,
    "",
    o.stopped ? `Stopped: ${o.stopped}` : "Ran every prompt twice.",
    `Spent $${o.spentUsd.toFixed(4)} of the $${(1).toFixed(2)} cap. Preflight estimate $${o.estimatedUsd.toFixed(4)}.`,
    "",
    "Why the gate failed:",
    why,
    "",
  ].join("\n");
}

/** Drop anything that looks like a provider key before it can reach a log or an artifact. */
export function redact(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/ANTHROPIC_API_KEY=\S+/g, "ANTHROPIC_API_KEY=[redacted]");
}
