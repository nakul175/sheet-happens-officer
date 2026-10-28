// SHO-US-9.1: the one place that talks to a model provider. The concierge asks this wrapper for a
// reply and never knows which provider or model answered. Nothing here touches the database, and
// nothing here logs: chat text, task text and the API key never reach a log.
//
// Configuration (server settings only):
//   MODEL_PROVIDER       "anthropic" (default) or "fake" (tests only; refused when NODE_ENV is production)
//   MODEL_NAME           default "claude-haiku-5-5"
//   SHO_DEPLOY_STAGE     "production" (default when unset) or "staging"; any other value refuses to guess
//   ANTHROPIC_API_KEY    the provider key, read in production only
//   ANTHROPIC_API_KEY_STAGE  the provider key, read in staging only (SHO-2927)
//   MODEL_DATA_APPROVED  must be exactly "true" or no request is ever sent to any provider
//
// SHO-2927: staging used to share the production key because there was only one key variable and no
// environment to choose by. The two keys are now disjoint: staging reads the stage key and never the
// production one, production reads the production key and never the stage one, and an unrecognised
// stage reads neither. A missing key still means "off", so the failure is a disabled concierge, not a
// request sent with no key.
//   MODEL_USD_IN_PER_MTOK, MODEL_USD_OUT_PER_MTOK, MODEL_USD_CACHE_WRITE_PER_MTOK, MODEL_USD_CACHE_READ_PER_MTOK
//   MODEL_RETRY_DELAY_MS (default 2000), MODEL_TIMEOUT_MS (default 15000)

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type ModelMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

export type ModelRequest = {
  /** Stable text first (it is cached), then the per-day text. */
  system: { stable: string; dynamic: string };
  tools: ToolDef[];
  messages: ModelMessage[];
  maxTokens: number;
};
export type ModelUsageCounts = { input: number; output: number; cacheWrite: number; cacheRead: number };
export type ModelResponse = {
  content: ContentBlock[];
  stopReason: string;
  usage: ModelUsageCounts;
};

export type ModelFailure = "NOT_ENABLED" | "PROVIDER_DOWN";
export class ModelError extends Error {
  constructor(public code: ModelFailure, message: string) {
    super(message);
  }
}

export interface ModelProvider {
  readonly name: string;
  complete(req: ModelRequest, cfg: ModelConfig): Promise<ModelResponse>;
}

export type ModelConfig = {
  provider: string;
  model: string;
  apiKey: string;
  approved: boolean;
  retryDelayMs: number;
  timeoutMs: number;
  price: { inPerMTok: number; outPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number };
  /** SHO-2927: which environment this is, which key variable answered, and why a key is missing. */
  stage: ModelStage;
  keySource: ModelKeySource;
  keyProblem: ModelKeyProblem;
};

export type ModelStage = "production" | "staging" | "unknown";
export type ModelKeySource = "production" | "stage" | "none";
export type ModelKeyProblem = "STAGE_KEY_MISSING" | "UNKNOWN_STAGE" | null;

export const STAGE_VAR = "SHO_DEPLOY_STAGE";
export const PRODUCTION_KEY_VAR = "ANTHROPIC_API_KEY";
export const STAGE_KEY_VAR = "ANTHROPIC_API_KEY_STAGE";

/**
 * SHO-2927. Unset means production, which is what every host did before this variable existed, so the
 * production droplet needs no change. Set but empty is a misconfiguration, not production: it fails
 * closed. Only the two exact names are accepted; a typo must never fall back to the production key,
 * because that fallback is the defect.
 */
export function modelStage(env: NodeJS.ProcessEnv = process.env): ModelStage {
  const raw = env[STAGE_VAR];
  if (raw === undefined) return "production";
  const v = raw.trim().toLowerCase();
  if (v === "production" || v === "prod") return "production";
  if (v === "staging") return "staging";
  return "unknown";
}

/** The one place that decides which key this process may use. The two keys never cross. */
export function stageKey(env: NodeJS.ProcessEnv = process.env): { apiKey: string; keySource: ModelKeySource; problem: ModelKeyProblem } {
  const stage = modelStage(env);
  if (stage === "unknown") return { apiKey: "", keySource: "none", problem: "UNKNOWN_STAGE" };
  const name = stage === "staging" ? STAGE_KEY_VAR : PRODUCTION_KEY_VAR;
  const key = (env[name] ?? "").trim();
  if (key) return { apiKey: key, keySource: stage === "staging" ? "stage" : "production", problem: null };
  // Production with no key is simply off (it always was). Staging with no stage key is a named problem.
  return { apiKey: "", keySource: "none", problem: stage === "staging" ? "STAGE_KEY_MISSING" : null };
}

export const modelKeyProblem = (cfg: ModelConfig): ModelKeyProblem => cfg.keyProblem;

const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function modelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  // SHO-2927: the key comes from the stage resolver, never straight from a named variable.
  const key = stageKey(env);
  return {
    provider: (env.MODEL_PROVIDER || "anthropic").toLowerCase(),
    model: env.MODEL_NAME || "claude-haiku-5-5",
    apiKey: key.apiKey,
    approved: env.MODEL_DATA_APPROVED === "true",
    retryDelayMs: num(env.MODEL_RETRY_DELAY_MS, 2000),
    timeoutMs: num(env.MODEL_TIMEOUT_MS, 15000),
    stage: modelStage(env),
    keySource: key.keySource,
    keyProblem: key.problem,
    // Anthropic pricing page, read 17 Oct 2026: Haiku 5.5 (prompts up to 100k tokens).
    price: {
      inPerMTok: num(env.MODEL_USD_IN_PER_MTOK, 0.1),
      outPerMTok: num(env.MODEL_USD_OUT_PER_MTOK, 0.5),
      cacheWritePerMTok: num(env.MODEL_USD_CACHE_WRITE_PER_MTOK, 0.125),
      cacheReadPerMTok: num(env.MODEL_USD_CACHE_READ_PER_MTOK, 0.01),
    },
  };
}

/** Dollars for one call. Input tokens here exclude cached tokens (the API reports them separately). */
export function costUsd(u: ModelUsageCounts, p: ModelConfig["price"]) {
  return (u.input * p.inPerMTok + u.output * p.outPerMTok + u.cacheWrite * p.cacheWritePerMTok + u.cacheRead * p.cacheReadPerMTok) / 1_000_000;
}

/** Is the concierge switched on at all? No key or no approval means no request, ever. */
export function modelEnabled(cfg = modelConfig()) {
  if (!cfg.approved) return false;
  if (cfg.provider === "fake") return process.env.NODE_ENV !== "production";
  return cfg.provider === "anthropic" && cfg.apiKey.length > 0;
}

// SHO-2927: a missing or unusable key used to be indistinguishable from "the owner has not switched the
// concierge on". One line, once per process, names the variable and never a value.
let keyProblemWarned = false;
function warnKeyProblem(cfg: ModelConfig) {
  if (keyProblemWarned || !cfg.keyProblem) return;
  keyProblemWarned = true;
  if (cfg.keyProblem === "STAGE_KEY_MISSING") {
    console.warn(`[model] ${STAGE_VAR}=staging but ${STAGE_KEY_VAR} is not set; the concierge is off here.`);
  } else {
    console.warn(`[model] ${STAGE_VAR} is not "production" or "staging"; the concierge is off rather than guessing a key.`);
  }
}
/** Test seam for the once-per-process warning. */
export const resetKeyProblemWarning = () => { keyProblemWarned = false; };

// ------------------------------------------------------------------ Anthropic Messages API (plain fetch)
const anthropic: ModelProvider = {
  name: "anthropic",
  async complete(req, cfg) {
    const tools = req.tools.map((t, i) => (i === req.tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(cfg.timeoutMs),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: req.maxTokens,
        // An empty text block is rejected outright. Improve my prompt has no per-day line, and that
        // rejection was reported as the language service being down (APL-2694). A real per-day line is still sent.
        system: [
          { type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } },
          ...(req.system.dynamic.trim() ? [{ type: "text", text: req.system.dynamic }] : []),
        ],
        ...(tools.length ? { tools } : {}),
        messages: req.messages,
      }),
    });
    // Never read the error body into a message: it can echo the request.
    if (!res.ok) throw new Error(`provider status ${res.status}`);
    const j = (await res.json()) as {
      content?: ContentBlock[]; stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };
    if (!Array.isArray(j.content)) throw new Error("provider returned no content");
    return {
      content: j.content,
      stopReason: j.stop_reason ?? "end_turn",
      usage: {
        input: j.usage?.input_tokens ?? 0,
        output: j.usage?.output_tokens ?? 0,
        cacheWrite: j.usage?.cache_creation_input_tokens ?? 0,
        cacheRead: j.usage?.cache_read_input_tokens ?? 0,
      },
    };
  },
};

// ------------------------------------------------------------------ fake provider (tests)
export type FakeHandler = (req: ModelRequest, call: number) => ModelResponse | Promise<ModelResponse>;
let fakeHandler: FakeHandler | null = null;
let fakeCalls = 0;
/** Tests install a script; `null` removes it. The counter is how tests prove "no provider call". */
export function setFakeModel(h: FakeHandler | null) {
  fakeHandler = h;
  fakeCalls = 0;
}
export const fakeCallCount = () => fakeCalls;
const fake: ModelProvider = {
  name: "fake",
  async complete(req) {
    fakeCalls++;
    if (!fakeHandler) throw new Error("no fake model installed");
    return fakeHandler(req, fakeCalls);
  },
};

const PROVIDERS: Record<string, ModelProvider> = { anthropic, fake };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One model call. Approval gate first (AC3): when it is off, no provider is even looked up.
 * An error or timeout is retried once after the configured delay (AC4); a second failure is PROVIDER_DOWN.
 */
export async function generate(req: ModelRequest, cfg = modelConfig()): Promise<ModelResponse & { model: string; costUsd: number }> {
  warnKeyProblem(cfg);
  if (!modelEnabled(cfg)) throw new ModelError("NOT_ENABLED", "The assistant is not switched on yet.");
  const provider = PROVIDERS[cfg.provider];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await provider.complete(req, cfg);
      return { ...r, model: cfg.model, costUsd: costUsd(r.usage, cfg.price) };
    } catch {
      // Deliberately nothing is logged or kept from the error: it may carry chat or task text.
      if (attempt === 0) await sleep(cfg.retryDelayMs);
    }
  }
  throw new ModelError("PROVIDER_DOWN", "The assistant could not be reached.");
}
