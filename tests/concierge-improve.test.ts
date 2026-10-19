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

import { improvePrompt } from "../src/lib/concierge/engine";
import { clearProviderDown } from "../src/lib/concierge/limits";
import { generate, type ModelRequest } from "../src/lib/model";

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

  it("qa:TC missing AC4: a reply that only repeats the typed text is a visible error and not counted against the week", async () => {
    enableModel();
    mockModel(`  ${ORIGINAL}\n`);
    await expect(improvePrompt({ id: "user-1", orgRole: "MEMBER" }, ORIGINAL)).rejects.toMatchObject({
      status: 502,
      message: "No clearer version came back. Your text is unchanged; try again.",
    });
    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(usageCreate.mock.calls[0][0].data).toMatchObject({ counted: false, model: "claude-haiku-5-5", userId: "user-1" });
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
