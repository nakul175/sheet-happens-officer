// Replays the fixed prompt set against the real model and grades the turns.
// npm test does not run this file. The hand-run workflow does.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { costUsd, modelConfig, type ModelConfig } from "../../src/lib/model";
import { sendMessage } from "../../src/lib/concierge/engine";
import { clearProviderDown } from "../../src/lib/concierge/limits";
import { db } from "../../src/lib/db";
import type { Stored } from "../../src/lib/concierge/types";
import { estimateCallUsd, estimateRunUsd, overBudget, RUNS_PER_PROMPT } from "./budget";
import { EVAL_NOW } from "./clock";
import { grade, pairStatus } from "./grader";
import { assertThrowawayDatabase } from "./guard";
import { PROMPTS } from "./prompts";
import { evaluateGate, redact, renderSummary, type PromptRow } from "./report";
import { seed, snapshot } from "./seed";
import type { Observation, ObservedOp, ToolCall } from "./types";
import { ensureFeatureColumn, stampEvalUsage, usageWindowStart } from "./usage";

const OUT = path.join(process.cwd(), "tests", "eval", "out");
const BUDGET_MESSAGE = "eval cost estimate passed 1 USD";

type Price = ModelConfig["price"];

type Capture = {
  calls: ToolCall[];
  spentUsd: number;
  observed: number;
  tripped: boolean;
};

function installFetch(price: Price, capture: Capture) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.anthropic.com/")) return real(input, init);
    const raw = typeof init?.body === "string" ? init.body : "";
    let maxTokens: number | undefined;
    try {
      const body = JSON.parse(raw) as { max_tokens?: number };
      maxTokens = body.max_tokens;
    } catch {
      maxTokens = undefined;
    }
    const estimate = estimateCallUsd(raw.length, maxTokens, price);
    if (capture.tripped || overBudget(capture.spentUsd + estimate)) {
      capture.tripped = true;
      throw new Error(BUDGET_MESSAGE);
    }
    const res = await real(input, init);
    try {
      const json = await res.clone().json() as {
        content?: { type?: string; name?: string; input?: unknown }[];
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
      };
      if (res.ok) {
        capture.observed += 1;
        capture.spentUsd += costUsd({
          input: json.usage?.input_tokens ?? 0,
          output: json.usage?.output_tokens ?? 0,
          cacheWrite: json.usage?.cache_creation_input_tokens ?? 0,
          cacheRead: json.usage?.cache_read_input_tokens ?? 0,
        }, price);
        for (const block of json.content ?? []) {
          if (block?.type === "tool_use" && typeof block.name === "string") {
            const toolInput = block.input && typeof block.input === "object" && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {};
            capture.calls.push({ name: block.name, input: toolInput });
          }
        }
        if (overBudget(capture.spentUsd)) capture.tripped = true;
      }
    } catch {
      // The provider client reports a bad response itself. Nothing from it is logged here.
    }
    return res;
  };
  return () => { globalThis.fetch = real; };
}

function opsFrom(stored: Stored | null): ObservedOp[] {
  const ops = stored?.proposal?.ops;
  if (!Array.isArray(ops)) return [];
  return ops.filter((op): op is ObservedOp => !!op && typeof op === "object" && typeof (op as { k?: unknown }).k === "string");
}

async function observe(promptText: string, world: Awaited<ReturnType<typeof seed>>["world"], workspaceId: string, capture: Capture): Promise<Observation> {
  capture.calls = [];
  const before = await snapshot(workspaceId);
  clearProviderDown();
  const result = await sendMessage({ id: world.actor.id, orgRole: world.actor.orgRole }, promptText, EVAL_NOW);
  const after = await snapshot(workspaceId);
  const assistant = [...result.messages].reverse().find((m) => m.role === "ASSISTANT");
  const row = assistant ? await db.chatMessage.findUnique({ where: { id: assistant.id } }) : null;
  const stored = row ? JSON.parse(row.content) as Stored : null;
  if (result.disabled && !assistant) {
    return {
      toolCalls: capture.calls, kind: "notice", text: result.disabled.message, links: [], choices: [],
      cardText: [], ops: [], mutated: before !== after,
    };
  }
  const card = assistant?.card;
  return {
    toolCalls: capture.calls,
    kind: assistant?.kind ?? "notice",
    text: assistant?.text ?? result.disabled?.message ?? "",
    links: assistant?.links ?? [],
    choices: (assistant?.choices ?? []).map((c) => ({ id: c.id, label: c.label })),
    canConfirm: card?.canConfirm,
    blockedReason: card?.blockedReason,
    cardText: card ? [card.title, ...card.changes.flatMap((c) => [c.label, c.before ?? "", c.after ?? ""])] : [],
    ops: opsFrom(stored),
    mutated: before !== after,
  };
}

function prepareEnv() {
  process.env.MODEL_DATA_APPROVED = "true";
  process.env.MODEL_RETRY_DELAY_MS ||= "0";
  process.env.MODEL_TIMEOUT_MS ||= "30000";
  process.env.WEEKLY_MESSAGE_CAP ||= "10000";
  process.env.MONTHLY_CEILING_USD ||= "1000";
  if (!process.env.MODEL_PROVIDER) process.env.MODEL_PROVIDER = "anthropic";
}

function writeOutputs(model: string, markdown: string, artifact: unknown) {
  mkdirSync(OUT, { recursive: true });
  const safe = model.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "unknown";
  writeFileSync(path.join(OUT, "model-name.txt"), safe);
  writeFileSync(path.join(OUT, `concierge-eval-${safe}.json`), redact(JSON.stringify(artifact, null, 2)));
  writeFileSync(path.join(OUT, `concierge-eval-${safe}.md`), redact(markdown));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, redact(markdown));
  console.log(redact(markdown));
}

async function main() {
  prepareEnv();
  assertThrowawayDatabase();
  const cfg = modelConfig();
  if (process.env.EVAL_MODEL_SLOT === "secondary" && cfg.model !== (process.env.MODEL_NAME_SECOND ?? "").trim()) {
    throw new Error("The selected model does not match MODEL_NAME_SECOND.");
  }
  if (cfg.model !== "claude-haiku-5-5" && (!process.env.MODEL_USD_IN_PER_MTOK || !process.env.MODEL_USD_OUT_PER_MTOK)) {
    throw new Error(`Model ${cfg.model} needs MODEL_USD_IN_PER_MTOK and MODEL_USD_OUT_PER_MTOK set to that model's prices.`);
  }
  const estimatedUsd = estimateRunUsd(PROMPTS.length, cfg.price);
  const started = await usageWindowStart();
  const capture: Capture = { calls: [], spentUsd: 0, observed: 0, tripped: false };
  let stopped = "";
  const rows: PromptRow[] = [];
  const detail: unknown[] = [];

  const finish = async (code: number) => {
    const stamped = code === 0 || capture.observed > 0 ? await stampEvalUsage(started).catch(() => -1) : 0;
    if (capture.observed > 0 && stamped !== capture.observed) {
      stopped = stopped || `usage rows stamped feature eval (${stamped}) did not match model calls (${capture.observed})`;
      code = 1;
    }
    const gate = evaluateGate(rows);
    if (stopped) {
      gate.ok = false;
      gate.reasons.push(stopped);
    }
    if (!gate.ok) code = 1;
    const markdown = renderSummary({ model: cfg.model, gate, spentUsd: capture.spentUsd, estimatedUsd, stopped: stopped || undefined });
    writeOutputs(cfg.model, markdown, {
      model: cfg.model,
      estimatedUsd,
      spentUsd: capture.spentUsd,
      budgetUsd: 1,
      usageFeature: "eval",
      usageRows: stamped,
      stopped: stopped || null,
      gate,
      flaky: gate.flaky,
      prompts: detail,
    });
    await db.$disconnect();
    process.exit(code);
  };

  if (overBudget(estimatedUsd)) {
    stopped = `Preflight estimate $${estimatedUsd.toFixed(4)} passed 1 USD. No model call was made.`;
    await finish(1);
  }

  await ensureFeatureColumn();
  const restore = installFetch(cfg.price, capture);
  try {
    for (const prompt of PROMPTS) {
      if (capture.tripped) break;
      const runs: { pass: boolean; reasons: string[] }[] = [];
      for (let run = 0; run < RUNS_PER_PROMPT; run++) {
        if (capture.tripped) break;
        const prev = process.env.CRM_VISIBLE;
        if (prompt.crm) process.env.CRM_VISIBLE = prompt.crm;
        else delete process.env.CRM_VISIBLE;
        try {
          const { world, workspaceId } = await seed(prompt, run);
          const obs = await observe(prompt.text, world, workspaceId, capture);
          const graded = grade(prompt.expect(world), obs);
          runs.push(graded);
          detail.push({
            id: prompt.id, category: prompt.category, run, pass: graded.pass, reasons: graded.reasons,
            tools: obs.toolCalls.map((c) => c.name), kind: obs.kind,
          });
        } catch (e) {
          const message = redact(e instanceof Error ? e.message : "run failed");
          if (message.includes(BUDGET_MESSAGE) || capture.tripped) {
            capture.tripped = true;
            runs.push({ pass: false, reasons: [BUDGET_MESSAGE] });
            break;
          }
          runs.push({ pass: false, reasons: [message] });
          detail.push({ id: prompt.id, category: prompt.category, run, pass: false, reasons: [message] });
        } finally {
          if (prev === undefined) delete process.env.CRM_VISIBLE;
          else process.env.CRM_VISIBLE = prev;
        }
      }
      if (runs.length === RUNS_PER_PROMPT) {
        const status = pairStatus(runs[0].pass, runs[1].pass);
        rows.push({ id: prompt.id, category: prompt.category, status, reasons: runs.flatMap((r) => r.reasons) });
      } else if (runs.length) {
        rows.push({ id: prompt.id, category: prompt.category, status: "fail", reasons: runs.flatMap((r) => r.reasons) });
      }
    }
  } finally {
    restore();
  }
  if (capture.tripped) stopped = stopped || BUDGET_MESSAGE;
  const gate = evaluateGate(rows);
  await finish(gate.ok && !stopped ? 0 : 1);
}

main().catch(async (e) => {
  const message = redact(e instanceof Error ? e.message : "eval failed");
  console.error(message);
  try {
    const cfg = modelConfig();
    writeOutputs(cfg.model, `## Concierge eval — ${cfg.model}\n\nStopped before a result: ${message}\n`, {
      model: cfg.model, stopped: message, prompts: [], flaky: [],
    });
  } catch {
    // The summary is best-effort once setup itself failed.
  }
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
