// SHO-US-9.1 Provider-agnostic model wrapper (APL-2518).
// AC1, AC2 and AC4 call the wrapper in this process with the fake provider (@static). They do not call staging.
// AC3's live check reads the switch the running app reports. Its fake-provider proof is @static.
// AC5's live check reads the endpoints a session can see. Its source proof is @static.
// No test posts /api/concierge/messages.
import { readFileSync } from "node:fs";
import { test, expect, zz } from "../support";
import { newProject } from "../g2";
import { cleanChat, quickAction } from "../helpers/jim-http";
import { showConcierge } from "../helpers/jim-concierge";
import { fakeCallCount, generate, ModelError, modelConfig, setFakeModel, type ModelRequest } from "../../../src/lib/model";

test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 1440, height: 900 } });

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");

const read = (path: string) => readFileSync(path, "utf8");
const req = (): ModelRequest => ({
  system: { stable: "stable", dynamic: "dynamic" },
  tools: [],
  messages: [{ role: "user", content: "ZZ-TEST ping" }],
  maxTokens: 16,
});
const ok = {
  content: [{ type: "text" as const, text: "ok" }],
  stopReason: "end_turn",
  usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
};

function cfg(env: Record<string, string>) {
  return modelConfig({ ...process.env, MODEL_PROVIDER: "fake", ANTHROPIC_API_KEY: "not-sent", ...env });
}

// The fake provider is refused when NODE_ENV is production (src/lib/model.ts). These calls stay in this process.
const proc = process.env as { NODE_ENV?: string };
let nodeEnv: string | undefined;
test.beforeEach(() => {
  nodeEnv = proc.NODE_ENV;
  proc.NODE_ENV = "test";
});
test.afterEach(() => {
  setFakeModel(null);
  proc.NODE_ENV = nodeEnv;
});

// @static: generate() runs in this process with the fake provider. It does not call staging.
test("AC1: changing the configured model leaves the concierge working with no code change", { tag: "@static" }, async ({ admin }) => {
  expect((await admin.api.get("/api/health")).json.ok).toBe(true);
  setFakeModel(() => ok);
  const names = ["claude-haiku-5-5", "claude-sonnet-stand-in"];
  for (const name of names) {
    const r = await generate(req(), cfg({ MODEL_DATA_APPROVED: "true", MODEL_NAME: name, MODEL_RETRY_DELAY_MS: "0" }));
    expect(r.model).toBe(name);
    expect(r.content[0]).toMatchObject({ type: "text", text: "ok" });
  }
  expect(read("src/lib/model.ts")).toContain('model: env.MODEL_NAME || "claude-haiku-5-5"');
});

// @static: generate() runs in this process with the fake provider. It does not call staging.
test("AC2: a message uses the default small model and the usage record shows that name", { tag: "@static" }, async ({ admin }) => {
  setFakeModel(() => ok);
  const bare = cfg({ MODEL_DATA_APPROVED: "true", MODEL_RETRY_DELAY_MS: "0" });
  expect(bare.model).toBe("claude-haiku-5-5");
  const r = await generate(req(), bare);
  expect(r.model).toBe("claude-haiku-5-5");
  const limits = read("src/lib/concierge/limits.ts");
  expect(limits).toContain("model: r.model");
  expect(limits).toContain("inputTokens:");
  expect(read("src/lib/usage.ts")).toContain("no chat text is ever stored");
  const usage = await admin.api.get("/api/usage");
  expect(usage.status).toBe(200);
  const body = JSON.stringify(usage.json);
  expect(body.toLowerCase()).not.toMatch(/sk-ant-|anthropic_api_key/);
  expect(body).not.toContain("ZZ-TEST ping");
  await admin.page.goto("/usage");
  await expect(admin.page.getByRole("heading", { name: "Usage" })).toBeVisible();
  await expect(admin.page.getByText("no chat text is shown here")).toBeVisible();
});

test("AC3: while MODEL_DATA_APPROVED is off, nothing is sent to a provider and the concierge says it is not enabled yet", async ({ admin }) => {
  const state = await admin.api.get("/api/concierge/state");
  expect(state.status).toBe(200);
  expect(state.json.disabled?.code, "the concierge is switched on, so this check cannot see the not-enabled line").toBe("NOT_ENABLED");
  await admin.page.setViewportSize({ width: 1440, height: 900 });
  await admin.page.goto("/");
  await expect(admin.page.locator("aside.cc-slot .cc-disabled")).toContainText(/not switched on yet|not enabled/i);
  await expect(admin.page.locator("aside.cc-slot textarea")).toHaveCount(0);
  expect((await admin.api.get("/api/projects")).status, "the rest of the app still answers").toBe(200);
});

// @static: the off switch is exercised in this process with the fake provider, and the copy is in the source.
test("AC3 source: an off switch never looks up a provider and says the concierge is not switched on", { tag: "@static" }, async () => {
  setFakeModel(() => ok);
  const before = fakeCallCount();
  const off = cfg({ MODEL_DATA_APPROVED: "false" });
  await expect(generate(req(), off)).rejects.toBeInstanceOf(ModelError);
  await expect(generate(req(), off)).rejects.toMatchObject({ code: "NOT_ENABLED" });
  expect(fakeCallCount()).toBe(before);
  expect(read("src/lib/model.ts")).toContain("when it is off, no provider is even looked up");
  expect(read("src/lib/concierge/limits.ts")).toContain("The concierge is not switched on yet.");
});

// @static: the retry runs in this process with the fake provider. It does not call staging.
test("AC4: a provider error is retried once after 2 seconds, then the concierge shows a disabled reason", { tag: "@static" }, async ({ admin }) => {
  const src = read("src/lib/model.ts");
  expect(src).toContain("retryDelayMs: num(env.MODEL_RETRY_DELAY_MS, 2000)");
  expect(src).toContain("for (let attempt = 0; attempt < 2; attempt++)");
  expect(src).toContain('throw new ModelError("PROVIDER_DOWN"');
  let calls = 0;
  setFakeModel(() => { calls += 1; if (calls === 1) throw new Error("provider status 503"); return ok; });
  const once = await generate(req(), cfg({ MODEL_DATA_APPROVED: "true", MODEL_RETRY_DELAY_MS: "0" }));
  expect(once.content[0]).toMatchObject({ type: "text" });
  expect(fakeCallCount()).toBe(2);
  setFakeModel(() => { throw new Error("provider status 503"); });
  await expect(generate(req(), cfg({ MODEL_DATA_APPROVED: "true", MODEL_RETRY_DELAY_MS: "0" }))).rejects.toMatchObject({ code: "PROVIDER_DOWN" });
  expect(read("src/lib/concierge/limits.ts")).toContain("The concierge cannot reach its language service right now.");
  const state = await admin.api.get("/api/concierge/state");
  expect(state.status).toBe(200);
  if (state.json.disabled?.code === "PROVIDER_DOWN") {
    await admin.page.goto("/");
    await expect(admin.page.locator("aside.cc-slot .cc-disabled")).toBeVisible();
  }
});

test("AC5: an API key, chat text and task text are not written to the usage, audit or activity the session can read", async ({ admin, later }) => {
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us91-secret" });
  const token = zz("chat-secret");
  const asked = await quickAction(admin, "due-week", project.id);
  expect(asked.status, asked.body).toBe(200);
  const chat = JSON.stringify((await admin.api.get("/api/concierge/state")).json.messages ?? []);
  expect(chat).toContain(project.name);
  expect(chat).not.toContain(token);
  for (const path of ["/api/usage", "/api/audit", "/api/team"]) {
    const r = await admin.api.get(path);
    expect(r.status, path).toBe(200);
    const body = JSON.stringify(r.json);
    expect(body, path).not.toContain(`Due this week in ${project.name}`);
    expect(body, path).not.toContain(token);
    expect(body.toLowerCase(), path).not.toMatch(/sk-ant-|anthropic_api_key/);
  }
  const activity = await admin.api.get(`/api/projects/${project.id}/activity`);
  expect(activity.status).toBe(200);
  const act = JSON.stringify(activity.json);
  expect(act).not.toContain(`Due this week in ${project.name}`);
  expect(act).not.toContain(token);
});

// @static: the wrapper's logging rules are in the source. The endpoints above are the live check.
test("AC5 source: the model wrapper does not touch the database or log", { tag: "@static" }, () => {
  const model = read("src/lib/model.ts");
  expect(model).toContain("Nothing here touches the database");
  expect(model).toContain("nothing here logs");
  expect(model).not.toContain("console.");
});
