// SHO-2927. Staging must spend its own model key; it must never use the production one.
//
// The defect this file pins: src/lib/model.ts read exactly one provider-key variable, ANTHROPIC_API_KEY,
// with no notion of which environment is running. A staged environment that switches the concierge on
// therefore had only one way to do it - with the production key - and nothing in the code could stop it.
// The stage-only path is: SHO_DEPLOY_STAGE=staging makes the wrapper read ANTHROPIC_API_KEY_STAGE and
// nothing else; an unset or production stage reads ANTHROPIC_API_KEY and ignores the stage key entirely;
// an unrecognised stage value fails closed rather than guessing.
//
// The key strings below are obvious fakes. No real key is read, printed or written anywhere in this file.
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { modelConfig, modelEnabled, modelKeyProblem, generate } from "../src/lib/model";

const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;

const PROD = "fake-production-key-not-real-2927";
const STAGE = "fake-stage-key-not-real-2927";

const OK_RESPONSE = {
  content: [{ type: "text" as const, text: "fine" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

afterEach(() => vi.restoreAllMocks());

describe("SHO-2927 stage-only model key", () => {
  it("AC1: with SHO_DEPLOY_STAGE=staging the production key is never used, so staging is off without a stage key", () => {
    // Today this returns the production key and the concierge answers on staging spend: the defect.
    const c = modelConfig(env({ SHO_DEPLOY_STAGE: "staging", MODEL_DATA_APPROVED: "true", ANTHROPIC_API_KEY: PROD }));
    expect(c.apiKey).toBe("");
    expect(c.keySource).toBe("none");
    expect(modelEnabled(c)).toBe(false);
  });

  it("AC1: with both keys present, staging uses the stage key and the production key never reaches the config", () => {
    const c = modelConfig(env({
      SHO_DEPLOY_STAGE: "staging", MODEL_DATA_APPROVED: "true",
      ANTHROPIC_API_KEY: PROD, ANTHROPIC_API_KEY_STAGE: STAGE,
    }));
    expect(c.apiKey).toBe(STAGE);
    expect(c.apiKey).not.toBe(PROD);
    expect(c.keySource).toBe("stage");
    expect(modelEnabled(c)).toBe(true);
  });

  it("AC1: the request that leaves staging carries the stage key and no trace of the production key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(OK_RESPONSE), { status: 200 }));
    const c = modelConfig(env({
      SHO_DEPLOY_STAGE: "staging", MODEL_DATA_APPROVED: "true",
      ANTHROPIC_API_KEY: PROD, ANTHROPIC_API_KEY_STAGE: STAGE,
    }));
    await generate({ system: { stable: "s", dynamic: "" }, tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 5 }, c);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(STAGE);
    const wire = `${JSON.stringify(headers)}${String(init.body)}`;
    expect(wire).not.toContain(PROD);
  });

  it("AC2: production (stage unset or named) reads ANTHROPIC_API_KEY and ignores the stage key entirely", () => {
    for (const stage of [undefined, "production", "prod", "Production"]) {
      const c = modelConfig(env({
        SHO_DEPLOY_STAGE: stage, MODEL_DATA_APPROVED: "true",
        ANTHROPIC_API_KEY: PROD, ANTHROPIC_API_KEY_STAGE: STAGE,
      }));
      expect(c.apiKey, String(stage)).toBe(PROD);
      expect(c.keySource, String(stage)).toBe("production");
      expect(modelEnabled(c), String(stage)).toBe(true);
    }
    // A stage key alone never brings production up: it is not a fallback in that direction either.
    const only = modelConfig(env({ MODEL_DATA_APPROVED: "true", ANTHROPIC_API_KEY_STAGE: STAGE }));
    expect(only.apiKey).toBe("");
    expect(modelEnabled(only)).toBe(false);
  });

  it("AC3: a mistyped stage fails closed instead of falling back to the production key", () => {
    for (const stage of ["stage", "stg", "", "PRODUCTION-ISH"]) {
      const c = modelConfig(env({
        SHO_DEPLOY_STAGE: stage, MODEL_DATA_APPROVED: "true",
        ANTHROPIC_API_KEY: PROD, ANTHROPIC_API_KEY_STAGE: STAGE,
      }));
      expect(c.stage, stage).toBe("unknown");
      expect(c.apiKey, stage).toBe("");
      expect(modelEnabled(c), stage).toBe(false);
      expect(modelKeyProblem(c), stage).toBe("UNKNOWN_STAGE");
    }
  });

  it("AC3: a missing stage key is reported by name, not swallowed as a blank key", () => {
    const c = modelConfig(env({ SHO_DEPLOY_STAGE: "staging", MODEL_DATA_APPROVED: "true", ANTHROPIC_API_KEY: PROD }));
    expect(modelKeyProblem(c)).toBe("STAGE_KEY_MISSING");
    expect(c.keySource).toBe("none");
    // Production has nothing to report when its own key is present.
    expect(modelKeyProblem(modelConfig(env({ MODEL_DATA_APPROVED: "true", ANTHROPIC_API_KEY: PROD })))).toBe(null);
  });

  it("AC4: the stage switch changes the key and nothing else (provider, model, prices, approval)", () => {
    const shared = { MODEL_DATA_APPROVED: "true", MODEL_NAME: "claude-haiku-5-5", ANTHROPIC_API_KEY: PROD, ANTHROPIC_API_KEY_STAGE: STAGE };
    const prod = modelConfig(env({ ...shared, SHO_DEPLOY_STAGE: "production" }));
    const stage = modelConfig(env({ ...shared, SHO_DEPLOY_STAGE: "staging" }));
    for (const k of ["provider", "model", "approved", "retryDelayMs", "timeoutMs", "price"] as const) {
      expect(stage[k], k).toEqual(prod[k]);
    }
    // The approval gate still outranks a perfectly good stage key.
    expect(modelEnabled(modelConfig(env({
      SHO_DEPLOY_STAGE: "staging", MODEL_DATA_APPROVED: "false", ANTHROPIC_API_KEY_STAGE: STAGE,
    })))).toBe(false);
  });

  it("AC3: the failure is announced once by variable name, and no key value is ever logged", async () => {
    const { resetKeyProblemWarning } = await import("../src/lib/model");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetKeyProblemWarning();
    const missing = modelConfig(env({ SHO_DEPLOY_STAGE: "staging", MODEL_DATA_APPROVED: "true", ANTHROPIC_API_KEY: PROD }));
    await expect(generate({ system: { stable: "s", dynamic: "" }, tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 5 }, missing))
      .rejects.toMatchObject({ code: "NOT_ENABLED" });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("ANTHROPIC_API_KEY_STAGE");
    expect(line).not.toContain(PROD);
    // Once per process: a second call does not repeat it.
    await expect(generate({ system: { stable: "s", dynamic: "" }, tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 5 }, missing)).rejects.toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    resetKeyProblemWarning();
  });

  it("AC5: .env.example documents both names with no value, so nobody copies a production key into staging", () => {
    const doc = readFileSync(".env.example", "utf8");
    expect(doc).toContain("SHO_DEPLOY_STAGE");
    expect(doc).toContain("ANTHROPIC_API_KEY_STAGE");
    for (const line of doc.split("\n")) {
      if (/\b(SHO_DEPLOY_STAGE|ANTHROPIC_API_KEY_STAGE)\s*=/.test(line) && !line.trimStart().startsWith("#")) {
        throw new Error(`.env.example sets a stage key on an active line: ${line}`);
      }
    }
  });
});
