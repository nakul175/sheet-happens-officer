// SHO-2693 w183: the structural version w164 named and did not ship. When a turn produced no card, no proposal and no
// result, the person must not receive model prose that can be read as an outcome - and the guarantee must not depend
// on the wording of that prose.
//
// The mechanism is a state check, not a pattern: `turn.reads.records` is incremented only by tools.ts when a read tool
// returned rows. Zero records means nothing was read and nothing was written, so the server answers in its own words
// and no sentence of the model's reaches the person at all. The assertion below is therefore "the model's sentence is
// not in the reply", NOT "the reply contains a denial": a framed relay passes the latter (that is w164's residual) and
// fails this one. That is how these tests tell a relaying implementation from a non-relaying one.
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w183`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w183 Lead ${RUN}-${n}`, `nakul17+zz-w183-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w183 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} w183-task`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;
const assigneeOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).assigneeId;

/** The server's own sentence for this state (engine.ts NOTHING_CHANGED): it says nothing changed and what is missing. */
const NOTHING_CHANGED =
  "Nothing has changed. I cannot change anything without a card you confirm, so tell me which task should change and how, and I will show you the card.";

/** Everything a write would leave behind. On a turn with no card, all four must be unchanged. */
async function stateOf(lead: Account, projectId: string) {
  const [cards, proposals, results, tasks] = await Promise.all([
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"card"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"proposal"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"result"' } } }),
    db.task.count({ where: { projectId } }),
  ]);
  return { cards, proposals, results, tasks };
}

/**
 * W164's residual set, quoted from W164-REPORT.md, plus paraphrases that appear on no list anywhere. The last four are
 * the point of the structural fix: no author has ever put them in a blacklist, and none is needed.
 */
const OUTCOME_SENTENCES = [
  "Done.", // w164 §residual: a bare completion word
  "I've handled that for you.", // w164 §residual: NOUNVERB, relayed unqualified on a zero-write turn
  "That's taken care of.", // w164 §residual
  "Your task has a new owner.", // w164 §residual
  "I believe it went through.", // w164 §residual: the hedge w148 recorded and could not see
  "Sorted.", // w164's predicted next synonym
  "It's in Sam's hands now.", // never listed anywhere
  "Consider it moved.", // never listed anywhere
  "You're all set now.", // never listed anywhere
];


describe("w183 SHO-2693: no model prose at all on a turn that read nothing and wrote nothing", () => {
  useFakeModel();

  for (const sentence of OUTCOME_SENTENCES) {
    it(`w183/NOT-RELAYED ${JSON.stringify(sentence)}: the sentence is absent, not framed`, async () => {
      const { lead, projectId, taskId } = await fixture();
      const before = await stateOf(lead, projectId);
      script(() => [say(sentence)]); // no tool_use at all: no read, no propose, no card
      const { messages } = await sendMessage(actor(lead), "Sort it out."); // no assign wording: the bare relay path
      const reply = lastAssistant(messages);
      console.log(`w183 ${JSON.stringify(sentence)} -> reply=${JSON.stringify(reply.text)} kind=${reply.kind}`);
      expect(reply.kind).not.toBe("card");
      expect(await stateOf(lead, projectId)).toEqual(before); // state truthful: nothing written
      expect(await assigneeOf(taskId)).toBe(lead.id);
      // The load-bearing assertion. A framed relay ("Nothing has changed - ... I've handled that for you.") satisfies
      // every word-list test in this repo and fails this line.
      expect(reply.text, `relayed the model's sentence: ${reply.text}`).not.toContain(sentence);
      expect(reply.text).toBe(NOTHING_CHANGED); // and the person is told the state in the server's own words
    });
  }

  it("w183/NO-EVIDENCE: an answer to a read is not relayed either when the model fetched nothing", async () => {
    // The cost of closure, stated as a test so no one reads the old behaviour back in by accident: the server cannot
    // tell "Here are the tasks assigned to you." from "I've handled that for you." once neither sentence has data
    // behind it, so neither is relayed. A read that really read keeps its answer (w183/PRESERVED-READ below).
    const { lead } = await fixture();
    script(() => [say("Here are the tasks assigned to you.")]);
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    expect(reply.text).not.toContain("Here are the tasks assigned to you.");
    expect(reply.text).toBe(NOTHING_CHANGED);
  });

  it("w183/PRESERVED-READ: a read that fetched rows keeps the model's answer, unframed", async () => {
    const { lead } = await fixture();
    script(
      () => [tu("my_tasks", { filter: "all_open" })], // records > 0: the answer is grounded in rows the tools returned
      () => [say("Here are the tasks assigned to you.")],
    );
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("answer");
    expect(reply.text).toBe("Here are the tasks assigned to you."); // relayed, byte-exact, with no server frame
    expect(reply.text).not.toMatch(/Nothing has changed/);
  });

  it("w183/PRESERVED-CARD: a card-backed assignment still returns its card", async () => {
    const { lead, taskId, title } = await fixture();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: "me" }] })],
    );
    const { messages } = await sendMessage(actor(lead), `Assign "${title}" to me.`);
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("card");
    expect(reply.card?.status).toBe("PENDING");
    expect(reply.text).not.toMatch(/Nothing has changed/); // a card is an outcome the server can stand behind
    expect(await assigneeOf(taskId)).toBe(lead.id); // PENDING: reading the card does not apply it
  });

  it("w183/PRESERVED-RESULT: a turn with a real result keeps its text", async () => {
    const { lead, taskId, title } = await fixture();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: "me" }] })],
    );
    const asked = await sendMessage(actor(lead), `Assign "${title}" to me.`);
    const card = lastAssistant(asked.messages);
    expect(card.kind).toBe("card");
    const done = await lead.c.post(`/api/concierge/cards/${card.id}/confirm`, {});
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const result = lastAssistant(done.json.messages as Message[]);
    expect(result.kind).toBe("result");
    expect(result.text.startsWith("Done.")).toBe(true); // the server's own summary of a write that DID happen
    expect(result.text).not.toMatch(/Nothing has changed/);
  });

  it("w183/PRESERVED-WHO: a request to assign with no person still asks who", async () => {
    const { lead, projectId } = await fixture();
    const before = await stateOf(lead, projectId);
    script(() => [say("Reassigned ✓")]); // the model claims it; the server does not care, it knows who is missing
    const { messages } = await sendMessage(actor(lead), "Reassign it.");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("choices");
    expect(reply.text).toMatch(/Who should I assign it to/);
    expect(reply.text).not.toContain("Reassigned");
    expect(await stateOf(lead, projectId)).toEqual(before);
  });
});
