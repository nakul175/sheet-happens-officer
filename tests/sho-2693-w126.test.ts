// SHO-2693 independent retest (w126) of c73bb8d (w107): the tool-less branch, and the phrasings around the new gate.
//
// c73bb8d widens `asksForAssign` (engine.ts:130) from /\bassign\b/ to /\b(?:re)?assign\b/, so a request that changes an
// assignee, names nobody and produces no tool call comes back as the server's who question instead of the model's prose.
// A model answering "Done - I reassigned it for you." for that turn told the person a write happened that never did
// (AC2: nothing is written either way - the claim was the whole defect).
//
// Written against a tree where the widening is NOT yet applied, so the "reassign" cases below are red until engine.ts:130
// carries /(?:re)?assign\b/; they are green once it does (see W126-REPORT.md §3/§4). The two cases marked STILL-OPEN stay
// red even then: /(?:re)?assign\b/ needs the bare verb, so "-ing" and "un-" spellings still fall through to the prose.
import { afterAll, describe, expect, it } from "vitest";
import { account, cleanupZz, task, zzProject, type Account } from "./helpers";
import { actor, db, say, script, useFakeModel } from "./concierge-helpers";
import { sendMessage } from "../src/lib/concierge/engine";
import type { Message } from "../src/lib/concierge/types";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}w126`;
let seq = 0;
const leads: Account[] = [];
const projectIds: string[] = [];

afterAll(async () => {
  if (leads.length) await cleanupZz(projectIds, leads);
});

/** The sentence a model produces when it believes it already did the work. */
const CLAIM = "Done - I reassigned it for you.";

/** Tells the person the change already happened. The one thing a written-nothing turn must never say. */
const claimsWrite = (text: string) => /\b(done|finished|all set|i have|i've|i just)\b/i.test(text) && /\b(?:re-?)?assign/i.test(text);

async function fixture() {
  const n = seq++;
  const lead = await account(`ZZ-TEST w126 Lead ${RUN}-${n}`, `nakul17+zz-w126-${RUN}-${n}@aplyd.com`);
  leads.push(lead);
  const projectId = await zzProject(lead, `SHO-2693 w126 ${RUN}-${n}`);
  projectIds.push(projectId);
  const title = `ZZ-TEST ${RUN}-${n} reassign-ask`;
  const taskId = await task(lead, projectId, { title, assigneeId: lead.id, dueDate: "2031-03-20" });
  return { lead, projectId, taskId, title };
}

const lastAssistant = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT")!;
const assigneeOf = async (id: string) => (await db.task.findUniqueOrThrow({ where: { id } })).assigneeId;

/** AC2 by rows: no card, no proposal, no result written for this person's thread. */
const stateOf = async (lead: Account) => ({
  cards: await db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"card"' } } }),
  proposals: await db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"proposal"' } } }),
  results: await db.chatMessage.count({ where: { userId: lead.id, content: { contains: '"result"' } } }),
});

describe("w126 SHO-2693: tool-less assign requests must not claim a write", () => {
  useFakeModel();

  it("w126/REASSIGN-IT: 'Reassign it.' with no tool call asks who, and the model's claim is not relayed", async () => {
    const { lead, taskId } = await fixture();
    const before = await stateOf(lead);
    script(() => [say(CLAIM)]);
    const { messages } = await sendMessage(actor(lead), "Reassign it.");
    const reply = lastAssistant(messages);
    expect(reply.text).toMatch(/Who should I assign it to/);
    expect(reply.text).not.toBe(CLAIM);
    expect(await stateOf(lead)).toEqual(before);
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  // Phrasings a real person types for the same request. Same reply required: the server's question, never the claim.
  for (const request of ["Can you reassign it?", "REASSIGN IT.", "re-assign it"]) {
    it(`w126/NEIGHBOUR: '${request}' asks who, and the model's claim is not relayed`, async () => {
      const { lead, taskId } = await fixture();
      script(() => [say(CLAIM)]);
      const { messages } = await sendMessage(actor(lead), request);
      const reply = lastAssistant(messages);
      expect(claimsWrite(reply.text)).toBe(false);
      expect(reply.text).toMatch(/Who should I assign it to/);
      expect(await assigneeOf(taskId)).toBe(lead.id);
    });
  }

  it("w126/TRADE-OFF: 'Reassign all of them to me.' asks who rather than claiming - the cost of the widening", async () => {
    // c73bb8d's accepted trade-off: "me" names a person, but with no tool call nothing resolved it, so the server asks
    // once. That is honesty, not a dead end - the question carries a real "Never mind" option (w90/B2) and the next
    // message may name the person. What it must NOT do is claim the reassignment happened.
    const { lead, taskId } = await fixture();
    script(() => [say(CLAIM)]);
    const { messages } = await sendMessage(actor(lead), "Reassign all of them to me.");
    const reply = lastAssistant(messages);
    expect(claimsWrite(reply.text)).toBe(false);
    expect(reply.text).toMatch(/Who should I assign it to/);
    expect(reply.kind).toBe("choices");
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  it("w126/STILL-OPEN: 'reassigning would be good' still relays the model's claim", async () => {
    // /(?:re)?assign\b/ is the bare verb: the "-ing" form has no word boundary after "assign", so the gate misses it and
    // the model's prose stands. Red on the tree before c73bb8d and red after it - a hole the widening does not close.
    const { lead, taskId } = await fixture();
    script(() => [say(CLAIM)]);
    const { messages } = await sendMessage(actor(lead), "reassigning would be good");
    const reply = lastAssistant(messages);
    expect(claimsWrite(reply.text)).toBe(false);
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });

  it("w126/STILL-OPEN: 'unassign it' still relays the model's claim", async () => {
    // Deliberately out of the widening's scope (w107 §7). The request differs, but the failure mode does not: a
    // sentence saying the change happened, for a turn that wrote nothing. Asserted only as "must not claim".
    const { lead, taskId } = await fixture();
    script(() => [say(CLAIM)]);
    const { messages } = await sendMessage(actor(lead), "unassign it");
    const reply = lastAssistant(messages);
    expect(claimsWrite(reply.text)).toBe(false);
    expect(await assigneeOf(taskId)).toBe(lead.id);
  });
});
