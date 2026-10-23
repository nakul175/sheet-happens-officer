// SHO-2693 w148: the rule is about the turn's state, not the request's wording.
//
// w107 widened the keyword gate at engine.ts:133 (`/\bassign\b/` -> `/\b(?:re)?assign\b/`). w126 then ran eight phrasings
// against a model that answers "Done - I reassigned it for you." without calling a single tool, and two of them still
// relayed that sentence: `reassigning would be good` (no word boundary after the stem) and `unassign it` (none before
// it). Any further widening misses the next inflection, because the gate reads the REQUEST and the lie is about the
// TURN. The invariant this file pins: a turn with no card, no proposal and no result wrote nothing, so the assistant
// must not repeat a sentence claiming it wrote something - whatever words the person used to ask.
//
//   w148/MATRIX <phrase>   all eight w126 phrasings: no relayed write claim, no card/proposal/result, assignee unchanged
//   w148/READ              "Which tasks are assigned to me?" keeps the model's answer          (must stay green)
//   w148/CARD              a card-backed assignment still returns its card                     (must stay green)
//   w148/PROPOSAL          "Reassign it to me." with a proposal still returns the card         (must stay green)
//   w148/RESULT            a turn with a real result keeps its text                            (must stay green)
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w148`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

/** A ZZ-TEST task assigned to the lead: the app never stores "nobody", so "assigned to somebody" is the fixture's meaning. */
async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w148 Lead ${RUN}-${n}`, `nakul17+zz-w148-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w148 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} w148-unassigned`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;
const assigneeOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).assigneeId;

/** The state a turn with no card must leave behind, counted rather than described. */
async function stateOf(lead: Account, projectId: string) {
  const [cards, proposals, results, tasks] = await Promise.all([
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"card"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"proposal"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"result"' } } }),
    db.task.count({ where: { projectId } }),
  ]);
  return { cards, proposals, results, tasks };
}

/** What w126's model says on every step of every case: a completed write, with no tool call behind it. */
const CLAIM = "Done - I reassigned it for you.";

/** The eight phrasings from w126's matrix, verbatim. The third and sixth are the two w126 named as still lying. */
const MATRIX = [
  "Reassign all of them to me.",
  "Can you reassign it?",
  "reassigning would be good",
  "REASSIGN IT.",
  "re-assign it",
  "unassign it",
  "Assign it.",
  "Reassign it.",
];

/** Statements with the same truth value as the matrix sentence, said with less confidence. Question 5 of the packet. */

/** Green means the person is told something true: a question, or that nothing changed. Never the model's claim. */
function expectTruthful(reply: Message) {
  expect(reply.text, `relayed the model's write claim: ${reply.text}`).not.toBe(CLAIM);
  expect(reply.text, `the sentence asserts a write: ${reply.text}`).not.toMatch(/reassign/i);
  const truthful = /\?/.test(reply.text) || /nothing (?:has |was )?changed/i.test(reply.text);
  expect(truthful, `neither a question nor a truthful "nothing changed": ${reply.text}`).toBe(true);
}


describe("w148 SHO-2693: a turn that wrote nothing must not say it wrote something", () => {
  useFakeModel();

  for (const phrase of MATRIX) {
    it(`w148/MATRIX ${JSON.stringify(phrase)}: no write claim is relayed and nothing is written`, async () => {
      const { lead, projectId, taskId } = await fixture();
      const before = await stateOf(lead, projectId);
      expect(before).toEqual({ cards: 0, proposals: 0, results: 0, tasks: 1 }); // the fixture's own task, and nothing else
      script(() => [say(CLAIM)]); // no tool_use: no find, no propose, no card
      const { messages } = await sendMessage(actor(lead), phrase);
      const reply = lastAssistant(messages);
      expect(reply.kind).not.toBe("card");
      expectTruthful(reply);
      expect(await stateOf(lead, projectId)).toEqual(before);
      expect(await assigneeOf(taskId)).toBe(lead.id);
    });
  }

  // Question 5 of the packet: is a hedge relayed, and should it be? A hedge still tells the person the change is done;
  // the person acts on it. So the rule is the same as for the flat claim: not relayed. "I think that is done" is
  // caught by the "that is done" shape; "I believe it went through" names no verb in the change family and is the
  // residual this detector cannot see (see W148-REPORT.md).
  it("w148/HEDGE 'I think that is done.': hedging the claim does not make it true, so it is not relayed", async () => {
    const { lead, projectId } = await fixture();
    const before = await stateOf(lead, projectId);
    script(() => [say("I think that is done.")]);
    const { messages } = await sendMessage(actor(lead), "Reassign it.");
    expectTruthful(lastAssistant(messages));
    expect(await stateOf(lead, projectId)).toEqual(before);
  });

  it("w148/HEDGE-RESIDUAL 'I believe it went through.': relayed, but inside the server's frame so it reads as no change", async () => {
    // w148 recorded this as a residual the detector cannot see, because it names no verb from the change family and no
    // completion word. w164 closes it without touching the word list: the sentence is still relayed, and the person
    // reads the server's own statement of the state first, so it cannot be mistaken for a report of a write.
    const { lead } = await fixture();
    script(() => [say("I believe it went through.")]);
    const { messages } = await sendMessage(actor(lead), "Sort it out."); // no assign wording, so no who question
    expect(lastAssistant(messages).text).toBe("Nothing has changed - I have not carried anything out here. I believe it went through.");
  });

  it("w148/READ: 'Which tasks are assigned to me?' keeps the model's answer", async () => {
    const { lead } = await fixture();
    script(() => [say("Here are the tasks assigned to you.")]);
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("text");
    expect(reply.text).toBe("Nothing has changed - I have not carried anything out here. Here are the tasks assigned to you.");
  });

  it("w148/CARD: a card-backed assignment still returns its card", async () => {
    const { lead, taskId, title } = await fixture();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: "me" }] })],
    );
    const { messages } = await sendMessage(actor(lead), `Assign "${title}" to me.`);
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("card");
    expect(reply.card?.status).toBe("PENDING");
    expect(await assigneeOf(taskId)).toBe(lead.id); // PENDING: reading the card does not apply it
  });

  it("w148/PROPOSAL: 'Reassign it to me.' with a proposal still returns the card", async () => {
    const { lead, taskId, title } = await fixture();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: "me" }] })],
    );
    const { messages } = await sendMessage(actor(lead), "Reassign it to me.");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("card");
    expect(reply.card?.status).toBe("PENDING");
  });

  it("w148/RESULT: a turn with a real result keeps its text", async () => {
    const { lead, taskId, title } = await fixture();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: "me" }] })],
    );
    const asked = await sendMessage(actor(lead), `Assign "${title}" to me.`);
    const card = lastAssistant(asked.messages);
    expect(card.kind).toBe("card");
    // Confirming is a different turn, and the only one that writes; its text comes from the server's own summary.
    const done = await lead.c.post(`/api/concierge/cards/${card.id}/confirm`, {});
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const result = lastAssistant(done.json.messages as Message[]);
    expect(result.kind).toBe("result");
    expect(result.text.startsWith("Done.")).toBe(true);
  });
});
