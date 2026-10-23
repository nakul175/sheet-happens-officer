// SHO-2693 w164: independent review of w148's claim detector, and the structural half it cannot cover.
//
// w148 got the mechanism right (a STATE check at the reply site, engine.ts:208) but the load-bearing predicate is still
// `claimsWrite(text)` - a blacklist over a verb FAMILY (claims.ts:15-42). A sentence does not have to name the change
// verb to claim the change. These eight sentences are the packet's, said by a model that calls no tool at all:
//
//   w164/NOUNVERB <sentence>  a turn that wrote nothing must not relay the model's sentence unqualified
//   w164/PRESERVED-*          the four cases the packet says must survive
//
// "Unqualified" is the assertion, not "does not contain a bad word": the reply must carry the server's own sentence
// about the state of the world. That is what makes the property closed - it stops depending on the vocabulary.
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w164`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w164 Lead ${RUN}-${n}`, `nakul17+zz-w164-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w164 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} w164-task`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;
const assigneeOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).assigneeId;

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

/** The server's own sentence, authored in engine.ts, that says the world is unchanged. */
const FRAME = /^Nothing has changed - I have not carried anything out here\. /;

/** Green means the person cannot read the model's sentence as an outcome: a server sentence, or a server question. */
function expectQualified(reply: Message, sentence: string) {
  const qualified = FRAME.test(reply.text) || /\?$/.test(reply.text.trim()) || /nothing (?:has |was )?changed/i.test(reply.text);
  expect(
    qualified,
    `relayed the model's sentence UNQUALIFIED, so it reads as an outcome: ${JSON.stringify(reply.text)} (model said ${JSON.stringify(sentence)})`,
  ).toBe(true);
}

/** Sentences that claim a finished write without using a word in claims.ts's verb family. The packet's eight. */
const NOUNVERB = [
  "Done.",
  "All set - it's moved over.",
  "Reassigned ✓",
  "I've handled that for you.",
  "That's taken care of.",
  "It is now assigned to Sam.",
  "Updated.",
  "Your task has a new owner.",
];


describe("w164 SHO-2693: the claim detector's synonym hole, and the closed fix", () => {
  useFakeModel();

  for (const sentence of NOUNVERB) {
    it(`w164/NOUNVERB ${JSON.stringify(sentence)}: nothing is written, so the reply must not read as an outcome`, async () => {
      const { lead, projectId, taskId } = await fixture();
      const before = await stateOf(lead, projectId);
      script(() => [say(sentence)]); // no tool_use: no find, no propose, no card, no result
      // No assign wording, so the who-question at engine.ts:200 cannot mask the detector: this is the bare relay path.
      const { messages } = await sendMessage(actor(lead), "Sort it out.");
      const reply = lastAssistant(messages);
      const after = await stateOf(lead, projectId);
      console.log(`w164 ${JSON.stringify(sentence)} -> reply=${JSON.stringify(reply.text)} kind=${reply.kind} wrote=${JSON.stringify(after !== before ? after : "nothing")}`);
      expect(reply.kind).not.toBe("card");
      expect(after).toEqual(before); // the state is truthful: nothing was written
      expect(await assigneeOf(taskId)).toBe(lead.id);
      expectQualified(reply, sentence);
    });
  }

  it("w164/PRESERVED-READ: a read question keeps its answer (inside the server's frame)", async () => {
    const { lead } = await fixture();
    script(() => [say("Here are the tasks assigned to you.")]);
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("text");
    expect(reply.text).toContain("Here are the tasks assigned to you.");
    expect(reply.text).toBe("Nothing has changed - I have not carried anything out here. Here are the tasks assigned to you.");
  });

  it("w164/PRESERVED-CARD: a card-backed assignment still returns its card", async () => {
    const { lead, taskId, title } = await fixture();
    script(
      () => [tu("find_tasks", { text: title })],
      () => [tu("propose_changes", { changes: [{ action: "assign_task", task_id: taskId, person_id: "me" }] })],
    );
    const { messages } = await sendMessage(actor(lead), `Assign "${title}" to me.`);
    const reply = lastAssistant(messages);
    expect(reply.kind).toBe("card");
    expect(reply.card?.status).toBe("PENDING");
    expect(reply.text).not.toMatch(FRAME); // a card is an outcome the server can stand behind: no frame
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  it("w164/PRESERVED-RESULT: a turn with a real result keeps its text", async () => {
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
    expect(result.text.startsWith("Done.")).toBe(true); // the server's own summary of a write that happened
    expect(result.text).not.toMatch(FRAME);
  });

  it("w164/MASKED: with assign wording in the request every one of the eight is pre-empted by the who-question", async () => {
    // States the boundary honestly: the who-question at engine.ts:200 is what protected w148's matrix, not the
    // detector. It only fires on the word "assign", so it cannot be the property either.
    for (const sentence of NOUNVERB) {
      const { lead } = await fixture();
      script(() => [say(sentence)]);
      const { messages } = await sendMessage(actor(lead), "Reassign it.");
      const reply = lastAssistant(messages);
      expect(reply.text, `for ${JSON.stringify(sentence)}`).toMatch(/Who should I assign it to/);
    }
  });
});
