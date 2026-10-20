// SHO-US-9.1 (model wrapper) and 9.2 (caps and ledger). Calls src/lib directly with a fake model;
// the live server (same database) is used to create people and to prove the default is "off".
import { describe, expect, it, vi } from "vitest";
import { account, superAdmin } from "./helpers";
import { MONDAY, actor, db, istInstant, say, script, useFakeModel } from "./concierge-helpers";
import { ModelError, costUsd, fakeCallCount, generate, modelConfig, modelEnabled, setFakeModel } from "../src/lib/model";
import { disabledFor, monthSpendUsd, warnIfNearCeiling, weekMessages } from "../src/lib/concierge/limits";
import { improvePrompt, quickAction, sendMessage } from "../src/lib/concierge/engine";
import { monthStartIST, nextMonthStartIST, weekStartIST } from "../src/lib/concierge/dates";
import { percentUsedNumber } from "../src/lib/usage-percent";
import { state } from "../src/lib/concierge/thread";

const req = { system: { stable: "s", dynamic: "d" }, tools: [], messages: [{ role: "user" as const, content: "hi" }], maxTokens: 10 };

describe("model wrapper (9.1)", () => {
  useFakeModel();

  it("approval gate: while MODEL_DATA_APPROVED is not exactly 'true', nothing reaches any provider (AC3)", async () => {
    const u = await account("gate");
    script(() => [say("should never be called")]);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes"]) {
      if (v === undefined) delete process.env.MODEL_DATA_APPROVED; else process.env.MODEL_DATA_APPROVED = v;
      const r = await sendMessage(actor(u), "What is due this week?");
      expect(r.disabled?.code).toBe("NOT_ENABLED");
      expect(r.messages).toEqual([]);
      await expect(improvePrompt(actor(u), "plan my week")).rejects.toMatchObject({ status: 503 });
    }
    expect(fakeCallCount()).toBe(0);
    expect(await db.modelUsage.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.chatMessage.count({ where: { userId: u.id } })).toBe(0); // the text was not even stored
    // generate() itself refuses, and the real provider's fetch is never reached.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(generate(req, { ...modelConfig({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" } as unknown as NodeJS.ProcessEnv) })).rejects.toBeInstanceOf(ModelError);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is off by default on the live server and says so (AC3)", async () => {
    const u = await account("gate2");
    const s = await u.c.get("/api/concierge/state");
    expect(s.status).toBe(200);
    expect(s.json.available).toBe(false);
    expect(s.json.disabled.code).toBe("NOT_ENABLED");
    expect(s.json.quickActions.map((q: { id: string }) => q.id)).toEqual(["due-week", "overdue", "waiting-on-me", "blocked", "recently-completed"]);
    const m = await u.c.post("/api/concierge/messages", { text: "hello" });
    expect(m.status).toBe(200);
    expect(m.json.disabled.code).toBe("NOT_ENABLED");
    expect((await u.c.post("/api/concierge/improve", { text: "hello" })).status).toBe(503);
  });

  it("anthropic without a key is not enabled even when approved", () => {
    expect(modelEnabled(modelConfig({ MODEL_DATA_APPROVED: "true", ANTHROPIC_API_KEY: "" } as unknown as NodeJS.ProcessEnv))).toBe(false);
    expect(modelEnabled(modelConfig({ MODEL_DATA_APPROVED: "true", ANTHROPIC_API_KEY: "k" } as unknown as NodeJS.ProcessEnv))).toBe(true);
    expect(modelEnabled(modelConfig({ MODEL_DATA_APPROVED: "false", ANTHROPIC_API_KEY: "k" } as unknown as NodeJS.ProcessEnv))).toBe(false);
  });

  it("defaults: Haiku 5.5, 2 second retry delay, published prices; cost per call follows them", () => {
    const c = modelConfig({} as unknown as NodeJS.ProcessEnv);
    expect(c.model).toBe("claude-haiku-5-5");
    expect(c.provider).toBe("anthropic");
    expect(c.retryDelayMs).toBe(2000);
    expect(c.price).toEqual({ inPerMTok: 0.1, outPerMTok: 0.5, cacheWritePerMTok: 0.125, cacheReadPerMTok: 0.01 });
    expect(costUsd({ input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 }, c.price)).toBeCloseTo(0.735, 6);
    expect(modelConfig({ MODEL_NAME: "other-model", MODEL_USD_IN_PER_MTOK: "2" } as unknown as NodeJS.ProcessEnv)).toMatchObject({ model: "other-model", price: { inPerMTok: 2 } });
  });

  it("the usage record shows the configured model, so a swap needs no code (AC1, AC2)", async () => {
    const u = await account("swap");
    process.env.MODEL_NAME = "some-future-model";
    script(() => [say("Hello there.")]);
    const r = await sendMessage(actor(u), "hi");
    expect(r.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    const rows = await db.modelUsage.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("some-future-model");
    expect(Number(rows[0].costUsd)).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 6);
  });

  it("retries once after the delay, then PROVIDER_DOWN; the retry is not counted (AC4, 9.2 AC5)", async () => {
    const u = await account("retry");
    process.env.MODEL_RETRY_DELAY_MS = "60";
    let calls = 0;
    setFakeModel(() => { calls++; throw new Error("boom with task text: secret title"); });
    const t0 = Date.now();
    await expect(generate(req)).rejects.toMatchObject({ code: "PROVIDER_DOWN" });
    expect(calls).toBe(2); // one try, one retry, no more
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);

    // Through the concierge: two failures show the disabled state and cost the person nothing.
    calls = 0;
    const r = await sendMessage(actor(u), "What is due this week?");
    expect(calls).toBe(2);
    expect(r.disabled?.code).toBe("PROVIDER_DOWN");
    expect(r.messages.at(-1)?.kind).toBe("notice");
    expect(await db.modelUsage.count({ where: { userId: u.id } })).toBe(0);
    expect(await weekMessages(u.id)).toBe(0);
    expect((await state(actor(u))).disabled?.code).toBe("PROVIDER_DOWN");
    // The rest of the app keeps working: quick actions need no model.
    const q = await quickAction(actor(u), "overdue");
    expect(q.messages.at(-1)?.text).toBe("I found nothing.");
  });

  it("a failure followed by a success counts as one message (9.2 AC5)", async () => {
    const u = await account("retry2");
    let calls = 0;
    setFakeModel(() => {
      calls++;
      if (calls === 1) throw new Error("temporary");
      return { content: [say("Back again.")], stopReason: "end_turn", usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } };
    });
    const r = await sendMessage(actor(u), "hello");
    expect(r.disabled).toBeUndefined();
    expect(r.messages.at(-1)?.text).toBe("Back again.");
    expect(calls).toBe(2);
    expect(await weekMessages(u.id)).toBe(1);
    expect(await db.modelUsage.count({ where: { userId: u.id } })).toBe(1);
  });

  it("no chat or task text reaches the database's non-chat tables or the server log (AC5)", async () => {
    const u = await account("secrets");
    const spies = (["log", "error", "warn", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    setFakeModel(() => { throw new Error("provider echoed: PRIVATE-TASK-TEXT sk-ant-SECRETKEY"); });
    process.env.ANTHROPIC_API_KEY = "sk-ant-SECRETKEY";
    await sendMessage(actor(u), "PRIVATE-TASK-TEXT please");
    delete process.env.ANTHROPIC_API_KEY;
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toMatch(/PRIVATE-TASK-TEXT|SECRETKEY/);
    const dump = JSON.stringify([await db.auditLog.findMany(), await db.actionLog.findMany({ where: { actorId: u.id } }), await db.notification.findMany(), await db.modelUsage.findMany({ where: { userId: u.id } })]);
    expect(dump).not.toMatch(/PRIVATE-TASK-TEXT|SECRETKEY/);
  });
});

describe("caps and ledger (9.2)", () => {
  useFakeModel();

  it("India-time periods: Monday 00:00 starts the week, the 1st 00:00 starts the month", () => {
    const sun = istInstant(2031, 3, 16, 23, 59, 59);
    const mon = istInstant(2031, 3, 17, 0, 0, 0);
    expect(weekStartIST(sun).toISOString()).toBe(istInstant(2031, 3, 10).toISOString());
    expect(weekStartIST(mon).toISOString()).toBe(mon.toISOString());
    const last = istInstant(2031, 3, 31, 23, 59, 59);
    const first = istInstant(2031, 4, 1, 0, 0, 0);
    expect(monthStartIST(last).toISOString()).toBe(istInstant(2031, 3, 1).toISOString());
    expect(monthStartIST(first).toISOString()).toBe(first.toISOString());
    expect(nextMonthStartIST(last).toISOString()).toBe(first.toISOString());
  });

  it("weekly cap: 'counted' rows only; quick actions never count; resets Monday 00:00 India time (AC2, AC5) qa:TC missing", async () => {
    const u = await account("weekly");
    process.env.WEEKLY_MESSAGE_CAP = "3";
    script(() => [say("fine")]);
    // Quick actions do not count and are not blocked by anything.
    for (let i = 0; i < 5; i++) await quickAction(actor(u), "blocked", MONDAY);
    // A message with several model calls counts once: only counted=true rows are messages.
    const sun = istInstant(2031, 3, 16, 23, 59, 59);
    await db.modelUsage.createMany({
      data: [
        { userId: u.id, model: "ZZ-TEST", inputTokens: 1, outputTokens: 1, costUsd: "0", counted: true, createdAt: sun },
        { userId: u.id, model: "ZZ-TEST", inputTokens: 1, outputTokens: 1, costUsd: "0", counted: false, createdAt: sun },
        { userId: u.id, model: "ZZ-TEST", inputTokens: 1, outputTokens: 1, costUsd: "0", counted: true, createdAt: sun },
        { userId: u.id, model: "ZZ-TEST", inputTokens: 1, outputTokens: 1, costUsd: "0", counted: true, createdAt: sun },
      ],
    });
    // Sunday 23:59:59 India time: the cap of 3 is reached, and the reset is the coming Monday 00:00.
    const capped = await disabledFor(u.id, sun);
    expect(capped?.code).toBe("WEEK_CAP");
    expect(capped?.resumesAt).toBe(istInstant(2031, 3, 17).toISOString());
    expect(capped?.message).toMatch(/Monday 17 March 2031/);
    const blocked = await sendMessage(actor(u), "one more", sun);
    expect(blocked.disabled?.code).toBe("WEEK_CAP");
    expect(blocked.messages).toEqual([]);
    expect(fakeCallCount()).toBe(0);
    // Quick actions still work while capped.
    const q = await quickAction(actor(u), "due-week", sun);
    expect(q.messages).toHaveLength(2);
    // One second later it is Monday and the count starts again.
    expect(await disabledFor(u.id, istInstant(2031, 3, 17, 0, 0, 0))).toBeNull();
    expect(await weekMessages(u.id, istInstant(2031, 3, 17, 0, 0, 0))).toBe(0);
  });

  it("a person's message counts once however many model calls it makes; improve counts too (AC5, 8.7 AC3)", async () => {
    const u = await account("counting");
    script(
      () => [{ type: "tool_use", id: "a", name: "my_tasks", input: { filter: "all_open" } }],
      () => [say("You have nothing open.")],
    );
    await sendMessage(actor(u), "what do I have?");
    expect(await db.modelUsage.count({ where: { userId: u.id } })).toBe(2);
    expect(await weekMessages(u.id)).toBe(1);
    script(() => [say("Please list my open tasks in each project.")]);
    const imp = await improvePrompt(actor(u), "tasks");
    expect(imp.improved).toBe("Please list my open tasks in each project.");
    expect(await weekMessages(u.id)).toBe(2);
    expect(await db.chatMessage.count({ where: { userId: u.id } })).toBe(2); // improve wrote nothing to the thread
  });

  it("monthly ceiling: calls stop at the ceiling, the message says when it resumes on the 1st, screens and quick actions work (AC1) qa:TC missing", async () => {
    const u = await account("monthly");
    const lastSecond = istInstant(2031, 3, 31, 23, 59, 59);
    const before = await monthSpendUsd(lastSecond);
    process.env.MONTHLY_CEILING_USD = String(before + 10);
    script(() => [say("never")]);
    const spender = await account("ZZ-TEST spender", `nakul17+zz-test-spender-${Date.now()}@aplyd.com`);
    await db.modelUsage.create({ data: { userId: spender.id, model: "ZZ-TEST", inputTokens: 1, outputTokens: 1, costUsd: "10", counted: true, createdAt: istInstant(2031, 3, 5) } });
    expect(await monthSpendUsd(lastSecond)).toBeCloseTo(before + 10, 5);
    const d = await disabledFor(u.id, lastSecond);
    expect(d?.code).toBe("MONTH_CAP");
    expect(d?.message).toMatch(/The concierge is paused for the rest of this month/);
    expect(d?.message).toMatch(/Tuesday 1 April 2031/);
    expect(d?.resumesAt).toBe(istInstant(2031, 4, 1).toISOString());
    const r = await sendMessage(actor(u), "hello", lastSecond);
    expect(r.disabled?.code).toBe("MONTH_CAP");
    expect(fakeCallCount()).toBe(0);
    expect((await quickAction(actor(u), "overdue", lastSecond)).messages).toHaveLength(2);
    // Midnight on the 1st: a fresh budget.
    expect(await disabledFor(u.id, istInstant(2031, 4, 1, 0, 0, 0))).toBeNull();
  });

  it("80 percent: one bell notice to the Super Admin per month with the figures (AC4) qa:TC missing", async () => {
    const sa = await superAdmin();
    const u = await account("ZZ-TEST eighty", `nakul17+zz-test-eighty-${Date.now()}@aplyd.com`);
    await db.notification.deleteMany({ where: { type: "CONCIERGE_BUDGET_80" } });
    const spend0 = await monthSpendUsd();
    // One call must cross 80 percent from whatever this month already holds. On an empty month that cost is $10.
    const price = modelConfig().price;
    const minAdded = Math.max(10, spend0 / 16 + 1);
    const input = Math.ceil((minAdded * 1_000_000) / price.inPerMTok);
    const added = Number(costUsd({ input, output: 0, cacheWrite: 0, cacheRead: 0 }, price).toFixed(6));
    process.env.MODEL_NAME = "ZZ-TEST";
    setFakeModel(() => ({ content: [say("ok")], stopReason: "end_turn", usage: { input, output: 0, cacheWrite: 0, cacheRead: 0 } }));
    const after = spend0 + added;
    process.env.MONTHLY_CEILING_USD = String(after / 0.85);
    expect(await warnIfNearCeiling()).toBe(false); // not yet
    await sendMessage(actor(u), "hi"); // recordUsage notices the threshold right after the call
    const notes = await db.notification.findMany({ where: { type: "CONCIERGE_BUDGET_80", recipientId: sa.id } });
    expect(notes).toHaveLength(1);
    expect((notes[0].data as { ceiling: number }).ceiling).toBeCloseTo(after / 0.85, 6);
    expect((notes[0].data as { percent: number }).percent).toBeGreaterThanOrEqual(80);
    await sendMessage(actor(u), "again");
    expect(await warnIfNearCeiling()).toBe(false);
    expect(await db.notification.count({ where: { type: "CONCIERGE_BUDGET_80", recipientId: sa.id } })).toBe(1);
    const bell = (await sa.c.get("/api/notifications")).json.items as { text: string; href: string }[];
    expect(bell.some((n) => /monthly budget \(\d+ percent\)/.test(n.text) && n.href === "/usage")).toBe(true);
  });

  it("Usage screen: spend against the ceiling and quick-action counts, Super Admin only, no chat text (AC3)", async () => {
    const sa = await superAdmin();
    const u = await account("usage");
    script(() => [say("PRIVATE-USAGE-TEXT in the answer")]);
    await sendMessage(actor(u), "PRIVATE-USAGE-TEXT in the question");
    await quickAction(actor(u), "overdue");
    expect((await u.c.get("/api/usage")).status).toBe(404);
    const r = await sa.c.get("/api/usage");
    expect(r.status).toBe(200);
    expect(r.json.ceiling.usd).toBe(100);
    // The test server leaves MONTHLY_CEILING_USD unset: $100 is the default safety cap, not a set ceiling (APL-2950).
    expect(r.json.ceiling.configured).toBe(false);
    expect(r.json.ceiling.spendUsd).toBeGreaterThan(0);
    expect(typeof r.json.ceiling.percent).toBe("number");
    expect(r.json.ceiling.percent).toBe(percentUsedNumber(r.json.ceiling.spendUsd, r.json.ceiling.usd));
    expect(r.json.quickActions.find((q: { id: string }) => q.id === "overdue").count).toBeGreaterThanOrEqual(1);
    const me = r.json.people.find((p: { id: string }) => p.id === u.id);
    expect(me).toMatchObject({ weekMessages: 1, monthMessages: 1 });
    expect(JSON.stringify(r.json)).not.toMatch(/PRIVATE-USAGE-TEXT/);
  });
});
