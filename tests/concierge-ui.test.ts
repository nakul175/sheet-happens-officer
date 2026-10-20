import { afterEach, describe, expect, it, vi } from "vitest";
import { conciergeApi } from "../src/components/concierge/api";
import { canShowConfirm, choicesActive, freshMessages, handoverComplete, improveError, initialPicks, keptDraft, mergeMessages, offeredRewrite, patchCard, resumeText, undoView } from "../src/components/concierge/logic";
import { PRIVACY_SENTENCE, type Card, type Message } from "../src/components/concierge/types";

const card = (o: Partial<Card> = {}): Card => ({ id: "c1", status: "PENDING", title: "Move 'Budget'", changes: [], canConfirm: true, ...o });
const msg = (o: Partial<Message> = {}): Message => ({ id: "m1", role: "ASSISTANT", createdAt: "2026-10-17T00:00:00Z", kind: "text", text: "hi", ...o });

function mockFetch(status: number, body: unknown) {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe("concierge client matches the contract routes", () => {
  it("calls each route with the contract method, path and body", async () => {
    const f = mockFetch(200, {});
    await conciergeApi.state();
    await conciergeApi.setPrefs({ hidden: true });
    await conciergeApi.send("hello");
    await conciergeApi.clear();
    await conciergeApi.quick("overdue");
    await conciergeApi.improve("x");
    await conciergeApi.choose("m1", "none");
    await conciergeApi.confirm("c1", [{ taskId: "t", assigneeId: "u" }]);
    await conciergeApi.confirm("c1");
    await conciergeApi.cancel("c1");
    await conciergeApi.undo("c1");
    const calls = f.mock.calls.map((c) => { const [url, init] = c as unknown as [string, RequestInit]; return [init?.method, url, init?.body]; });
    expect(calls).toEqual([
      ["GET", "/api/concierge/state", undefined],
      ["PATCH", "/api/concierge/preferences", JSON.stringify({ hidden: true })],
      ["POST", "/api/concierge/messages", JSON.stringify({ text: "hello" })],
      ["DELETE", "/api/concierge/messages", undefined],
      ["POST", "/api/concierge/quick/overdue", "{}"],
      ["POST", "/api/concierge/improve", JSON.stringify({ text: "x" })],
      ["POST", "/api/concierge/choices/m1", JSON.stringify({ choiceId: "none" })],
      ["POST", "/api/concierge/cards/c1/confirm", JSON.stringify({ handover: [{ taskId: "t", assigneeId: "u" }] })],
      ["POST", "/api/concierge/cards/c1/confirm", "{}"],
      ["POST", "/api/concierge/cards/c1/cancel", "{}"],
      ["POST", "/api/concierge/cards/c1/undo", "{}"],
    ]);
  });
  it("qa:TC missing AC1: parses a successful improve response as the rewritten text", async () => {
    const original = "Move the budget task to Monday";
    const rewrite = "Please move the budget task to Monday.";
    mockFetch(200, { improved: rewrite });
    const r = await conciergeApi.improve(original);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.data.improved).toBe(rewrite);
    const offer = offeredRewrite(original, r.data.improved);
    expect(offer).toEqual({ original, draft: rewrite });
    // Use it leaves that draft in place. Keep mine restores the typed text exactly.
    expect(offer?.draft).toBe(rewrite);
    expect(keptDraft(offer!.original)).toBe(original);
  });
  it("qa:TC missing AC4: a 429 or 503 improve response is a visible error and offers no rewrite", async () => {
    const original = "Move the budget task to Monday";
    mockFetch(503, { error: "The concierge cannot reach its language service right now. The rest of the app works normally; try again in a minute." });
    const down = await conciergeApi.improve(original);
    expect(down.ok).toBe(false);
    expect(down.status).toBe(503);
    expect(improveError(down.error)).toMatch(/language service/);
    expect(offeredRewrite(original, down.ok ? down.data.improved : null)).toBeNull();

    mockFetch(429, { error: "You have used your 200 concierge messages for this week." });
    const capped = await conciergeApi.improve(original);
    expect(capped.ok).toBe(false);
    expect(capped.status).toBe(429);
    expect(improveError(capped.error)).toMatch(/200 concierge messages/);
    expect(offeredRewrite(original, null)).toBeNull();
    expect(keptDraft(original)).toBe(original);
  });
  it("qa:TC missing AC1: an improve result that only repeats the typed text offers no rewrite", async () => {
    // The server now answers an empty or echoed reply with a 502; this guards against an older server sending the text back.
    const original = "Move the budget task to Monday";
    mockFetch(200, { improved: original });
    const r = await conciergeApi.improve(original);
    expect(r.ok).toBe(true);
    expect(offeredRewrite(original, r.ok ? r.data.improved : null)).toBeNull();
    expect(offeredRewrite(`  ${original}\n`, original)).toBeNull();
    expect(offeredRewrite(original, "Move the Budget task to Monday 20 October.")).toEqual({ original, draft: "Move the Budget task to Monday 20 October." });
  });
  it.each([
    "move the budget task to monday",
    "Move the budget task to Monday.",
    "\u201cMove the budget task to Monday\u201d",
  ])("qa:TC missing APL-2871 AC1 v1.1: offeredRewrite offers nothing for the near-copy %j and the text is unchanged", (reply) => {
    const original = "Move the budget task to Monday";
    expect(offeredRewrite(original, reply)).toBeNull();
    expect(keptDraft(original)).toBe(original);
  });
  it("qa:TC missing APL-2871 AC2: offeredRewrite offers a real rewrite as the Suggested rewrite draft", () => {
    const original = "Move the budget task to Monday";
    expect(offeredRewrite(original, "Move the budget review task to Monday 9:00")).toEqual({ original, draft: "Move the budget review task to Monday 9:00" });
  });
  it("surfaces a 409 stale confirm with the fresh card message", async () => {
    mockFetch(409, { error: "stale", messages: [msg({ id: "m2", kind: "card", card: card({ id: "c2" }) })] });
    const r = await conciergeApi.confirm("c1");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(freshMessages(r.data)[0].card?.id).toBe("c2");
  });
});

describe("thread logic", () => {
  it("merges by id and appends new messages", () => {
    const out = mergeMessages([msg({ id: "a" }), msg({ id: "b", text: "old" })], [msg({ id: "b", text: "new" }), msg({ id: "c" })]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(out[1].text).toBe("new");
  });
  it("patches a card in place", () => {
    const out = patchCard([msg({ kind: "card", card: card() })], card({ status: "CONFIRMED" }));
    expect(out[0].card?.status).toBe("CONFIRMED");
  });
  it("choices are tappable only while unanswered and latest", () => {
    const ch = msg({ id: "q", kind: "choices", choices: [{ id: "a", label: "A" }] });
    expect(choicesActive([ch], ch)).toBe(true);
    expect(choicesActive([ch, msg({ id: "n" })], ch)).toBe(false);
    expect(choicesActive([{ ...ch, choiceAnswered: "a" }], { ...ch, choiceAnswered: "a" })).toBe(false);
  });
  it("member removal needs every handover filled", () => {
    const c = card({ irreversible: true, handoverOptions: [{ id: "u1", name: "Asha" }], handover: [{ taskId: "t1", taskTitle: "A" }, { taskId: "t2", taskTitle: "B", assigneeId: "u1" }] });
    expect(initialPicks(c)).toEqual({ t2: "u1" });
    expect(handoverComplete(c, initialPicks(c))).toBe(false);
    expect(handoverComplete(c, { t1: "u1", t2: "u1" })).toBe(true);
  });
  it("a blocked card has no Confirm", () => {
    expect(canShowConfirm(card())).toBe(true);
    expect(canShowConfirm(card({ canConfirm: false, blockedReason: "You are a Viewer" }))).toBe(false);
    expect(canShowConfirm(card({ status: "STALE" }))).toBe(false);
  });
  it("undo states", () => {
    const base = { cardId: "c", summary: [] };
    expect(undoView({ ...base, undoable: true })).toBe("button");
    expect(undoView({ ...base, undoable: true, undoExpired: true })).toBe("expired");
    expect(undoView({ ...base, undoable: false })).toBe("none");
    expect(undoView({ ...base, undoable: true, undoneAt: "x" })).toBe("undone");
  });
  it("formats the resume date in India time", () => {
    expect(resumeText({ code: "MONTH_CAP", message: "m", resumesAt: "2026-10-31T18:30:00Z" })).toBe("1 November 2026");
    expect(resumeText({ code: "PROVIDER_DOWN", message: "m" })).toBeNull();
  });
  it("privacy sentence is exact", () => {
    expect(PRIVACY_SENTENCE).toBe("Your chats are not visible anywhere in the app to anyone else, and are deleted from the app after 90 days.");
  });
});
