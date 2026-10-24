// APL-2694 (Michael v1): Improve my prompt must get a rewrite back from the standard model.
// The provider call is mocked; nothing here talks to a real model or a database.
import { afterEach, describe, expect, it, vi } from "vitest";

type UsageWrite = { data: { counted: boolean; model: string; userId: string } };

const usageCreate = vi.fn<(row: UsageWrite) => Promise<{ id: string }>>(async () => ({ id: "usage-1" }));
const chatCreate = vi.fn<(row: unknown) => Promise<{ id: string }>>(async () => ({ id: "should-not-be-written" }));

vi.mock("@/lib/db", () => ({
  db: {
    modelUsage: {
      aggregate: vi.fn(async () => ({ _sum: { costUsd: 0 } })),
      count: vi.fn(async () => 0),
      create: (row: UsageWrite) => usageCreate(row),
    },
    chatMessage: {
      create: (row: unknown) => chatCreate(row),
    },
  },
}));

// SHO-3010 AC3 below calls POST /api/concierge/improve itself, so handle() runs and the thrown ApiError has to become
// an HTTP answer. `connection()` needs a request scope the test does not have, and the session is the caller's, not
// this clause's: both are stubbed the way tests/apl-2742.test.ts and tests/crm-visible-quick.test.ts stub them.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("@/lib/auth", () => ({ currentUser: async () => ({ id: "user-1", orgRole: "MEMBER" }) }));

import { improvePrompt } from "../src/lib/concierge/engine";
import { clearProviderDown } from "../src/lib/concierge/limits";
import { generate, type ModelRequest } from "../src/lib/model";

const { POST: improveRoute } = await import("../src/app/api/concierge/improve/route");

const ORIGINAL = "Move the budget task to Monday";
const REWRITE = "Please move the budget task to Monday.";

type Sent = {
  model: string;
  system: { type: string; text: string; cache_control?: { type: string } }[];
  tools?: { name: string; cache_control?: { type: string } }[];
  messages: { role: string; content: string }[];
};

function providerReply(text: string) {
  return new Response(JSON.stringify({
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 40, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/** Point the real provider wrapper at a fake fetch and record each request body. */
function mockModel(text: string) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return providerReply(text);
  }));
  return sent;
}

function enableModel() {
  process.env.MODEL_PROVIDER = "anthropic";
  process.env.MODEL_DATA_APPROVED = "true";
  process.env.ANTHROPIC_API_KEY = "test-not-a-secret";
  process.env.MODEL_RETRY_DELAY_MS = "0";
  delete process.env.MODEL_NAME;
  clearProviderDown();
}

afterEach(() => {
  vi.unstubAllGlobals();
  usageCreate.mockClear();
  chatCreate.mockClear();
  clearProviderDown();
  delete process.env.MODEL_PROVIDER;
  delete process.env.MODEL_DATA_APPROVED;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MODEL_RETRY_DELAY_MS;
  delete process.env.MODEL_NAME;
});

describe("qa:TC missing improve my prompt (APL-2694)", () => {
  it("qa:TC missing AC1, AC2, AC3: a mocked reply is the rewrite, counted once on the standard model, and not posted", async () => {
    enableModel();
    const sent = mockModel(REWRITE);
    const out = await improvePrompt({ id: "user-1", orgRole: "MEMBER" }, ORIGINAL);

    // AC1: the endpoint returns the model's text. The composer shows that string in Suggested rewrite.
    expect(out.improved).toBe(REWRITE);
    expect(sent).toHaveLength(1);
    const body = sent[0];
    expect(body.messages).toEqual([{ role: "user", content: ORIGINAL }]);
    expect(body.system.length).toBeGreaterThan(0);
    for (const block of body.system) {
      expect(block.type).toBe("text");
      expect(block.text.trim().length).toBeGreaterThan(0);
    }
    expect(body.system.map((b) => b.text).join("\n")).toMatch(/Rewrite the person's request/);

    // AC2: one counted call, on the configured standard model, never a larger one.
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.model).not.toMatch(/opus|sonnet/i);
    expect(body.tools).toBeUndefined();
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({ counted: true, model: "claude-haiku-5-5", userId: "user-1" });

    // AC3: the rewrite is not a chat message. Nothing is posted until Send.
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("qa:TC missing AC4: a failed model call does not return a rewrite and writes nothing", async () => {
    enableModel();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(improvePrompt({ id: "user-1", orgRole: "MEMBER" }, ORIGINAL)).rejects.toMatchObject({ status: 503 });
    expect(usageCreate).not.toHaveBeenCalled();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("qa:TC missing AC4: an empty model reply is a visible error, not counted against the week, and writes no chat row", async () => {
    enableModel();
    mockModel("   ");
    await expect(improvePrompt({ id: "user-1", orgRole: "MEMBER" }, ORIGINAL)).rejects.toMatchObject({
      status: 502,
      message: "No clearer version came back. Your text is unchanged; try again.",
    });
    // The spend is still on the ledger for cost tracking, but not counted toward the person's weekly cap.
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({ counted: false, model: "claude-haiku-5-5", userId: "user-1" });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("qa:TC missing AC4: a reply that only repeats the typed text is a visible error and counts once toward the week (APL-2871 AC1 v1.1)", async () => {
    enableModel();
    mockModel(`  ${ORIGINAL}\n`);
    await expect(improvePrompt({ id: "user-1", orgRole: "MEMBER" }, ORIGINAL)).rejects.toMatchObject({
      status: 502,
      message: "No clearer version came back. Your text is unchanged; try again.",
    });
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({ counted: true, model: "claude-haiku-5-5", userId: "user-1" });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("qa:TC missing a chat-shaped call still sends the per-day system line and its tools", async () => {
    enableModel();
    const sent = mockModel("ok");
    const req: ModelRequest = {
      system: { stable: "Rules you never break.", dynamic: "Today is Monday 17 March 2031 (India time)." },
      tools: [{ name: "my_tasks", description: "List tasks", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "What is due?" }],
      maxTokens: 1024,
    };
    const r = await generate(req);
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
    expect(sent[0].system.map((b) => b.text)).toEqual([
      "Rules you never break.",
      "Today is Monday 17 March 2031 (India time).",
    ]);
    expect(sent[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent[0].tools?.[0]).toMatchObject({ name: "my_tasks", cache_control: { type: "ephemeral" } });
  });
});

describe("qa:TC missing improve my prompt ignores near-copies (APL-2871)", () => {
  it.each([
    "move the budget task to monday",
    "Move the budget task to Monday.",
    "\u201cMove the budget task to Monday\u201d",
    // SHO-3010 AC1/AC3: the typed text in wrapping quotes with one full stop after the closing quote, straight and curly.
    "\"Move the budget task to Monday\".",
    "\u2018Move the budget task to Monday\u2019.",
  ])("qa:TC missing AC1 v1.1: the reply %j is no rewrite: 502, counted once toward the week, nothing posted", async (reply) => {
    enableModel();
    mockModel(reply);
    await expect(improvePrompt({ id: "user-1", orgRole: "MEMBER" }, ORIGINAL)).rejects.toMatchObject({
      status: 502,
      message: "No clearer version came back. Your text is unchanged; try again.",
    });
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({ counted: true, userId: "user-1" });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("qa:TC missing AC2: a real rewrite is returned and counts once toward the week", async () => {
    enableModel();
    mockModel("Move the budget review task to Monday 9:00");
    const out = await improvePrompt({ id: "user-1", orgRole: "MEMBER" }, ORIGINAL);
    expect(out.improved).toBe("Move the budget review task to Monday 9:00");
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({ counted: true, userId: "user-1" });
    expect(chatCreate).not.toHaveBeenCalled();
  });
});

// SHO-3010 AC3, verbatim: "improvePrompt (server) and offeredRewrite (client) both treat such a reply as an echo:
// 502 \"No clearer version came back…\" with one `counted: true` row, and no rewrite offered."
//
// The two describe blocks above pin the engine half (the reply throws ApiError(502)) and the client half
// (offeredRewrite is null, tests/concierge-echo.test.ts). Neither says the *request* is answered with 502: an ApiError
// is a thrown object, and only handle() turns it into an HTTP status. A route that caught it, or a handle() that
// mapped 502 to 200, would leave both existing blocks green and AC3 false. These cases call the route's POST.
const IMPROVE_URL = "http://localhost/api/concierge/improve";
const postImprove = (text: string) =>
  improveRoute(new Request(IMPROVE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }));

describe("qa:TC missing SHO-3010 AC3 at the HTTP boundary", () => {
  // AC3's own wording is the ellipsis; AC4 of the same ticket and tests/concierge-improve.test.ts:121 carry the full
  // sentence. Pinned literally so a reworded message has to be a deliberate change.
  const ECHO_TEXT = "No clearer version came back. Your text is unchanged; try again.";

  it.each([
    ["straight quotes, one full stop after them (the ticket's failing case)", `"${ORIGINAL}".`],
    ["curly quotes, one full stop after them", `\u201c${ORIGINAL}\u201d.`],
    ["no quotes, one full stop", `${ORIGINAL}.`],
  ])("qa:TC missing AC3: %s is answered 502 with AC3's sentence and exactly one counted:true row, no rewrite", async (_label, reply) => {
    enableModel();
    mockModel(reply);
    const res = await postImprove(ORIGINAL);

    // The answer, not a thrown error: this is the half that no engine-level test can assert.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; improved?: unknown };
    expect(body.error).toBe(ECHO_TEXT);
    // AC3 quotes the sentence with an ellipsis; the answer has to start with the words it does quote.
    expect(body.error?.startsWith("No clearer version came back")).toBe(true);
    // "no rewrite offered": the body carries the error and nothing the composer could show as a rewrite.
    expect(body.improved).toBeUndefined();

    // "...with one `counted: true` row": exactly one, counted, on the standard model, and it is not a chat message.
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({ counted: true, model: "claude-haiku-5-5", userId: "user-1" });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("qa:TC missing AC3 (control): a real rewrite is answered 200 with the rewrite, so the 502 above is the echo path", async () => {
    enableModel();
    mockModel("Move the budget review task to Monday 9:00");
    const res = await postImprove(ORIGINAL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ improved: "Move the budget review task to Monday 9:00" });
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("qa:TC missing AC3: an empty body is a 400, not the echo 502, so the two refusals are told apart", async () => {
    enableModel();
    mockModel(`"${ORIGINAL}".`);
    const res = await improveRoute(new Request(IMPROVE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("Write something first.");
    expect(usageCreate).not.toHaveBeenCalled();
  });
});
