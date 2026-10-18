// Cost gate for one eval run. The estimate uses the same dollar formula as the model wrapper.
import { costUsd, type ModelConfig } from "../../src/lib/model";

export const BUDGET_USD = 1;
export const RUNS_PER_PROMPT = 2;
/** Matches MAX_MODEL_CALLS in the concierge engine. */
export const MAX_CALLS_PER_RUN = 4;

// A turn is the cached system prompt and tools, the fixture, and at most one tool result.
const ASSUMED_INPUT_TOKENS = 6_000;
const ASSUMED_OUTPUT_TOKENS = 1_024;
const ASSUMED_CACHE_WRITE_TOKENS = 3_000;

type Price = ModelConfig["price"];

/** Upper bound for the whole set: every allowed call, plus one cache write of the stable prefix. */
export function estimateRunUsd(promptCount: number, price: Price): number {
  const calls = promptCount * RUNS_PER_PROMPT * MAX_CALLS_PER_RUN;
  const perCall = costUsd({ input: ASSUMED_INPUT_TOKENS, output: ASSUMED_OUTPUT_TOKENS, cacheWrite: 0, cacheRead: 0 }, price);
  const cache = costUsd({ input: 0, output: 0, cacheWrite: ASSUMED_CACHE_WRITE_TOKENS, cacheRead: 0 }, price);
  return calls * perCall + cache;
}

/** Upper bound for the request about to be sent, from its size and max_tokens. */
export function estimateCallUsd(bodyChars: number, maxTokens: number | undefined, price: Price): number {
  const input = Math.max(1, Math.ceil(bodyChars / 4));
  const output = maxTokens && maxTokens > 0 ? maxTokens : ASSUMED_OUTPUT_TOKENS;
  return costUsd({ input, output, cacheWrite: 0, cacheRead: 0 }, price);
}

/** True when the figure has passed 1 USD. */
export const overBudget = (usd: number) => usd > BUDGET_USD;
