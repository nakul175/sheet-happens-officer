// SHO-2693 w215: the predicate is not the only defence, and the two branches are defended by different things.
//
// w183 (2a7db1b) deleted claims.ts and gated the reply on `turn.reads.records` alone, so a real read relayed any
// sentence the model wrote next. w199 reproduced two of those (tests/sho-2693-w199.test.ts, RED-READ-THEN-CLAIM and
// RED-IRRELEVANT-READ) and showed both sentences had been blocked before w183. engine.ts:244 now puts the check back
// in front of both branches: `records === 0 || claimsWrite(modelText)`.
//
// What this file proves, so no one mistakes one half for the whole:
//
//   w215/STRUCTURAL-NO-READ  the no-evidence branch refuses a sentence the blacklist does NOT know (asserted here), so
//                            the guarantee is the turn's state, not the vocabulary - the structural half survives.
//   w215/READ-CLAIM          the read-present branch refuses a write claim on a turn that wrote nothing - the half
//                            w183 opened, closed again.
//   w215/RELAY-GENUINE-READ  the read-present branch still relays a genuine answer, byte-exact and unframed, so the
//                            refusal above did not turn every read into "Nothing has changed".
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, tu, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import { claimsWrite } from "../src/lib/concierge/claims";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w215`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w215 Lead ${RUN}-${n}`, `nakul17+zz-w215-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w215 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} w215-task`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;

/** engine.ts:158, verbatim: the server's own sentence for "read nothing, wrote nothing, claimed something". */
const NOTHING_CHANGED =
  "Nothing has changed. I cannot change anything without a card you confirm, so tell me which task should change and how, and I will show you the card.";

/** Everything a write would leave behind, plus the assignee the claim says changed. */
async function stateOf(lead: Account, projectId: string, taskId: string) {
  const [cards, proposals, results, tasks, row] = await Promise.all([
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"card"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"proposal"' } } }),
    db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"result"' } } }),
    db.task.count({ where: { projectId } }),
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
  ]);
  return { cards, proposals, results, tasks, assignee: row.assigneeId };
}

/**
 * An outcome sentence that claimsWrite has never seen: no verb in its stem family, no completion word. If this is
 * refused, the refusal cannot have come from the blacklist.
 */
const NO_VERB_OUTCOME = "Consider it sorted and off your plate.";

describe("w215 SHO-2693: both branches of buildReply are defended", () => {
  useFakeModel();

  it("w215/STRUCTURAL-NO-READ: a sentence the blacklist cannot see is still refused, because nothing was read", async () => {
    expect(claimsWrite(NO_VERB_OUTCOME)).toBe(false); // the predicate misses it: the next synonym hole, by design
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    script(() => [say(NO_VERB_OUTCOME)]); // no tool call: records === 0
    const { messages } = await sendMessage(actor(lead), "Sort it out.");
    const reply = lastAssistant(messages);
    console.log(`w215 STRUCTURAL-NO-READ -> kind=${reply.kind} reply=${JSON.stringify(reply.text)}`);
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
    expect(reply.text).not.toContain(NO_VERB_OUTCOME);
    expect(reply.text).toBe(NOTHING_CHANGED);
  });

  it("w215/READ-CLAIM: a read that returned rows does not license an outcome (w199 RED-READ-THEN-CLAIM)", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    const claim = "Here are your tasks. I've assigned the late one to Sam and it is done now.";
    script(
      () => [tu("my_tasks", { filter: "all_open" })], // records > 0: a real read, which is the whole licence w183 gave
      () => [say(claim)],
    );
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    console.log(`w215 READ-CLAIM -> kind=${reply.kind} reply=${JSON.stringify(reply.text)} state=${JSON.stringify(await stateOf(lead, projectId, taskId))}`);
    expect(await stateOf(lead, projectId, taskId)).toEqual(before); // cards 0, proposals 0, results 0, assignee unchanged
    expect(reply.text).not.toContain("I've assigned the late one to Sam");
    expect(reply.text).toBe(NOTHING_CHANGED);
  });

  it("w215/RELAY-GENUINE-READ: the same read still relays a genuine answer, byte-exact and unframed", async () => {
    const { lead, projectId, taskId } = await fixture();
    const before = await stateOf(lead, projectId, taskId);
    const answer = "Here are the tasks assigned to you. The one due this week is first.";
    script(
      () => [tu("my_tasks", { filter: "all_open" })],
      () => [say(answer)],
    );
    const { messages } = await sendMessage(actor(lead), "Which tasks are assigned to me?");
    const reply = lastAssistant(messages);
    console.log(`w215 RELAY-GENUINE-READ -> kind=${reply.kind} reply=${JSON.stringify(reply.text)}`);
    expect(reply.kind).toBe("answer");
    expect(reply.text).toBe(answer); // relayed: the refusal above is about outcomes, not about prose in general
    expect(reply.text).not.toMatch(/Nothing has changed/);
    expect(await stateOf(lead, projectId, taskId)).toEqual(before);
  });
});
