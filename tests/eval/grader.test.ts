// AC2: a recorded good turn passes and a recorded bad turn fails. No model is involved.
import { describe, expect, it } from "vitest";
import { grade, pairStatus } from "./grader";
import { evaluateGate, redact, renderSummary } from "./report";
import type { Expectation, Observation } from "./types";

const expectRead: Expectation = {
  tools: [{ name: "my_tasks", input: { filter: "overdue" } }],
  kind: "answer",
  links: [{ href: "/tasks/task_late", labelIncludes: "File the harbor invoice" }],
  requireText: ["File the harbor invoice"],
  forbidText: ["Plan the harbor picnic", "sk-ant-secret"],
};

const good: Observation = {
  toolCalls: [{ name: "my_tasks", input: { filter: "overdue" } }],
  kind: "answer",
  text: "File the harbor invoice (Harbor rollout, due 13 March 2031)",
  links: [{ label: "File the harbor invoice", href: "/tasks/task_late" }],
  choices: [],
  cardText: [],
  ops: [],
  mutated: false,
};

const bad: Observation = {
  toolCalls: [{ name: "find_people", input: { text: "picnic" } }],
  kind: "answer",
  text: "Plan the harbor picnic is overdue. The key is sk-ant-secretvalue.",
  links: [],
  choices: [],
  cardText: [],
  ops: [],
  mutated: false,
};

describe("concierge eval grader", () => {
  it("passes a known-good recorded response", () => {
    const g = grade(expectRead, good);
    expect(g.pass, g.reasons.join("; ")).toBe(true);
  });

  it("fails a known-bad recorded response", () => {
    const g = grade(expectRead, bad);
    expect(g.pass).toBe(false);
    expect(g.reasons.some((r) => r.startsWith("missing tool"))).toBe(true);
    expect(g.reasons.some((r) => r.startsWith("missing link"))).toBe(true);
    expect(g.reasons.some((r) => r.startsWith("forbidden string"))).toBe(true);
  });

  it("grades a card by its operations", () => {
    const expectCard: Expectation = {
      tools: [{ name: "propose_changes" }],
      kind: "card",
      canConfirm: true,
      ops: [{ k: "task.edit", match: { taskId: "t1", due: "2031-03-18" } }],
      forbidText: ["I moved"],
    };
    const card: Observation = {
      toolCalls: [
        { name: "find_tasks", input: { text: "invoice" } },
        { name: "propose_changes", input: { changes: [] } },
      ],
      kind: "card",
      text: "Move 'File the harbor invoice' to Tuesday 18 March 2031. Review it and tap Confirm to apply it.",
      links: [],
      choices: [],
      canConfirm: true,
      cardText: ["Move 'File the harbor invoice' to Tuesday 18 March 2031"],
      ops: [{ k: "task.edit", taskId: "t1", due: "2031-03-18" }],
      mutated: false,
    };
    expect(grade(expectCard, card).pass).toBe(true);
    expect(grade(expectCard, { ...card, ops: [{ k: "task.complete", taskId: "t1" }], canConfirm: true }).pass).toBe(false);
    expect(grade(expectCard, { ...card, mutated: true }).pass).toBe(false);
  });

  it("treats one pass and one fail as flaky, not as a pass", () => {
    expect(pairStatus(true, true)).toBe("pass");
    expect(pairStatus(false, false)).toBe("fail");
    expect(pairStatus(true, false)).toBe("flaky");
    expect(pairStatus(false, true)).toBe("flaky");
    const gate = evaluateGate([
      { id: "reads-overdue", category: "reads", status: "flaky", reasons: ["missing link"] },
    ]);
    expect(gate.overall.passed).toBe(0);
    expect(gate.flaky).toEqual([{ id: "reads-overdue", category: "reads" }]);
    const md = renderSummary({ model: "claude-haiku-5-5", gate, spentUsd: 0.1, estimatedUsd: 0.5 });
    expect(md).toContain("reads-overdue");
    expect(md).toContain("claude-haiku-5-5");
    expect(md).toContain("Flaky");
  });

  it("redacts a provider key", () => {
    expect(redact("leaked sk-ant-api03-abcdef and ANTHROPIC_API_KEY=sk-ant-api03-abcdef")).not.toContain("sk-ant");
  });
});
