import { describe, expect, it } from "vitest";
import { modelConfig } from "../../src/lib/model";
import { estimateRunUsd, overBudget } from "./budget";
import { PROMPTS } from "./prompts";

describe("concierge eval budget", () => {
  it("estimates the default Haiku run under 1 USD", () => {
    const price = modelConfig({ MODEL_NAME: "claude-haiku-5-5" } as unknown as NodeJS.ProcessEnv).price;
    const estimate = estimateRunUsd(PROMPTS.length, price);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(1);
    expect(overBudget(estimate)).toBe(false);
  });

  it("stops when the estimate passes 1 USD", () => {
    const price = { inPerMTok: 30, outPerMTok: 150, cacheWritePerMTok: 37.5, cacheReadPerMTok: 3 };
    expect(overBudget(estimateRunUsd(PROMPTS.length, price))).toBe(true);
    expect(overBudget(1)).toBe(false);
    expect(overBudget(1.0001)).toBe(true);
  });
});
