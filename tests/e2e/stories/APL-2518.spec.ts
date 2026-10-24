// SHO-US-9.1 Provider-agnostic model wrapper (APL-2518).
// AC1, AC2 and AC4 run the real wrapper/engine against a controlled provider and local database.
// The named-suite guard refuses remote targets; these are component evidence, never a live-provider/staging claim. AC5 sends one short prompt
// and checks the endpoints a session can read, other than the person's own chat.
import { test, expect, zz } from "../support";
import { cleanChat } from "../helpers/jim-http";
import { conciergeLive, conciergeOff } from "../helpers/jim-gate";
import { ask, requireModel, showConcierge } from "../helpers/jim-concierge";
import { runVitest, type SuiteReport } from "../helpers/named-suite";

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: { width: 1440, height: 900 } });

let wrapperSuite: Promise<SuiteReport> | undefined;
async function wrapperEvidence(title: string) {
  test.info().annotations.push({ type: "evidence-scope", description: "Real wrapper and engine with controlled provider, local database only; not live-provider acceptance." });
  wrapperSuite ??= runVitest(["tests/concierge-limits.test.ts"]);
  const report = await wrapperSuite;
  const matching = report.testResults.flatMap((f) => f.assertionResults).filter((r) => r.fullName.includes(title));
  expect(matching, `named behavioral test exists: ${title}`).toHaveLength(1);
  expect(matching[0].status).toBe("passed");
}

test("AC1: changing the configured model leaves the concierge working with no code change", async () => {
  test.setTimeout(180_000);
  await wrapperEvidence("the usage record shows the configured model, so a swap needs no code");
});

test("AC2: a message uses the default small model and the usage record shows that name", async () => {
  test.setTimeout(180_000);
  await wrapperEvidence("default small model is recorded for a successful message when MODEL_NAME is unset");
});

test("AC3: while MODEL_DATA_APPROVED is off, nothing is sent to a provider and the concierge says it is not enabled yet", async ({ admin }) => {
  const state = await admin.api.get("/api/concierge/state");
  const code = state.json.disabled?.code as string | undefined;
  test.skip(
    state.status !== 200 || code !== "NOT_ENABLED",
    "Staging cannot switch MODEL_DATA_APPROVED off. This build does not report NOT_ENABLED, so the switched-off state is not on screen.",
  );
  const before = JSON.stringify(state.json.messages ?? []);
  const p = admin.page;
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto("/");
  await expect(p.locator("aside.cc-slot .cc-disabled")).toContainText(/not switched on yet|not enabled/i);
  await expect(p.locator("aside.cc-slot textarea")).toHaveCount(0);
  const sent = await admin.api.post("/api/concierge/messages", { text: "What is due this week?" });
  expect(sent.status).toBe(200);
  expect(sent.json.disabled?.code).toBe("NOT_ENABLED");
  expect(sent.json.messages ?? []).toHaveLength(0);
  const after = await admin.api.get("/api/concierge/state");
  expect(JSON.stringify(after.json.messages ?? [])).toBe(before);
  expect((await admin.api.get("/api/projects")).status, "the rest of the app still answers").toBe(200);
});

test("AC4: a provider error is retried once after 2 seconds, then the concierge shows a disabled reason", async () => {
  test.setTimeout(180_000);
  await wrapperEvidence("default two-second retry waits before its only second attempt");
  await wrapperEvidence("retries once after the delay, then PROVIDER_DOWN; the retry is not counted");
});

test("AC5: an API key, chat text and task text are not written to the usage, audit or activity the session can read", async ({ admin, later }) => {
  const c = await conciergeLive(admin);
  test.skip(!c.live, conciergeOff(c));
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const token = zz("chat-secret");
  const asked = await ask(admin, token);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(JSON.stringify((await admin.api.get("/api/concierge/state")).json.messages ?? [])).toContain(token);
  for (const path of ["/api/usage", "/api/audit", "/api/team", "/api/projects"]) {
    const r = await admin.api.get(path);
    expect(r.status, path).toBe(200);
    const body = JSON.stringify(r.json);
    expect(body, path).not.toContain(token);
    expect(body.toLowerCase(), path).not.toMatch(/sk-ant-|anthropic_api_key|api[_-]?key/);
  }
  test.info().annotations.push({
    type: "logs",
    description: "Server log files are not readable from a browser session. This check is the JSON the session can read apart from the person's own chat.",
  });
});
