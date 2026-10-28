// SHO-US-9.1 Provider-agnostic model wrapper (APL-2518).
// One test per acceptance criterion. AC1, AC2 and AC4 need a server setting or a forced provider failure, which a browser
// session cannot raise, so they skip with the reason. AC3 runs only when MODEL_DATA_APPROVED is off. AC5 sends one short prompt
// and checks the endpoints a session can read, other than the person's own chat.
import { test, expect, zz } from "../support";
import { cleanChat } from "../helpers/jim-http";
import { conciergeLive, conciergeOff } from "../helpers/jim-gate";
import { ask, requireModel, showConcierge } from "../helpers/jim-concierge";

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: { width: 1440, height: 900 } });

test("AC1: changing the configured model leaves the concierge working with no code change", async () => {
  test.skip(true, "The model name is the server setting MODEL_NAME. A browser session cannot change it, and these tests do not restart staging.");
});

test("AC2: a message uses the default small model and the usage record shows that name", async () => {
  test.skip(true, "The usage screen and /api/usage show counts and cost only. They do not include the model name on each record, and a browser session cannot read the usage table. tests/concierge-limits.test.ts covers the recorded model name.");
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
  test.skip(true, "A browser session cannot make the model provider return an error or time out, so the one retry after 2 seconds cannot be raised here. tests/concierge-limits.test.ts covers that path.");
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
