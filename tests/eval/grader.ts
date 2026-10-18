// Deterministic grader. It looks at tool calls, card operations and reply shape.
// Free text is required links plus required and forbidden strings. No model grades a model.
import type { Expectation, Grade, Observation, ObservedOp, OpExpect, Status, ToolCall, ToolExpect } from "./types";

const READS = new Set(["my_tasks", "find_tasks", "list_projects", "project_tasks", "find_people"]);
const NOTHING = new Set(["I found nothing.", "I can't find that."]);

const inputMatches = (call: ToolCall, exp: ToolExpect) => {
  if (call.name !== exp.name) return false;
  if (!exp.input) return true;
  for (const [key, value] of Object.entries(exp.input)) {
    if (call.input[key] !== value) return false;
  }
  return true;
};

const opMatches = (op: ObservedOp, exp: OpExpect) => {
  if (op.k !== exp.k) return false;
  if (!exp.match) return true;
  for (const [key, value] of Object.entries(exp.match)) {
    if (op[key] !== value) return false;
  }
  return true;
};

const toolLabel = (exp: ToolExpect) => {
  const bits = exp.input ? Object.entries(exp.input).map(([k, v]) => `${k}=${String(v)}`) : [];
  return bits.length ? `${exp.name} ${bits.join(" ")}` : exp.name;
};

/** Reply text, the card, and the blocked reason, so a forbidden string fails in any of them. */
export function corpus(obs: Observation): string {
  return [obs.text, obs.blockedReason ?? "", ...obs.cardText].join("\n");
}

export function grade(expect: Expectation, obs: Observation): Grade {
  const reasons: string[] = [];
  const reply = obs.text.toLowerCase();
  const body = corpus(obs).toLowerCase();

  if (obs.mutated) reasons.push("the database changed; a proposal must not write anything");

  for (const exp of expect.tools ?? []) {
    if (!obs.toolCalls.some((call) => inputMatches(call, exp))) reasons.push(`missing tool ${toolLabel(exp)}`);
  }
  if (expect.toolsAny?.length && !expect.toolsAny.some((exp) => obs.toolCalls.some((call) => inputMatches(call, exp)))) {
    reasons.push(`missing one of: ${expect.toolsAny.map(toolLabel).join(", ")}`);
  }
  for (const name of expect.forbidTools ?? []) {
    if (obs.toolCalls.some((call) => call.name === name)) reasons.push(`forbidden tool ${name}`);
  }
  if (expect.read && !obs.toolCalls.some((call) => READS.has(call.name))) reasons.push("no read tool was called");

  if (expect.kind) {
    const allowed = Array.isArray(expect.kind) ? expect.kind : [expect.kind];
    if (!allowed.includes(obs.kind as never)) reasons.push(`reply kind ${obs.kind || "none"}, expected ${allowed.join(" or ")}`);
  }
  if (expect.canConfirm !== undefined) {
    if (obs.kind !== "card" || obs.canConfirm !== expect.canConfirm) {
      reasons.push(`canConfirm ${String(obs.canConfirm)}, expected ${String(expect.canConfirm)}`);
    }
  }
  if (expect.blockedOrNoCard) {
    if (obs.kind === "card" && obs.canConfirm !== false) reasons.push("card was confirmable");
    if (obs.kind !== "card" && obs.ops.length > 0) reasons.push("write operations with no blocked card");
  }
  if (expect.choices) {
    if (obs.kind !== "choices" || obs.choices.length < 3) reasons.push("no choice list");
    if (obs.canConfirm === true) reasons.push("guessed with a confirmable card");
  }
  if (expect.foundNothing) {
    if (!NOTHING.has(obs.text.trim())) reasons.push(`reply was not "I found nothing." or "I can't find that."`);
    if (obs.kind !== "answer") reasons.push("a miss must be an answer, not the model's own words");
  }

  const used = new Set<number>();
  for (const exp of expect.ops ?? []) {
    const at = obs.ops.findIndex((op, i) => !used.has(i) && opMatches(op, exp));
    if (at < 0) reasons.push(`missing op ${exp.k}`);
    else used.add(at);
  }
  for (const k of expect.forbidOps ?? []) {
    if (obs.ops.some((op) => op.k === k)) reasons.push(`forbidden op ${k}`);
  }

  for (const link of expect.links ?? []) {
    const hit = obs.links.find((l) => l.href === link.href);
    if (!hit) reasons.push(`missing link ${link.href}`);
    else if (link.labelIncludes && !hit.label.toLowerCase().includes(link.labelIncludes.toLowerCase())) {
      reasons.push(`link ${link.href} label missing ${link.labelIncludes}`);
    }
  }
  for (const s of expect.requireText ?? []) {
    if (!reply.includes(s.toLowerCase())) reasons.push(`reply missing ${JSON.stringify(s)}`);
  }
  for (const s of expect.forbidText ?? []) {
    if (body.includes(s.toLowerCase())) reasons.push(`forbidden string ${JSON.stringify(s)}`);
  }

  return { pass: reasons.length === 0, reasons };
}

/** One pass and one fail is flaky, which is not a pass. */
export function pairStatus(first: boolean, second: boolean): Status {
  if (first && second) return "pass";
  if (!first && !second) return "fail";
  return "flaky";
}
