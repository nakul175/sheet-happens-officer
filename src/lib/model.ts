// SHO-US-9.1: the one place that talks to a model provider. The concierge asks this wrapper for a
// reply and never knows which provider or model answered. Nothing here touches the database, and
// nothing here logs: chat text, task text and the API key never reach a log.
//
// Configuration (server settings only):
//   MODEL_PROVIDER       "anthropic" (default) or "fake" (tests only; refused when NODE_ENV is production)
//   MODEL_NAME           default "claude-haiku-5-5"
//   ANTHROPIC_API_KEY    the provider key
//   MODEL_DATA_APPROVED  must be exactly "true" or no request is ever sent to any provider
//   MODEL_USD_IN_PER_MTOK, MODEL_USD_OUT_PER_MTOK, MODEL_USD_CACHE_WRITE_PER_MTOK, MODEL_USD_CACHE_READ_PER_MTOK
//   MODEL_RETRY_DELAY_MS (default 2000), MODEL_TIMEOUT_MS (default 20000)

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
};

const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function modelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    provider: (env.MODEL_PROVIDER || "anthropic").toLowerCase(),
    model: env.MODEL_NAME || "claude-haiku-5-5",
    apiKey: env.ANTHROPIC_API_KEY ?? "",
    approved: env.MODEL_DATA_APPROVED === "true",
    retryDelayMs: num(env.MODEL_RETRY_DELAY_MS, 2000),
    timeoutMs: num(env.MODEL_TIMEOUT_MS, 20000),
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
        system: [
          { type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } },
          { type: "text", text: req.system.dynamic },
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
